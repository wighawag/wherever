import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionPool, type ServerTrackedSession } from '../src/session-pool.ts';
import {
  CLI_RENAME_CAPABILITY,
  MAX_SESSION_NAME_CHARS,
  RENAME_REFUSALS,
  SessionRenamer,
  validateRenameInput,
} from '../src/session-rename.ts';

/**
 * The write paths of a rename (ADR 0027 "a rename is written by the file's
 * owner"), against a bare pool and a fake bridge socket:
 *  - a server session: its own agent writes the `session_info`;
 *  - a CLI-bridged session: a `cli_rename {id, name}` frame to the bridge, settled
 *    by its `cli_rename_result` (ok, ok:false, timeout, socket closed, another
 *    socket's answer ignored); a bridge without the `cli_rename` capability is
 *    refused and sent nothing;
 *  - a session only on disk: pi's `SessionManager.open(...).appendSessionInfo`;
 *  - refused: a load in flight, a reloading entry, a session with no message.
 *
 * The HTTP endpoint (path validation, broadcast) is session-rename-server.test.ts.
 * PI_CODING_AGENT_DIR, WHEREVER_CONFIG_DIR and WHEREVER_STATE_DIR are temp dirs;
 * the real ~/.pi and ~/.wherever are asserted untouched.
 */

