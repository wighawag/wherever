import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Listening on a UNIX SOCKET instead of a TCP port, in the two forms the server
 * accepts:
 *
 *  - `--socket <path>`, where the server creates the socket. It owns clearing a
 *    stale one and setting the mode deliberately rather than inheriting a umask.
 *  - `--socket fd://<n>`, where a supervisor created, bound, chowned and
 *    chmodded the socket and passed it in. Exercised through the real
 *    `systemd-socket-activate`, so LISTEN_FDS/LISTEN_PID and the fd numbering
 *    are the genuine article rather than a mock of them.
 *
 * The property the deployment actually rests on is NEGATIVE: no TCP port is
 * bound. A socket that serves correctly while also quietly opening a port would
 * pass every positive test here, so `tcpPortsListenedBy` is what gives this
 * suite its teeth, and it is asserted against the whole process tree rather
 * than the one pid we spawned.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const serverEntry = process.env.WHEREVER_SERVER_ENTRY ?? path.resolve(serverDir, 'src/index.ts');
const tsxBin = process.env.WHEREVER_TSX_BIN ?? path.resolve(serverDir, 'node_modules/.bin/tsx');

// /proc is how the no-TCP-port property is asserted, and unix socket modes are
// not meaningful on every platform. Skip rather than pass vacuously.
const isLinux = process.platform === 'linux';
const socketActivateBin = ['/run/current-system/sw/bin/systemd-socket-activate', '/usr/bin/systemd-socket-activate', '/bin/systemd-socket-activate'].find(
  (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
);

// The developer's REAL config dir. Nothing here may read or write it
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
  pid: number;
  socketPath: string;
  stdout: () => string;
  stop: () => Promise<void>;
}

const running: Server[] = [];
const tmpDirs: string[] = [];
const strayServers: net.Server[] = [];

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
  expect(snapshotDir(REAL_WHEREVER_DIR)).toBe(realWhereverBefore);
});

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
  for (const s of strayServers.splice(0)) {
    // close() only calls back once every connection is gone, and a probe that
    // was destroyed mid-handshake can keep it waiting. Race it: the point is to
    // free the address, not to observe a graceful shutdown.
    await Promise.race([
      new Promise<void>((resolve) => s.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wherever-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ *
 * Proving the NEGATIVE: that no TCP port is listening anywhere in the
 * server's process tree. Without this, every positive assertion below is
 * satisfied by a server that serves the socket AND opens a port.
 * ------------------------------------------------------------------ */

/** Inode numbers of every socket in TCP_LISTEN state, from /proc/net. */
function listeningTcpInodes(): Set<string> {
  const inodes = new Set<string>();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // st (col 3) is the connection state; 0A is TCP_LISTEN. inode is col 9.
      if (cols.length < 10 || cols[3] !== '0A') continue;
      inodes.add(cols[9]);
    }
  }
  return inodes;
}

function socketInodesOf(pid: number): string[] {
  const out: string[] = [];
  let fds: string[];
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return out;
  }
  for (const fd of fds) {
    try {
      const m = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
      if (m) out.push(m[1]);
    } catch {}
  }
  return out;
}

/** The spawned pid plus every descendant, since tsx may run the server in a child. */
function processTree(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
      const ppid = Number(/^PPid:\s*(\d+)$/m.exec(status)?.[1] ?? -1);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(Number(entry));
    } catch {}
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** Listening-TCP inodes held anywhere in `root`'s process tree. */
function tcpPortsListenedBy(root: number): string[] {
  const listening = listeningTcpInodes();
  const hits: string[] = [];
  for (const pid of processTree(root)) {
    for (const inode of socketInodesOf(pid)) {
      if (listening.has(inode)) hits.push(`pid ${pid} inode ${inode}`);
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */

/** An HTTP request over a unix socket. `fetch` cannot address one. */
function overSocket(
  sockPath: string,
  pathname: string,
  init?: { method?: string; body?: unknown; token?: string },
): Promise<{ status: number; body: any; raw: string }> {
  const qs = init?.token ? `?token=${encodeURIComponent(init.token)}` : '';
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: sockPath,
        path: `${pathname}${qs}`,
        method: init?.method ?? 'GET',
        ...(init?.body !== undefined ? { headers: { 'Content-Type': 'application/json' } } : {}),
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += String(d)));
        res.on('end', () => {
          let body: any = {};
          try {
            body = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body, raw });
        });
      },
    );
    req.on('error', reject);
    if (init?.body !== undefined) req.write(JSON.stringify(init.body));
    req.end();
  });
}

