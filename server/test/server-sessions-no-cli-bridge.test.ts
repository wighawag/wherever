import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionPool } from '../src/session-pool.ts';
import { isCliBridgeExtensionPath } from '../src/cli-bridge-extension.ts';

// A server-built session must NEVER host the CLI bridge extension
// (`@wherever-dev/pi`). Since the server started running the extension
// lifecycle for its own sessions, a user whose settings list the bridge (the
// normal install) got the bridge running INSIDE the server: its session_start
// registered the server's own session as a CLI bridge, registerCliSession took
// it over and shut the server agent down, session_shutdown disconnected the
// bridge, unregisterCliSession reloaded the session, and round it went, several
// times a second, aborting every turn with "CLI terminal disconnected".
//
// The bridge here is a real extension FILE inside a package whose package.json
// is named `@wherever-dev/pi`, listed in the temp agent dir's settings.json the
// way `wherever install` lists `npm:@wherever-dev/pi`. Like an old bridge (no
// in-server guard), its session_start "connects back": it calls
// registerCliSession on the pool, and its session_shutdown calls
// unregisterCliSession, which is exactly what the WS round trip does in
// production. A second, ordinary extension lives in a directory whose name
// contains "wherever", so a loose substring filter would wrongly drop it.
//
// No LLM call is made. The pi agent dir, WHEREVER_CONFIG_DIR and
// WHEREVER_STATE_DIR are temp paths, and the real ~/.wherever and ~/.pi are
// checked to be untouched.

const HOOK = Symbol.for('wherever-test.bridge-hook');
const OTHER = Symbol.for('wherever-test.other-extension-events');
type Hook = { start(sessionFile: string, cwd: string): void; shutdown(sessionFile: string): void };
type OtherEvent = { type: string; reason?: string; sessionFile: string };

// Before any SessionPool exists in this process.
const envAtLoad = { ...process.env };

let root: string;
let bridgePkgDir: string;
const savedEnv: Record<string, string | undefined> = {};

// Fingerprint the top level of the real dirs a leak would touch: entry names
// and mtimes, non-recursive (the sessions tree can be huge).
//
// `~/.wherever` is compared strictly (names + mtimes). The `~/.pi` dirs are
// compared by entry NAMES only: a pi running at the same time (the developer's
// own agent) legitimately rewrites auth.json or appends to its session, while a
// leak from this test would ADD a file or a session cwd folder.
function snapshotDir(dir: string, withMtimes: boolean): string {
  try {
    const entries = fs
      .readdirSync(dir)
      .sort()
      .map((name) => {
        if (!withMtimes) return name;
        try {
          return `${name}:${fs.statSync(path.join(dir, name)).mtimeMs}`;
        } catch {
          return `${name}:?`;
        }
      });
    return `${withMtimes ? fs.statSync(dir).mtimeMs : ''}|${entries.join(',')}`;
  } catch {
    return '<absent>';
  }
}
const realDirs: Array<[string, boolean]> = [
  [path.join(os.homedir(), '.wherever'), true],
  [path.join(os.homedir(), '.pi'), false],
  [path.join(os.homedir(), '.pi', 'agent'), false],
  [path.join(os.homedir(), '.pi', 'agent', 'sessions'), false],
];
const snapshotReal = () => realDirs.map(([dir, strict]) => snapshotDir(dir, strict));
let realBefore: string[];

const BRIDGE_SOURCE = `
const HOOK = Symbol.for('wherever-test.bridge-hook');
export default function (pi) {
  pi.on('session_start', (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (file) globalThis[HOOK]?.start(file, ctx.cwd);
  });
  pi.on('session_shutdown', (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (file) globalThis[HOOK]?.shutdown(file);
  });
}
`;

const OTHER_SOURCE = `
const OTHER = Symbol.for('wherever-test.other-extension-events');
export default function (pi) {
  pi.on('session_start', (event, ctx) => {
    (globalThis[OTHER] ??= []).push({ type: event.type, reason: event.reason, sessionFile: ctx.sessionManager.getSessionFile() });
  });
  pi.on('session_shutdown', (event, ctx) => {
    (globalThis[OTHER] ??= []).push({ type: event.type, reason: event.reason, sessionFile: ctx.sessionManager.getSessionFile() });
  });
}
`;