const REAL_DIRS = [path.join(os.homedir(), '.wherever'), path.join(os.homedir(), '.pi', 'agent', 'sessions')];
const snapshot = (d: string) => {
  try {
    return fs.readdirSync(d).sort().map((n) => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`).join(',');
  } catch {
    return 'ABSENT';
  }
};
let realBefore: string[];
let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  realBefore = REAL_DIRS.map(snapshot);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-rename-')));
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
  // Never called: no test prompts the model.
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: { fake: { baseUrl: 'http://127.0.0.1:9', api: 'anthropic-messages', apiKey: 'k', models: [{ id: 'fake-a' }] } },
    }),
  );
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-a' }));
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  expect(REAL_DIRS.map(snapshot)).toEqual(realBefore);
});

const freshCwd = () => fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));

/** A transcript in the pool's sessions dir; `withMessage: false` writes the header only. */
function writeSession(cwd: string, opts: { withMessage?: boolean } = {}): string {
  const id = crypto.randomUUID();
  const dir = path.join(process.env.PI_CODING_AGENT_DIR!, 'sessions', '--rename--');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() })];
  if (opts.withMessage !== false) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hello', timestamp: Date.now() },
      }),
    );
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** The LAST `session_info` name in a transcript (what the listing shows). */
function nameOnDisk(file: string): string | undefined {
  let name: string | undefined;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.type === 'session_info') name = e.name;
  }
  return name;
}

function fakeBridge() {
  const sent: any[] = [];
  return { sent, ws: { readyState: 1, send: (d: string) => void sent.push(JSON.parse(d)), close() {} } as any };
}

async function serverSession(pool: SessionPool, opts: { withMessage?: boolean } = {}): Promise<ServerTrackedSession> {
  const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
  expect(error).toBeUndefined();
  const t = tracked as ServerTrackedSession;
  if (opts.withMessage !== false) {
    t.agentSession.sessionManager.appendMessage({ role: 'user', content: 'hello', timestamp: Date.now() } as any);
  }
  return t;
}

describe('validateRenameInput', () => {
  it('trims and collapses whitespace, refuses empty, non-string and over-long names', () => {
    expect(validateRenameInput({ sessionFile: '/a.jsonl', name: '  Release\n notes \t' })).toEqual({ sessionFile: '/a.jsonl', name: 'Release notes' });
    expect(validateRenameInput({ sessionFile: '/a.jsonl', name: '   ' })).toHaveProperty('error');
    expect(validateRenameInput({ sessionFile: '/a.jsonl', name: 5 })).toHaveProperty('error');
    expect(validateRenameInput({ name: 'x' })).toHaveProperty('error');
    expect(validateRenameInput({ sessionFile: '/a.jsonl', name: 'x'.repeat(MAX_SESSION_NAME_CHARS) })).not.toHaveProperty('error');
    expect(validateRenameInput({ sessionFile: '/a.jsonl', name: 'x'.repeat(MAX_SESSION_NAME_CHARS + 1) })).toHaveProperty('error');
    expect(validateRenameInput(null)).toHaveProperty('error');
  });
});

describe('SessionRenamer write paths', () => {
  it('a server session is renamed by its own agent', async () => {
    const pool = new SessionPool(300_000);
    const t = await serverSession(pool);
    const spy = vi.spyOn(t.agentSession, 'setSessionName');
    const r = await new SessionRenamer(pool).rename(t.sessionFile, 'Server named');
    expect(r).toEqual({ ok: true, path: 'server' });
    expect(spy).toHaveBeenCalledWith('Server named');
    expect(nameOnDisk(t.sessionFile)).toBe('Server named');
    await pool.disposeAll();
  }, 30_000);

  it('a server session with no message yet is refused (nothing would reach the file)', async () => {
    const pool = new SessionPool(300_000);
    const t = await serverSession(pool, { withMessage: false });
    const r = await new SessionRenamer(pool).rename(t.sessionFile, 'x');
    expect(r).toEqual({ ok: false, status: 409, error: RENAME_REFUSALS.empty });
    await pool.disposeAll();
  }, 30_000);

  it('a reloading server session is refused', async () => {
    const pool = new SessionPool(300_000);
    const t = await serverSession(pool);
    t.reloading = true;
    const r = await new SessionRenamer(pool).rename(t.sessionFile, 'x');
    expect(r).toEqual({ ok: false, status: 409, error: RENAME_REFUSALS.reloading });
    expect(nameOnDisk(t.sessionFile)).toBeUndefined();
    t.reloading = false;
    await pool.disposeAll();
  }, 30_000);

  it('a file with a load in flight is refused, and is renamed once it settled', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    const file = writeSession(cwd);
    const loading = pool.loadSession(file, cwd);
    expect(pool.hasPendingLoad(file)).toBe(true);
    const renamer = new SessionRenamer(pool);
    expect(await renamer.rename(file, 'x')).toEqual({ ok: false, status: 409, error: RENAME_REFUSALS.pending });
    expect(nameOnDisk(file)).toBeUndefined();
    expect((await loading).error).toBeUndefined();
    expect(pool.hasPendingLoad(file)).toBe(false);
    expect(await renamer.rename(file, 'After load')).toEqual({ ok: true, path: 'server' });
    expect(nameOnDisk(file)).toBe('After load');
    await pool.disposeAll();
  }, 30_000);

  it('a session only on disk gets a session_info appended; empty and missing files are refused', async () => {
    const pool = new SessionPool(300_000);
    const renamer = new SessionRenamer(pool);
    const file = writeSession(freshCwd());
    expect(await renamer.rename(file, 'First')).toEqual({ ok: true, path: 'disk' });
    expect(await renamer.rename(file, 'Second')).toEqual({ ok: true, path: 'disk' });
    expect(nameOnDisk(file)).toBe('Second');
    // The append is a child of the leaf (pi's own tree), so pi still opens the file.
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['session', 'message', 'session_info', 'session_info']);
    expect(lines[2].parentId).toBe('m1');

    const empty = writeSession(freshCwd(), { withMessage: false });
    const before = fs.readFileSync(empty, 'utf8');
    expect(await renamer.rename(empty, 'x')).toEqual({ ok: false, status: 409, error: RENAME_REFUSALS.empty });
    expect(fs.readFileSync(empty, 'utf8')).toBe(before);

    const missing = path.join(path.dirname(file), 'nope.jsonl');
    expect(await renamer.rename(missing, 'x')).toEqual({ ok: false, status: 404, error: RENAME_REFUSALS.notFound });
    expect(fs.existsSync(missing)).toBe(false);
  }, 30_000);

  it('a CLI-bridged session is renamed by the bridge: cli_rename {id, name}, settled by its cli_rename_result', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    const file = writeSession(cwd);
    const bridge = fakeBridge();
    await pool.registerCliSession(file, cwd, '', bridge.ws, false, { capabilities: ['cli_request', CLI_RENAME_CAPABILITY] });
    const renamer = new SessionRenamer(pool);
    const before = fs.readFileSync(file, 'utf8');

    const ok = renamer.rename(file, 'From the web');
    await new Promise((r) => setImmediate(r));
    expect(bridge.sent).toEqual([{ type: 'cli_rename', id: expect.any(String), name: 'From the web' }]);
    const id = bridge.sent[0].id;
    // Another socket cannot answer it, nor can an unknown id.
    renamer.handleResult(fakeBridge().ws, { id, ok: true });
    renamer.handleResult(bridge.ws, { id: 'other', ok: true });
    renamer.handleResult(bridge.ws, { id, ok: true });
    expect(await ok).toEqual({ ok: true, path: 'cli' });
    // The server never wrote the terminal's file itself.
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    const refused = renamer.rename(file, 'x');
    await new Promise((r) => setImmediate(r));
    renamer.handleResult(bridge.ws, { id: bridge.sent[1].id, ok: false, error: 'boom' });
    const r = await refused;
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(502);
    expect(r.ok === false && r.error).toMatch(/boom/);
    await pool.disposeAll();
  }, 30_000);

  it('a bridge that never answers times out; a bridge that disconnects fails at once', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    const file = writeSession(cwd);
    const bridge = fakeBridge();
    await pool.registerCliSession(file, cwd, '', bridge.ws, false, { capabilities: [CLI_RENAME_CAPABILITY] });

    const timedOut = await new SessionRenamer(pool, { timeoutMs: 50 }).rename(file, 'x');
    expect(timedOut).toEqual({ ok: false, status: 504, error: RENAME_REFUSALS.timeout });

    const renamer = new SessionRenamer(pool, { timeoutMs: 60_000 });
    const dropped = renamer.rename(file, 'x');
    await new Promise((r) => setImmediate(r));
    renamer.dropSocket(bridge.ws);
    expect(await dropped).toEqual({ ok: false, status: 502, error: RENAME_REFUSALS.bridgeClosed });
    await pool.disposeAll();
  }, 30_000);

  it('a bridge without the cli_rename capability (an older extension) is refused and sent nothing', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    const file = writeSession(cwd);
    const bridge = fakeBridge();
    await pool.registerCliSession(file, cwd, '', bridge.ws, false, { capabilities: ['agent_settled', 'cli_request'] });
    const before = fs.readFileSync(file, 'utf8');
    const r = await new SessionRenamer(pool).rename(file, 'x');
    expect(r).toEqual({ ok: false, status: 409, error: RENAME_REFUSALS.oldBridge });
    expect(RENAME_REFUSALS.oldBridge).toMatch(/update the wherever extension in that terminal/i);
    expect(bridge.sent).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    await pool.disposeAll();
  }, 30_000);

  it('a CLI-bridged session with no file yet (no message in the terminal) is refused and sent nothing', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    const file = path.join(process.env.PI_CODING_AGENT_DIR!, 'sessions', '--rename--', `2026_${crypto.randomUUID()}.jsonl`);
    const bridge = fakeBridge();
    await pool.registerCliSession(file, cwd, '', bridge.ws, false, { capabilities: [CLI_RENAME_CAPABILITY] });
    expect(await new SessionRenamer(pool).rename(file, 'x')).toEqual({ ok: false, status: 409, error: RENAME_REFUSALS.empty });
    expect(bridge.sent).toEqual([]);
    await pool.disposeAll();
  }, 30_000);
});
