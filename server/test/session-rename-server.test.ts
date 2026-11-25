import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * `POST /sessions/name` against the REAL server (ADR 0027 "a rename is written by
 * the file's owner"), beside the star / close endpoint tests:
 *  - path and name validation (400, nothing written);
 *  - a session only on disk: a `session_info` append, the new name on `/sessions`;
 *  - a server-run session (a real turn against the fake LLM): its agent writes it;
 *  - a CLI-bridged session: a test client plays the extension, receives
 *    `cli_rename {id, name}` and answers `cli_rename_result`; `ok:false` is an
 *    error; a bridge without the `cli_rename` capability is refused with a message;
 *  - a session with no message is refused;
 *  - `sessions_updated` is broadcast on success only.
 * The pending / reloading refusals and the bridge timeout are pinned at the pool
 * level (session-rename.test.ts), where they are deterministic.
 *
 * Isolation: the harness's agent dir, config and state dirs are temp dirs; the
 * real ~/.wherever and ~/.pi sessions dir are asserted untouched.
 */

const REAL_DIRS = [path.join(os.homedir(), '.wherever'), path.join(os.homedir(), '.pi', 'agent', 'sessions')];
const snapshot = (d: string) => {
  try {
    return fs.readdirSync(d).sort().map((n) => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`).join(',');
  } catch {
    return 'ABSENT';
  }
};
const realBefore = REAL_DIRS.map(snapshot);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(() => {
  expect(REAL_DIRS.map(snapshot)).toEqual(realBefore);
});

async function boot(opts: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-rename-srv-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const h = await startHarness({ ...opts, env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir } });
  cleanups.push(() => h.cleanup());
  return h;
}

async function rename(port: number, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/sessions/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function writeSession(h: Harness, opts: { withMessage?: boolean } = {}): string {
  const id = crypto.randomUUID();
  const dir = path.join(h.agentDir, 'sessions', '--workspace--');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [JSON.stringify({ type: 'session', version: 3, id, cwd: h.workspace, timestamp: new Date().toISOString() })];
  if (opts.withMessage !== false) {
    lines.push(
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: `hello from ${id}` } }),
    );
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

async function listedName(port: number, file: string): Promise<string | undefined> {
  const body = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
  for (const folder of body.folders) for (const s of folder.sessions) if (s.path === path.resolve(file)) return s.name;
  return undefined;
}

async function dashboard(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

/** Let any earlier `sessions_updated` (2 s throttle) flush, then return a mark. */
async function settled(c: TestClient): Promise<number> {
  await new Promise((r) => setTimeout(r, 2_300));
  return c.messages.length;
}
const updatedSince = (c: TestClient, mark: number) => c.messages.slice(mark).some((m) => m.type === 'sessions_updated');
const nextUpdate = (c: TestClient, mark: number) =>
  c.waitFor((m) => m.type === 'sessions_updated' && c.messages.indexOf(m) >= mark, 10_000);

async function registerBridge(h: Harness, file: string, capabilities: string[]): Promise<TestClient> {
  const cli = await dashboard(h);
  cli.send({ type: 'cli_register', sessionFile: file, cwd: h.workspace, model: 'fake:fake-model', isStreaming: false, capabilities });
  await h.waitForActive(file);
  return cli;
}

describe('POST /sessions/name', () => {
  it('validates the path and the name, writing nothing and broadcasting nothing', async () => {
    const h = await boot();
    const file = writeSession(h);
    const before = fs.readFileSync(file, 'utf8');
    const dash = await dashboard(h);
    const mark = await settled(dash);

    expect((await rename(h.port, '{not json')).status).toBe(400);
    expect((await rename(h.port, { sessionFile: '/etc/passwd.jsonl', name: 'x' })).status).toBe(400);
    const outsideDir = path.join(h.workspace, 'x.jsonl');
    fs.writeFileSync(outsideDir, before);
    const outside = await rename(h.port, { sessionFile: outsideDir, name: 'x' });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toMatch(/sessions directory/);
    expect((await rename(h.port, { sessionFile: path.join(path.dirname(file), 'x.txt'), name: 'x' })).status).toBe(400);
    expect((await rename(h.port, { sessionFile: file, name: '   ' })).status).toBe(400);
    expect((await rename(h.port, { sessionFile: file, name: 7 })).status).toBe(400);
    expect((await rename(h.port, { sessionFile: file, name: 'x'.repeat(201) })).status).toBe(400);
    expect((await rename(h.port, { name: 'x' })).status).toBe(400);
    const missing = await rename(h.port, { sessionFile: path.join(path.dirname(file), 'nope.jsonl'), name: 'x' });
    expect(missing.status).toBe(404);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    await new Promise((r) => setTimeout(r, 2_300));
    expect(updatedSince(dash, mark)).toBe(false);
  }, 60_000);

  it('renames a session only on disk, lists the new name and broadcasts sessions_updated', async () => {
    const h = await boot();
    const file = writeSession(h);
    const dash = await dashboard(h);
    const mark = await settled(dash);

    const res = await rename(h.port, { sessionFile: file, name: '  Release   notes ' });
    expect(res).toEqual({ status: 200, body: { sessionFile: path.resolve(file), name: 'Release notes' } });
    await nextUpdate(dash, mark);
    expect(await listedName(h.port, file)).toBe('Release notes');
    const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop()!);
    expect(last).toMatchObject({ type: 'session_info', name: 'Release notes' });
  }, 60_000);

  it('refuses a session with no message yet, without writing or broadcasting', async () => {
    const h = await boot();
    const file = writeSession(h, { withMessage: false });
    const before = fs.readFileSync(file, 'utf8');
    const dash = await dashboard(h);
    const mark = await settled(dash);

    const res = await rename(h.port, { sessionFile: file, name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no message yet/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    await new Promise((r) => setTimeout(r, 2_300));
    expect(updatedSince(dash, mark)).toBe(false);
  }, 60_000);

  it('a server-run session is renamed by its own agent', async () => {
    const h = await boot({ initial: { kind: 'reply', text: 'ok' } });
    const c = await dashboard(h);
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');
    c.send({ type: 'message', message: 'hi', sessionId: created.sessionId });
    await c.waitForType('agent_end');
    const file = created.sessionFile as string;
    const mark = await settled(c);

    const res = await rename(h.port, { sessionFile: file, name: 'Named live' });
    expect(res.status).toBe(200);
    await nextUpdate(c, mark);
    expect(await listedName(h.port, file)).toBe('Named live');
  }, 60_000);

  it('a CLI-bridged session is renamed by the terminal through cli_rename / cli_rename_result', async () => {
    const h = await boot();
    const file = writeSession(h);
    const before = fs.readFileSync(file, 'utf8');
    const cli = await registerBridge(h, file, ['agent_settled', 'cli_request', 'cli_rename']);
    const dash = await dashboard(h);
    const mark = await settled(dash);

    // The bridge says ok: 200 and a broadcast. The server did not write the file.
    const pending = rename(h.port, { sessionFile: file, name: 'From the phone' });
    const frame = await cli.waitFor((m) => m.type === 'cli_rename');
    expect(frame).toEqual({ type: 'cli_rename', id: expect.any(String), name: 'From the phone' });
    cli.send({ type: 'cli_rename_result', id: frame.id, ok: true });
    expect((await pending).status).toBe(200);
    await nextUpdate(dash, mark);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    // The bridge says no: an error with its reason, and no broadcast.
    const mark2 = await settled(dash);
    const refused = rename(h.port, { sessionFile: file, name: 'Again' });
    const frame2 = await cli.waitFor((m) => m.type === 'cli_rename' && m.id !== frame.id);
    cli.send({ type: 'cli_rename_result', id: frame2.id, ok: false, error: 'pi said no' });
    const r = await refused;
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/pi said no/);
    await new Promise((res) => setTimeout(res, 2_300));
    expect(updatedSince(dash, mark2)).toBe(false);
  }, 60_000);

  it('a bridge without the cli_rename capability is refused with "update the wherever extension"', async () => {
    const h = await boot();
    const file = writeSession(h);
    const before = fs.readFileSync(file, 'utf8');
    const cli = await registerBridge(h, file, ['agent_settled', 'cli_request']);
    const res = await rename(h.port, { sessionFile: file, name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/update the wherever extension in that terminal/i);
    await new Promise((r) => setTimeout(r, 200));
    expect(cli.messages.some((m) => m.type === 'cli_rename')).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  }, 60_000);
});