beforeAll(() => {
  realBefore = snapshotReal();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-no-bridge-')));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
    ['WHEREVER_STATE_DIR', 'wherever-state'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR!;

  // The bridge, laid out like the published package: package.json with the
  // pi manifest, code under dist/.
  bridgePkgDir = path.join(root, 'pkgs', 'bridge');
  fs.mkdirSync(path.join(bridgePkgDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(bridgePkgDir, 'package.json'),
    JSON.stringify({ name: '@wherever-dev/pi', version: '0.0.0-test', type: 'module', pi: { extensions: ['./dist/index.js'] } }),
  );
  fs.writeFileSync(path.join(bridgePkgDir, 'dist', 'index.js'), BRIDGE_SOURCE);

  // An unrelated extension whose path and package name both contain "wherever".
  const otherPkgDir = path.join(root, 'pkgs', 'wherever-helper');
  fs.mkdirSync(otherPkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(otherPkgDir, 'package.json'),
    JSON.stringify({ name: 'wherever-helper', version: '0.0.0-test', type: 'module', pi: { extensions: ['./index.js'] } }),
  );
  fs.writeFileSync(path.join(otherPkgDir, 'index.js'), OTHER_SOURCE);

  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: [bridgePkgDir, otherPkgDir] }));
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  delete (globalThis as any)[HOOK];
  delete (globalThis as any)[OTHER];
  // A leak would have written into the real config/state/agent dirs.
  expect(snapshotReal()).toEqual(realBefore);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any)[HOOK];
  (globalThis as any)[OTHER] = [];
});

function freshCwd(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
}