const NEUTRAL_ENV = {
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
  WHEREVER_SOCKET: '',
  WHEREVER_SOCKET_MODE: '',
};

/**
 * Boot the real server on a unix socket and wait for /health.
 *
 * `activate` routes the launch through systemd-socket-activate, which creates
 * and binds the socket itself and passes it as fd 3 with LISTEN_FDS/LISTEN_PID
 * set, i.e. exactly what a `.socket` unit does.
 */
async function startSocketServer(opts: {
  socketPath: string;
  args?: string[];
  env?: Record<string, string>;
  activate?: boolean;
  umask?: number;
  listenPidOverride?: string;
}): Promise<Server> {
  const serverArgs = [serverEntry, 'start', ...(opts.args ?? [])];

  // Under activation the server must be launched WITHOUT an intervening fork,
  // or fd 3 never reaches it. The `tsx` bin used everywhere else in this suite
  // spawns node as a child and sets up its own stdio, so fd 3 in that child is a
  // pipe rather than the socket; `node --import tsx` runs the loader in-process
  // instead, which is also what a real deployment does (it execs node on built
  // JavaScript). Measured, not assumed: with the tsx bin the server correctly
  // refuses with "NOT a socket".
  const inProcess = [process.execPath, '--import', 'tsx', ...serverArgs];
  const target = opts.listenPidOverride
    ? // `sh -c CMD name args...` puts `name` in $0 and the rest in $@, so this
      // re-execs the same command with one variable rewritten and fd 3 intact.
      ['/bin/sh', '-c', `LISTEN_PID=${opts.listenPidOverride} exec "$@"`, 'sh', ...inProcess]
    : inProcess;

  // Everything the server needs told, as one explicit set. It has to be explicit
  // because systemd-socket-activate does NOT inherit the environment (it builds
  // a minimal one, as systemd does) and requires -E per variable. Measured: a
  // WHEREVER_TOKEN exported into its parent never reached the server, which read
  // as "the token is not enforced over a socket" until the cause was found.
  const explicitEnv: Record<string, string> = {
    ...NEUTRAL_ENV,
    PATH: process.env.PATH ?? '',
    PI_CODING_AGENT_DIR: tmpDir('agentdir'),
    HOME: tmpDir('home'),
    ...(opts.env ?? {}),
  };

  const [cmd, argv] = opts.activate
    ? [
        socketActivateBin!,
        [
          '--listen',
          opts.socketPath,
          // Empty values are dropped: with no inherited environment there is
          // nothing for the neutralising blanks to neutralise.
          ...Object.entries(explicitEnv).flatMap(([k, v]) => (v === '' ? [] : ['--setenv', `${k}=${v}`])),
          ...target,
        ],
      ]
    : [tsxBin, serverArgs];

  const child: ChildProcess = spawn(cmd, argv, {
    cwd: serverDir,
    detached: true,
    env: { ...process.env, ...explicitEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(opts.umask !== undefined ? { umask: opts.umask } : {}),
  });

  let out = '';
  child.stdout?.on('data', (d) => (out += String(d)));
  child.stderr?.on('data', (d) => (out += String(d)));

  let exited = false;
  child.once('exit', () => (exited = true));

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
    killGroup(pid, 'SIGTERM');
    if (await waitExit(5_000)) return;
    killGroup(pid, 'SIGKILL');
    await waitExit(2_000);
  };

  const server: Server = { pid: child.pid!, socketPath: opts.socketPath, stdout: () => out, stop };
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
      const r = await overSocket(opts.socketPath, '/health');
      if (r.status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${out}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return server;
}

describe('--socket <path>', () => {
  it('serves over the socket and binds NO TCP port', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');
    const server = await startSocketServer({
      socketPath,
      args: ['--socket', socketPath],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
    });

    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    expect((await overSocket(socketPath, '/health')).status).toBe(200);

    // THE POINT OF THE FEATURE. Every other assertion in this file is also
    // satisfied by a server that serves the socket and opens a port as well.
    if (isLinux) expect(tcpPortsListenedBy(server.pid)).toEqual([]);

    // And it says what it is rather than inventing an address.
    expect(server.stdout()).toContain(`unix:${socketPath}`);
    expect(server.stdout()).not.toMatch(/https?:\/\/127\.0\.0\.1:\d+/);
  }, 60_000);

  it.skipIf(!isLinux)('sets the mode DELIBERATELY, not from the ambient umask', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');
    // A hostile umask: under plain bind() semantics this would strip group
    // access and produce 0600, so an unchanged 0660 proves the mode was set by
    // us rather than inherited. This is the negative control for the whole
    // "deliberate mode" claim.
    await startSocketServer({
      socketPath,
      args: ['--socket', socketPath],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
      umask: 0o077,
    });

    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o660);
  }, 60_000);

  it.skipIf(!isLinux)('honours --socket-mode', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');
    await startSocketServer({
      socketPath,
      args: ['--socket', socketPath, '--socket-mode', '0600'],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
      // A PERMISSIVE umask this time, so 0600 cannot come from the umask either.
      umask: 0o000,
    });

    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
  }, 60_000);

  it('removes a STALE socket file and binds anyway', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');

    // The shape a CRASHED server leaves behind: a socket inode with nothing
    // accepting on it. It has to be made by killing the holder outright, because
    // a graceful `close()` UNLINKS the file and would leave nothing stale at all.
    const corpse = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up')); setInterval(() => {}, 1000);`],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('corpse never bound')), 10_000);
      corpse.stdout?.on('data', (d) => {
        if (String(d).includes('up')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    // SIGKILL: no exit handler runs, so the inode outlives the process.
    process.kill(corpse.pid!, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));

    // Prove the premise: the file really is still there, really is a socket, and
    // really has nobody accepting on it. Without this the test could pass by
    // there being no file at all, which is a different code path entirely.
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    await expect(
      new Promise((resolve, reject) => {
        const c = net.connect(socketPath);
        c.once('connect', () => {
          c.destroy();
          resolve('connected');
        });
        c.once('error', reject);
      }),
    ).rejects.toThrow(/ECONNREFUSED/);

    const server = await startSocketServer({
      socketPath,
      args: ['--socket', socketPath],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
    });
    expect((await overSocket(socketPath, '/health')).status).toBe(200);
    if (isLinux) expect(tcpPortsListenedBy(server.pid)).toEqual([]);
  }, 60_000);

  it('REFUSES to unlink a socket something is still serving', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');

    // A healthy, accepting server on the address. Stealing it would leave this
    // one running and permanently unreachable, which is worse than failing.
    const incumbent = net.createServer((c) => c.destroy());
    strayServers.push(incumbent);
    await new Promise<void>((resolve) => incumbent.listen(socketPath, () => resolve()));

    await expect(
      startSocketServer({
        socketPath,
        args: ['--socket', socketPath],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
      }),
    ).rejects.toThrow(/already being served by another process/s);

    // The incumbent is untouched: same inode, still accepting.
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    expect(incumbent.listening).toBe(true);
  }, 60_000);

  it('REFUSES to unlink a path that is not a socket', async () => {
    const dir = tmpDir('sock');
    const victim = path.join(dir, 'important.db');
    fs.writeFileSync(victim, 'precious');

    await expect(
      startSocketServer({
        socketPath: victim,
        args: ['--socket', victim],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
      }),
    ).rejects.toThrow(/exists and is not a socket/s);

    // A typo in a unit file must not destroy data.
    expect(fs.readFileSync(victim, 'utf8')).toBe('precious');
  }, 60_000);

  it('enforces the token over the socket', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');
    const SECRET = 'socket-token-4f21a';
    await startSocketServer({
      socketPath,
      args: ['--socket', socketPath],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config'), WHEREVER_TOKEN: SECRET },
    });

    // /health is deliberately open (it is the readiness probe); /drafts is gated.
    expect((await overSocket(socketPath, '/drafts')).status).toBe(401);
    expect((await overSocket(socketPath, '/drafts', { token: 'wrong' })).status).toBe(401);
    expect((await overSocket(socketPath, '/drafts', { token: SECRET })).status).toBe(200);
  }, 60_000);

  it('warns about the SOCKET MODE, not about a host, when there is no token', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');
    const server = await startSocketServer({
      socketPath,
      args: ['--socket', socketPath],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
    });

    // A socket is local, so the off-loopback warning would be a lie; but its
    // reach is its file mode, which is frequently widened for a proxy, so the
    // quiet loopback path would be a lie too. It gets its own branch.
    expect(server.stdout()).toContain('NO AUTHENTICATION');
    expect(server.stdout()).toContain('file permissions');
    expect(server.stdout()).toContain('0660');
    expect(server.stdout()).not.toContain('listening on 127.0.0.1');
  }, 60_000);

  it('does not mint a self-signed certificate it has no use for', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');
    const stateDir = tmpDir('state');
    const server = await startSocketServer({
      socketPath,
      args: ['--socket', socketPath],
      env: { WHEREVER_CONFIG_DIR: tmpDir('config'), WHEREVER_STATE_DIR: stateDir },
    });

    // TLS over a unix socket protects nothing and the generated cert is
    // CN=localhost, which a socket cannot match. Minting it also WRITES a
    // keypair, which a read-only-ish deployment should not be doing unasked.
    expect(fs.existsSync(path.join(stateDir, 'certs'))).toBe(false);
    expect(server.stdout()).toContain('serving plain HTTP over the unix socket');
    expect(server.stdout()).not.toContain('FIRST TIME CONNECTING');
  }, 60_000);
});

