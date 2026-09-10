import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.js';

/**
 * Deployment shape: the server runs as a declaratively-managed system service
 * (NixOS + sops-nix), which imposes two constraints the config-dir-is-writable
 * design did not satisfy:
 *
 *  1. The CONFIG directory is READ-ONLY to the service (it is rendered at
 *     activation into a root-owned 0400 file under /run, because it holds
 *     secrets). Everything the server WRITES must therefore live somewhere
 *     else -- `WHEREVER_STATE_DIR`.
 *  2. NOTHING SECRET may appear in argv. `/proc/<pid>/cmdline` is world-readable,
 *     so `--token <secret>` hands the token to every local user via `ps`.
 *
 * These tests boot the REAL server binary and assert both properties against a
 * live process, plus the invariant that with the new variables UNSET every path
 * is exactly what it was before. No LLM is involved: every endpoint used here
 * (/health, /drafts) is served without an agent.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const serverEntry = process.env.WHEREVER_SERVER_ENTRY ?? path.resolve(serverDir, 'src/index.ts');
const tsxBin = process.env.WHEREVER_TSX_BIN ?? path.resolve(serverDir, 'node_modules/.bin/tsx');

// A read-only directory does not stop root, so the read-only half of this suite
// is meaningless in a root container. Skip rather than pass vacuously.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
// `/proc/<pid>/{cmdline,environ}` is how the "no secret in ps" property is
// asserted, and it exists only on Linux. Skip rather than fail on macOS.
const isLinux = process.platform === 'linux';

// The developer's REAL config dir. Nothing in this suite may read or write it
// (work/protocol/WORK-CONTRACT.md: isolate the shared location AND assert the
// real one is untouched). Snapshotted once up front, checked once at the end.
const REAL_WHEREVER_DIR = path.join(os.homedir(), '.wherever');

function snapshotDir(dir: string): string {
  if (!fs.existsSync(dir)) return 'ABSENT';
  const entries: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        entries.push(`${prefix}${name}/`);
        walk(full, `${prefix}${name}/`);
      } else {
        // Content hash, not mtime: a rewrite with identical bytes is not a leak.
        const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
        entries.push(`${prefix}${name}:${h}`);
      }
    }
  };
  walk(dir, '');
  return entries.join('\n');
}

const realWhereverBefore = snapshotDir(REAL_WHEREVER_DIR);

interface Server {
  port: number;
  pid: number;
  stdout: () => string;
  stop: () => Promise<void>;
}

const running: Server[] = [];
const tmpDirs: string[] = [];

// Backstop for the ABNORMAL exit path, mirroring test/harness.ts. Each server is
// spawned `detached`, so it leads its own process group and does NOT receive the
// terminal's SIGINT: without these hooks, Ctrl-C on this suite leaves servers
// holding ports. afterEach is the normal path; this is the crash path.
const livePids = new Set<number>();
let exitHooksInstalled = false;

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const reap = () => {
    for (const pid of livePids) killGroup(pid, 'SIGKILL');
    livePids.clear();
  };
  process.on('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      reap();
      process.kill(process.pid, sig);
    });
  }
}

afterAll(() => {
  // The second half of the isolation rule: prove we never touched the real one.
  expect(snapshotDir(REAL_WHEREVER_DIR)).toBe(realWhereverBefore);
});

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
  for (const d of tmpDirs.splice(0)) {
    try {
      // Restore write permission first: a deliberately read-only config dir
      // cannot be removed while it is still 0500.
      fs.chmodSync(d, 0o700);
      for (const entry of fs.readdirSync(d)) {
        try {
          fs.chmodSync(path.join(d, entry), 0o700);
        } catch {}
      }
    } catch {}
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

/** Assert a live process's world-readable command line does not carry `secret`. */
function cmdlineOf(pid: number): string {
  return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
}

/**
 * The acceptance sentence is "nothing secret visible in `ps` output", which is a
 * claim about EVERY process, not just the one we spawned: the server runs behind
 * a tsx wrapper here, and in production behind a makeWrapper shell. Scan them
 * all, exactly as an unprivileged user with `ps -ef` would.
 */