function writeExistingSession(cwd: string): string {
  const dir = path.join(root, 'existing');
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const ts = new Date().toISOString();
  const file = path.join(dir, `${ts.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const line = (obj: unknown) => JSON.stringify(obj) + '\n';
  fs.writeFileSync(
    file,
    line({ type: 'session', version: 3, id, timestamp: ts, cwd }) +
      line({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: ts,
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: Date.now() },
      }),
  );
  return file;
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/**
 * Wire the in-server bridge to the pool the way the WS round trip does, and
 * watch for the loop's symptoms. Bounded, so a regression stops after a few
 * turns of the loop instead of spinning for the rest of the run.
 */
function instrument(pool: SessionPool) {
  const registerSpy = vi.spyOn(pool, 'registerCliSession');
  const sessionErrors: string[] = [];
  pool.onEvent = (_file, event: any) => {
    if (event?.type === 'session_error') sessionErrors.push(String(event.error));
  };
  let budget = 10;
  const fakeCliWs = { send() {}, close() {}, readyState: 1 } as any;
  const hook: Hook = {
    start(sessionFile, cwd) {
      if (budget-- <= 0) return;
      // Like the real bridge: connect asynchronously, the server registers it
      // while streaming (it claims a turn is in flight).
      setTimeout(() => void pool.registerCliSession(sessionFile, cwd, '', fakeCliWs, true), 0);
    },
    shutdown(sessionFile) {
      setTimeout(() => void pool.unregisterCliSession(sessionFile), 0);
    },
  };
  (globalThis as any)[HOOK] = hook;
  const symptoms = () => ({
    cliRegistrations: registerSpy.mock.calls.length,
    disconnectErrors: sessionErrors.filter((e) => e.includes('CLI terminal disconnected')),
  });
  return { registerSpy, sessionErrors, symptoms, rearm: () => (budget = 10) };
}

const otherEvents = (): OtherEvent[] => (globalThis as any)[OTHER] ?? [];

describe('server sessions do not host the CLI bridge extension', () => {
  it('a NEW session never registers itself as a CLI bridge', async () => {
    const pool = new SessionPool(300_000);
    const { symptoms } = instrument(pool);
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(error).toBeUndefined();
    tracked.clients.add('viewer');
    await settle();
    expect(symptoms()).toEqual({ cliRegistrations: 0, disconnectErrors: [] });
    expect(pool.getSession(tracked.sessionFile)?.type).toBe('server');
    await pool.disposeAll();
  }, 30_000);

  it('a LOADED session never registers itself as a CLI bridge', async () => {
    const pool = new SessionPool(300_000);
    const { symptoms } = instrument(pool);
    const cwd = freshCwd();
    const { tracked, error } = await pool.loadSession(writeExistingSession(cwd), cwd);
    expect(error).toBeUndefined();
    tracked.clients.add('viewer');
    await settle();
    expect(symptoms()).toEqual({ cliRegistrations: 0, disconnectErrors: [] });
    expect(pool.getSession(tracked.sessionFile)?.type).toBe('server');
    await pool.disposeAll();
  }, 30_000);

  it('a RELOADED session never registers itself as a CLI bridge', async () => {
    const pool = new SessionPool(300_000);
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(error).toBeUndefined();
    // Instrument only now, so this test is about the reload's build.
    const { symptoms } = instrument(pool);
    tracked.clients.add('viewer');
    const result = await pool.reloadSession(tracked.sessionFile);
    expect(result).toEqual({ started: true });
    await settle();
    expect(symptoms()).toEqual({ cliRegistrations: 0, disconnectErrors: [] });
    expect(pool.getSession(tracked.sessionFile)?.type).toBe('server');
    await pool.disposeAll();
  }, 30_000);

  it('every OTHER extension still gets session_start and session_shutdown (even with "wherever" in its path)', async () => {
    const pool = new SessionPool(300_000);
    instrument(pool);
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(error).toBeUndefined();
    tracked.clients.add('viewer');
    await settle();
    const mine = () => otherEvents().filter((e) => e.sessionFile === tracked.sessionFile);
    expect(mine().map((e) => e.type)).toEqual(['session_start']);

    await pool.reloadSession(tracked.sessionFile);
    expect(mine().map((e) => `${e.type}:${e.reason}`)).toEqual([
      'session_start:startup',
      'session_shutdown:reload',
      'session_start:reload',
    ]);

    await pool.destroySession(tracked.sessionFile, 'manual');
    expect(mine().map((e) => e.type)).toEqual(['session_start', 'session_shutdown', 'session_start', 'session_shutdown']);
  }, 30_000);

  it('a real CLI bridge from OUTSIDE the server still takes over, and the session is handed back for good', async () => {
    const pool = new SessionPool(300_000);
    const { registerSpy, rearm } = instrument(pool);
    const cwd = freshCwd();
    const { tracked, error } = await pool.createNewSession(cwd, undefined, false, false);
    expect(error).toBeUndefined();
    tracked.clients.add('viewer');
    await settle();
    registerSpy.mockClear();
    rearm();

    // The terminal pi connects.
    const cliWs = { send() {}, close() {}, readyState: 1 } as any;
    const result = await pool.registerCliSession(tracked.sessionFile, cwd, '', cliWs);
    expect(result.error).toBeUndefined();
    expect(pool.getSession(tracked.sessionFile)?.type).toBe('cli');
    expect(pool.getSession(tracked.sessionFile)?.clients.has('viewer')).toBe(true);

    // The terminal pi exits: the server agent comes back and STAYS back (an
    // in-server bridge would re-register it as a CLI straight away).
    await pool.unregisterCliSession(tracked.sessionFile);
    await settle();
    const back = pool.getSession(tracked.sessionFile);
    expect(back?.type).toBe('server');
    expect(back?.clients.has('viewer')).toBe(true);
    expect(registerSpy).toHaveBeenCalledTimes(1);
    await pool.disposeAll();
  }, 30_000);
});

describe('bridge identification rule', () => {
  const repoExtension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

  it('matches the real @wherever-dev/pi package source, a packaged copy, and one reached through a symlink', () => {
    // Source only: extension/dist is a gitignored build output CI never builds.
    expect(isCliBridgeExtensionPath(path.join(repoExtension, 'src', 'index.ts'))).toBe(true);
    expect(isCliBridgeExtensionPath(path.join(bridgePkgDir, 'dist', 'index.js'))).toBe(true);
    // pnpm/npm links: node_modules/@wherever-dev/pi -> the real package dir.
    const scope = path.join(root, 'linked', 'node_modules', '@wherever-dev');
    fs.mkdirSync(scope, { recursive: true });
    const link = path.join(scope, 'pi');
    if (!fs.existsSync(link)) fs.symlinkSync(bridgePkgDir, link, 'dir');
    expect(isCliBridgeExtensionPath(path.join(link, 'dist', 'index.js'))).toBe(true);
  });

  it('looks past a name-less package.json (a dual-build dist/package.json) to the real package', () => {
    const pkg = path.join(root, 'pkgs', 'bridge-dual');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@wherever-dev/pi' }));
    fs.writeFileSync(path.join(pkg, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), '');
    expect(isCliBridgeExtensionPath(path.join(pkg, 'dist', 'index.js'))).toBe(true);
  });

  it('does not match on a loose "wherever" substring, inline extensions, or the server itself', () => {
    expect(isCliBridgeExtensionPath(path.join(root, 'pkgs', 'wherever-helper', 'index.js'))).toBe(false);
    expect(isCliBridgeExtensionPath('<inline:wherever>')).toBe(false);
    expect(isCliBridgeExtensionPath(fileURLToPath(new URL('../src/session-pool.ts', import.meta.url)))).toBe(false);
    expect(isCliBridgeExtensionPath(path.join(root, 'does-not-exist', 'wherever-dev', 'pi', 'index.js'))).toBe(false);
  });
});

describe('server process marker (read by the bridge extension)', () => {
  it('a SessionPool marks the process through globalThis, never through the environment', async () => {
    new SessionPool(300_000);
    expect((globalThis as any)[Symbol.for('wherever-dev.server-process')]).toBe(true);
    // Nothing a spawned child (bash tool, !command, terminal pi) could inherit:
    // the only env changes since before any pool existed are this test's own
    // temp-dir overrides.
    const env = { ...process.env };
    for (const key of Object.keys(savedEnv)) delete env[key];
    const baseline = { ...envAtLoad };
    for (const key of Object.keys(savedEnv)) delete baseline[key];
    expect(env).toEqual(baseline);
    const { execFileSync } = await import('node:child_process');
    const childSees = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(globalThis[Symbol.for("wherever-dev.server-process")]))']).toString();
    expect(childSees).toBe('undefined');
  });
});