describe('--socket fd://<n> (systemd socket activation)', () => {
  it.skipIf(!socketActivateBin || !isLinux)(
    'adopts a socket systemd created, bound and chmodded, and binds NO TCP port',
    async () => {
      const dir = tmpDir('sock');
      const socketPath = path.join(dir, 'wherever.sock');
      const server = await startSocketServer({
        socketPath,
        activate: true,
        args: ['--socket', 'fd://3'],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config'), WHEREVER_TOKEN: 'fd-token' },
      });

      expect((await overSocket(socketPath, '/health')).status).toBe(200);
      expect((await overSocket(socketPath, '/drafts')).status).toBe(401);
      expect((await overSocket(socketPath, '/drafts', { token: 'fd-token' })).status).toBe(200);
      expect(tcpPortsListenedBy(server.pid)).toEqual([]);
      expect(server.stdout()).toContain('unix socket on inherited fd 3');
    },
    60_000,
  );

  it('refuses fd://3 when nothing passed a socket', async () => {
    const dir = tmpDir('sock');
    // No activation wrapper, so fd 3 is whatever the shell left: nothing.
    await expect(
      startSocketServer({
        socketPath: path.join(dir, 'wherever.sock'),
        args: ['--socket', 'fd://3'],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
      }),
    ).rejects.toThrow(/is not an open file descriptor|NOT a socket/s);
  }, 60_000);

  it.skipIf(!socketActivateBin || !isLinux)(
    'WARNS but still serves when a forking wrapper leaves LISTEN_PID naming its parent',
    async () => {
      // sd_listen_fds() would report no descriptors at all here. Refusing on
      // that basis would kill a setup whose socket is perfectly intact, so the
      // pid is a warning and the fstat is the real gate. The complementary case
      // (a launcher that loses the fd as well) is covered by the tsx-bin
      // behaviour noted in startSocketServer: there the fstat correctly refuses.
      const dir = tmpDir('sock');
      const socketPath = path.join(dir, 'wherever.sock');
      const server = await startSocketServer({
        socketPath,
        activate: true,
        args: ['--socket', 'fd://3'],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
        // The socket is passed correctly; only the bookkeeping variable is wrong,
        // which is exactly what a wrapper that forks after activation leaves.
        listenPidOverride: '1',
      });

      expect(server.stdout()).toMatch(/LISTEN_PID is 1, not this process/);
      // The point: it warned AND served.
      expect((await overSocket(socketPath, '/health')).status).toBe(200);
      expect(tcpPortsListenedBy(server.pid)).toEqual([]);
    },
    60_000,
  );

  it('refuses an fd outside the range LISTEN_FDS describes', async () => {
    const dir = tmpDir('sock');
    await expect(
      startSocketServer({
        socketPath: path.join(dir, 'wherever.sock'),
        args: ['--socket', 'fd://7'],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config'), LISTEN_FDS: '1' },
      }),
    ).rejects.toThrow(/outside the range systemd passed/s);
  }, 60_000);
});