function secretVisibleInAnyCmdline(secret: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (cmdlineOf(Number(entry)).includes(secret)) hits.push(entry);
    } catch {
      // process exited between readdir and read, or not ours to read
    }
  }
  return hits;
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wherever-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

/** Boot the real server with an explicit argv + env, and wait for /health. */
async function startServer(opts: {
  args?: string[];
  env?: Record<string, string>;
  scheme?: 'http' | 'https';
}): Promise<Server> {
  const port = await freePort();
  const scheme = opts.scheme ?? 'http';
  const args = [serverEntry, 'start', '--port', String(port), '--host', '127.0.0.1', ...(opts.args ?? [])];

  const child: ChildProcess = spawn(tsxBin, args, {
    cwd: serverDir,
    detached: true,
    env: {
      ...process.env,
      // The ambient shell may be a wherever-managed one carrying PI_REMOTE_*;
      // neutralise every channel so each test's intent holds on its own.
      PI_REMOTE_TOKEN: '',
      PI_REMOTE_HOST: '',
      PI_REMOTE_PORT: '',
      PI_REMOTE_SSL_KEY: '',
      PI_REMOTE_SSL_CERT: '',
      PI_REMOTE_HTTP: '',
      PI_REMOTE_HTTP_LOCALHOST_FALLBACK: '',
      WHEREVER_TOKEN: '',
      WHEREVER_TOKEN_FILE: '',
      WHEREVER_SSL_KEY: '',
      WHEREVER_SSL_CERT: '',
      WHEREVER_STATE_DIR: '',
      PI_CODING_AGENT_DIR: tmpDir('agentdir'),
      // HOME is isolated STRUCTURALLY, not by hoping no test hits a path that
      // uses it. os.homedir() is still the root for isWithinHome(), the
      // searchFolder AGENTS.md write, uploads-dir tilde expansion, and the
      // memonaut indexer child (which writes ~/.local/share/memonaut). Leaving
      // it inherited means one new test touching any of those silently writes
      // into the developer's real home.
      HOME: tmpDir('home'),
      ...(opts.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout?.on('data', (d) => {
    out += String(d);
  });
  child.stderr?.on('data', (d) => {
    out += String(d);
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (exited || child.pid == null) return;
    const pid = child.pid;
    const waitExit = (ms: number) =>
      new Promise<boolean>((resolve) => {
        if (exited) return resolve(true);
        const timer = setTimeout(() => resolve(exited), ms);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    if (await waitExit(5_000)) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
    await waitExit(2_000);
  };

  const server: Server = { port, pid: child.pid!, stdout: () => out, stop };
  running.push(server);
  installExitHooks();
  if (child.pid != null) {
    livePids.add(child.pid);
    child.once('exit', () => livePids.delete(child.pid!));
  }

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) throw new Error(`server exited before becoming healthy:\n${out}`);
    try {
      const r = await fetch(`${scheme}://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${out}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return server;
}

async function api(
  port: number,
  pathname: string,
  init?: { method?: string; body?: unknown; token?: string; scheme?: 'http' | 'https' },
): Promise<{ status: number; body: any }> {
  const qs = init?.token ? `?token=${encodeURIComponent(init.token)}` : '';
  const res = await fetch(`${init?.scheme ?? 'http'}://127.0.0.1:${port}${pathname}${qs}`, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
      : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** A config dir rendered by the deployment: holds config.json, then goes 0500. */
function readOnlyConfigDir(config: unknown = {}): string {
  const dir = tmpDir('roconfig');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  fs.chmodSync(dir, 0o500);
  return dir;
}

describe('read-only config dir + separate state dir', () => {
  it.skipIf(isRoot)(
    'boots with a config dir the running user cannot write, and puts drafts in the state dir',
    async () => {
      const configDir = readOnlyConfigDir({ gitInitDefault: false });
      const stateDir = tmpDir('state');

      // Prove the premise rather than assuming it: the dir really is unwritable.
      expect(() => fs.writeFileSync(path.join(configDir, 'probe'), 'x')).toThrow();

      const server = await startServer({
        args: ['--no-ssl'],
        env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir },
      });

      const saved = await api(server.port, '/drafts', {
        method: 'POST',
        body: { text: 'written against a read-only config dir' },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.drafts).toHaveLength(1);

      // Read back through the API...
      const listed = await api(server.port, '/drafts');
      expect(listed.body.drafts.map((d: any) => d.text)).toEqual([
        'written against a read-only config dir',
      ]);

      // ...and on disk, in the STATE dir, with nothing added to the config dir.
      const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, 'drafts.json'), 'utf8'));
      expect(onDisk.drafts[0].text).toBe('written against a read-only config dir');
      expect(fs.readdirSync(configDir)).toEqual(['config.json']);
    },
    60_000,
  );

  it.skipIf(isRoot)(
    'still READS its config from the read-only config dir',
    async () => {
      // A distinctive, observable config value: downloads disabled -> 403.
      const configDir = readOnlyConfigDir({ downloads: { enabled: false } });
      const stateDir = tmpDir('state');
      const server = await startServer({
        args: ['--no-ssl'],
        env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir },
      });

      const res = await fetch(
        `http://127.0.0.1:${server.port}/session/download?sessionId=nope&path=${encodeURIComponent('/etc/hostname')}`,
      );
      // 403 proves the rendered config.json was actually read; without it the
      // download feature defaults to enabled and this would be a 404.
      expect(res.status).toBe(403);
    },
    60_000,
  );

  it('defaults the state dir to the config dir when WHEREVER_STATE_DIR is unset', async () => {
    const configDir = tmpDir('config');
    const server = await startServer({
      args: ['--no-ssl'],
      env: { WHEREVER_CONFIG_DIR: configDir },
    });
    await api(server.port, '/drafts', { method: 'POST', body: { text: 'legacy layout' } });

    // Exactly where it landed before the split existed.
    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, 'drafts.json'), 'utf8'));
    expect(onDisk.drafts[0].text).toBe('legacy layout');
  }, 60_000);
});

describe('token from the environment (nothing secret in argv)', () => {
  const SECRET = 'env-only-super-secret-9f3a2b';

  it('authenticates with WHEREVER_TOKEN and never puts it on the command line', async () => {
    const server = await startServer({
      args: ['--no-ssl'],
      env: {
        WHEREVER_CONFIG_DIR: tmpDir('config'),
        WHEREVER_TOKEN: SECRET,
      },
    });

    // The gate is really on.
    const denied = await api(server.port, '/drafts');
    expect(denied.status).toBe(401);

    const allowed = await api(server.port, '/drafts', { token: SECRET });
    expect(allowed.status).toBe(200);

    // The property that matters on a shared box: `ps` shows nothing, ANYWHERE.
    if (isLinux) {
      expect(cmdlineOf(server.pid)).toContain('--no-ssl'); // reading the right cmdline
      expect(secretVisibleInAnyCmdline(SECRET)).toEqual([]);
    }

    // Nor does the startup banner echo it into the journal.
    expect(server.stdout()).not.toContain(SECRET);
    expect(server.stdout()).toContain('WHEREVER_TOKEN');
  }, 60_000);

  // NOTE: the token is also DELETED from `process.env` once resolved (see
  // parseArgs), so the children this server spawns -- the agent's `!` bash tool
  // and the memonaut indexer, both of which inherit `process.env` -- cannot read
  // it. That is deliberately NOT asserted here: observing it needs a live agent
  // session running a shell command, which belongs in the fake-LLM harness, and
  // a test that merely re-proves "node children inherit env" would assert
  // nothing about our code. `/proc/<pid>/environ` cannot show it either: that is
  // the kernel's snapshot of the ORIGINAL environment block and never changes.

  it('reads the token from WHEREVER_TOKEN_FILE, keeping it out of the environment too', async () => {
    const secretDir = tmpDir('secrets');
    const tokenFile = path.join(secretDir, 'token');
    // The shape a secret manager renders: one file, mode 0400, trailing newline.
    fs.writeFileSync(tokenFile, `${SECRET}\n`, { mode: 0o400 });

    const server = await startServer({
      args: ['--no-ssl'],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config'), WHEREVER_TOKEN_FILE: tokenFile },
    });

    expect((await api(server.port, '/drafts')).status).toBe(401);
    expect((await api(server.port, '/drafts', { token: SECRET })).status).toBe(200);

    const cmdline = fs.readFileSync(`/proc/${server.pid}/cmdline`, 'utf8');
    expect(cmdline).not.toContain(SECRET);
    // Only the PATH is in the environment block, never the secret itself.
    const environ = fs.readFileSync(`/proc/${server.pid}/environ`, 'utf8');
    expect(environ).not.toContain(SECRET);
    expect(environ).toContain(tokenFile);
  }, 60_000);

  it('refuses to start (rather than run unauthenticated) when the token file is missing', async () => {
    // Matched against the SERVER's own message, not the harness's "did not become
    // healthy": any startup crash at all would satisfy the latter.
    await expect(
      startServer({
        args: ['--no-ssl'],
        env: {
          WHEREVER_CONFIG_DIR: tmpDir('config'),
          WHEREVER_TOKEN_FILE: path.join(tmpDir('secrets'), 'never-mounted'),
        },
      }),
    ).rejects.toThrow(/FATAL: WHEREVER_TOKEN_FILE .* could not be read/s);
  }, 60_000);

  it('refuses to start when the token file is present but EMPTY', async () => {
    const secretDir = tmpDir('secrets');
    const tokenFile = path.join(secretDir, 'token');
    fs.writeFileSync(tokenFile, '\n');
    await expect(
      startServer({
        args: ['--no-ssl'],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config'), WHEREVER_TOKEN_FILE: tokenFile },
      }),
    ).rejects.toThrow(/FATAL: WHEREVER_TOKEN_FILE .* is empty/s);
  }, 60_000);

  it('keeps --token working, and it wins over the environment', async () => {
    const server = await startServer({
      args: ['--no-ssl', '--token', 'argv-wins'],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config'), WHEREVER_TOKEN: SECRET },
    });
    expect((await api(server.port, '/drafts', { token: SECRET })).status).toBe(401);
    expect((await api(server.port, '/drafts', { token: 'argv-wins' })).status).toBe(200);
    // The negative control for the whole feature: a flag-supplied token IS in
    // the command line. This is what makes the WHEREVER_TOKEN assertion above
    // mean something rather than being trivially true.
    if (isLinux) expect(secretVisibleInAnyCmdline('argv-wins').length).toBeGreaterThan(0);
  }, 60_000);

  it('still honours the pre-existing PI_REMOTE_TOKEN', async () => {
    const server = await startServer({
      args: ['--no-ssl'],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config'), PI_REMOTE_TOKEN: 'legacy-token' },
    });
    // The negative control matters here: without it this test passes even if
    // PI_REMOTE_TOKEN support is deleted outright, because an unauthenticated
    // server answers 200 to every request including this one.
    expect((await api(server.port, '/drafts')).status).toBe(401);
    expect((await api(server.port, '/drafts', { token: 'wrong' })).status).toBe(401);
    expect((await api(server.port, '/drafts', { token: 'legacy-token' })).status).toBe(200);
  }, 60_000);

  it('takes PI_REMOTE_TOKEN VERBATIM, without trimming (an existing token may have whitespace)', async () => {
    // Regression guard. Trimming the legacy variable would change WHICH string
    // authenticates on an install that already has a padded token (an
    // EnvironmentFile line, a $(cat) of a file with a trailing newline), so
    // every saved client URL would start getting 401 after an upgrade.
    const padded = 'padded-token ';
    const server = await startServer({
      args: ['--no-ssl'],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config'), PI_REMOTE_TOKEN: padded },
    });
    expect((await api(server.port, '/drafts', { token: padded })).status).toBe(200);
    expect((await api(server.port, '/drafts', { token: padded.trim() })).status).toBe(401);
  }, 60_000);

  it('enforces a whitespace-only PI_REMOTE_TOKEN rather than falling open', async () => {
    // Regression guard. `'   '` is truthy, so the pre-existing code enforced it.
    // Trimming it to '' would make the guard fail and hand back NO token, which
    // turns a token-protected server into an open one.
    const server = await startServer({
      args: ['--no-ssl'],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config'), PI_REMOTE_TOKEN: '   ' },
    });
    expect((await api(server.port, '/drafts')).status).toBe(401);
    expect((await api(server.port, '/drafts', { token: '   ' })).status).toBe(200);
  }, 60_000);

  it('lets an explicit `--token ""` suppress the environment, as it always did', async () => {
    // Regression guard. The old `case '--token': token = args[++i]` assigned
    // unconditionally, so an empty or missing flag value OVERWROTE the
    // environment. Resolving on the flag's VALUE rather than its PRESENCE
    // silently flipped that, turning an open server into a gated one.
    const server = await startServer({
      args: ['--no-ssl', '--token', ''],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config'), PI_REMOTE_TOKEN: 'from-env' },
    });
    expect((await api(server.port, '/drafts')).status).toBe(200);
  }, 60_000);

  it('warns loudly when a token variable is set but blank (a secret that did not render)', async () => {
    const server = await startServer({
      args: ['--no-ssl'],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config'), WHEREVER_TOKEN: '   ' },
    });
    // It cannot be fatal (`VAR=` is the normal way to neutralise an inherited
    // variable) but it must not be silent: this is what a half-landed sops
    // render looks like, and the result is an unauthenticated server.
    expect(server.stdout()).toContain('is set but contains only whitespace');
    expect((await api(server.port, '/drafts')).status).toBe(200);
  }, 60_000);

  it('warns loudly when binding a non-loopback address with no authentication', async () => {
    const server = await startServer({
      args: ['--no-ssl', '--host', '0.0.0.0'],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
    });
    expect(server.stdout()).toContain('NO AUTHENTICATION');
  }, 60_000);
});

describe('TLS material at absolute paths', () => {
  /** A throwaway self-signed pair somewhere that is NOT under any home dir. */
  function makePair(): { keyPath: string; certPath: string } {
    const dir = tmpDir('tls');
    const keyPath = path.join(dir, 'server.key');
    const certPath = path.join(dir, 'server.crt');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
       '-sha256', '-days', '2', '-nodes', '-subj', '/CN=localhost'],
      { stdio: 'ignore' },
    );
    // Root-owned-0400 is what sops renders; 0400 as ourselves is the same shape.
    fs.chmodSync(keyPath, 0o400);
    return { keyPath, certPath };
  }

  /** SHA-256 fingerprint of a PEM certificate on disk, as node formats it. */
  function fingerprintOfFile(certPath: string): string {
    const der = execFileSync('openssl', ['x509', '-in', certPath, '-outform', 'DER']);
    const hex = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
    return (hex.match(/../g) ?? []).join(':');
  }

  /** The fingerprint the server ACTUALLY presents on the wire. */
  function servedFingerprint(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(
        { port, host: '127.0.0.1', rejectUnauthorized: false, servername: 'localhost' },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          resolve(cert.fingerprint256);
        },
      );
      socket.on('error', reject);
      socket.setTimeout(10_000, () => reject(new Error('TLS connect timed out')));
    });
  }

  it('serves HTTPS from a key and cert given as absolute paths outside any home dir', async () => {
    const { keyPath, certPath } = makePair();
    expect(keyPath.startsWith(os.homedir())).toBe(false);
    const stateDir = tmpDir('state');

    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const server = await startServer({
        args: ['--ssl-key', keyPath, '--ssl-cert', certPath],
        env: { WHEREVER_CONFIG_DIR: readOnlyConfigDir(), WHEREVER_STATE_DIR: stateDir },
        scheme: 'https',
      });
      const health = await api(server.port, '/health', { scheme: 'https' });
      expect(health.status).toBe(200);
      // A 200 over https proves NOTHING on its own: if the flags were ignored the
      // server would mint its own pair and answer 200 just the same. Pin the
      // certificate actually presented on the wire to the one we supplied.
      expect(await servedFingerprint(server.port)).toBe(fingerprintOfFile(certPath));
      // And the fallback pair was never generated.
      expect(fs.existsSync(path.join(stateDir, 'certs'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }, 60_000);

  it('accepts the same pair through WHEREVER_SSL_KEY / WHEREVER_SSL_CERT', async () => {
    const { keyPath, certPath } = makePair();
    const stateDir = tmpDir('state');
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const server = await startServer({
        env: {
          WHEREVER_CONFIG_DIR: readOnlyConfigDir(),
          WHEREVER_STATE_DIR: stateDir,
          WHEREVER_SSL_KEY: keyPath,
          WHEREVER_SSL_CERT: certPath,
        },
        scheme: 'https',
      });
      expect((await api(server.port, '/health', { scheme: 'https' })).status).toBe(200);
      // Same discriminator: without it this test passes with the env-var support
      // deleted outright, because the self-signed fallback also serves https 200.
      expect(await servedFingerprint(server.port)).toBe(fingerprintOfFile(certPath));
      expect(fs.existsSync(path.join(stateDir, 'certs'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }, 60_000);

  it('REFUSES to start when explicitly-configured TLS material cannot be loaded', async () => {
    // The fail-open this closes: the server used to catch the load error, log it,
    // and serve plain HTTP on the same (possibly 0.0.0.0) address, so clients
    // would send their token in cleartext to a server that looked healthy. That
    // is exactly the "secret has not decrypted yet" race the token-file rule
    // exists for, applied to the TLS half.
    const dir = tmpDir('tls');
    const keyPath = path.join(dir, 'garbage.key');
    const certPath = path.join(dir, 'garbage.crt');
    fs.writeFileSync(keyPath, 'not a key\n');
    fs.writeFileSync(certPath, 'not a cert\n');

    await expect(
      startServer({
        args: ['--ssl-key', keyPath, '--ssl-cert', certPath],
        env: { WHEREVER_CONFIG_DIR: readOnlyConfigDir(), WHEREVER_STATE_DIR: tmpDir('state') },
        scheme: 'https',
      }),
    ).rejects.toThrow(/FATAL: TLS was explicitly configured/s);
  }, 60_000);

  it('expands ~ in the SSL paths, which a systemd Environment= line would not', async () => {
    // docs/deployment-tunnet-https.md shows `WHEREVER_SSL_KEY=~/...`. In bash the
    // shell expands that; in a systemd Environment= line or an EnvironmentFile it
    // is taken literally, the read fails, and (before the fatal above) the server
    // quietly downgraded to HTTP.
    const home = tmpDir('home-tls');
    fs.mkdirSync(path.join(home, 'certs'), { recursive: true });
    const keyPath = path.join(home, 'certs', 'k.pem');
    const certPath = path.join(home, 'certs', 'c.pem');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
       '-sha256', '-days', '2', '-nodes', '-subj', '/CN=localhost'],
      { stdio: 'ignore' },
    );

    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const server = await startServer({
        env: {
          HOME: home,
          WHEREVER_CONFIG_DIR: readOnlyConfigDir(),
          WHEREVER_STATE_DIR: tmpDir('state'),
          WHEREVER_SSL_KEY: '~/certs/k.pem',
          WHEREVER_SSL_CERT: '~/certs/c.pem',
        },
        scheme: 'https',
      });
      expect(await servedFingerprint(server.port)).toBe(fingerprintOfFile(certPath));
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }, 60_000);

  it('generates its self-signed pair under the STATE dir, not the real home', async () => {
    const stateDir = tmpDir('state');
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const server = await startServer({
        env: { WHEREVER_CONFIG_DIR: readOnlyConfigDir(), WHEREVER_STATE_DIR: stateDir },
        scheme: 'https',
      });
      expect((await api(server.port, '/health', { scheme: 'https' })).status).toBe(200);
      // The inconsistency this closes: the certs dir used to be built from
      // os.homedir() directly, so an isolated server still wrote into the
      // developer's real ~/.wherever/certs.
      expect(fs.existsSync(path.join(stateDir, 'certs', 'localhost.key'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'certs', 'localhost.crt'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }, 60_000);

  it('warns instead of silently substituting when only one half of the pair is given', async () => {
    const { keyPath } = makePair();
    const stateDir = tmpDir('state');
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const server = await startServer({
        args: ['--ssl-key', keyPath],
        env: { WHEREVER_CONFIG_DIR: readOnlyConfigDir(), WHEREVER_STATE_DIR: stateDir },
        scheme: 'https',
      });
      // Behaviour is unchanged (it falls back to the self-signed pair) but it is
      // no longer SILENT: an operator who forgot --ssl-cert is told.
      expect((await api(server.port, '/health', { scheme: 'https' })).status).toBe(200);
      expect(server.stdout()).toContain('must be given together');
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }, 60_000);
});