describe('combinations that are refused rather than silently reinterpreted', () => {
  it('refuses --socket together with --http-localhost-fallback', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');
    // The fallback is a second listener on a TCP port. Keeping it would hand an
    // operator who asked for "no TCP surface" a TCP surface anyway.
    await expect(
      startSocketServer({
        socketPath,
        args: ['--socket', socketPath, '--http-localhost-fallback'],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
      }),
    ).rejects.toThrow(/cannot be combined with --socket/s);
    expect(fs.existsSync(socketPath)).toBe(false);
  }, 60_000);

  it('refuses a relative socket path', async () => {
    await expect(
      startSocketServer({
        socketPath: 'rel.sock',
        args: ['--socket', 'rel.sock'],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
      }),
    ).rejects.toThrow(/must be an absolute path/s);
  }, 60_000);

  it('refuses a --socket-mode that is not an octal mode', async () => {
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'wherever.sock');
    await expect(
      startSocketServer({
        socketPath,
        args: ['--socket', socketPath, '--socket-mode', '0o660'],
        env: { WHEREVER_CONFIG_DIR: tmpDir('config') },
      }),
    ).rejects.toThrow(/is not an octal file mode/s);
  }, 60_000);

  it('still listens on TCP when no socket is asked for', async () => {
    // The control for the whole suite: the default path must be unchanged, and
    // tcpPortsListenedBy must be capable of returning a non-empty list, or every
    // `toEqual([])` above would be trivially true.
    const dir = tmpDir('sock');
    const socketPath = path.join(dir, 'unused.sock');
    const port = 31500 + Math.floor(Math.random() * 400);
    const child = spawn(tsxBin, [serverEntry, 'start', '--no-ssl', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: serverDir,
      detached: true,
      env: { ...process.env, ...NEUTRAL_ENV, WHEREVER_CONFIG_DIR: tmpDir('config'), HOME: tmpDir('home'), PI_CODING_AGENT_DIR: tmpDir('agentdir') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    installExitHooks();
    if (child.pid) livePids.add(child.pid);
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`);
          if (r.ok) break;
        } catch {}
        if (Date.now() > deadline) throw new Error('control server did not become healthy');
        await new Promise((r) => setTimeout(r, 150));
      }
      if (isLinux) expect(tcpPortsListenedBy(child.pid!).length).toBeGreaterThan(0);
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      if (child.pid) {
        killGroup(child.pid, 'SIGKILL');
        livePids.delete(child.pid);
      }
    }
  }, 60_000);
});
