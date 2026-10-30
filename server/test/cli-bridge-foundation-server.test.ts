import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * The CLI bridge foundation against the REAL server (ADR 0016). A test client
 * plays the `@wherever-dev/pi` extension by sending its frames:
 *  - `cli_register` with `isNew: true` in `assistantFolder` moves the assistant
 *    pointer (state dir); `isNew: false` (pi -c, a reconnect), an older extension
 *    (no `isNew`) and another folder do not; with `assistantFolder` unset nothing
 *    is written;
 *  - `cli_request` `assistant_info` round-trips (folder, or null when not
 *    active); an unknown op answers an error; an unregistered connection is
 *    refused;
 *  - a forwarded `agent_settled` produces no new frame, `sessions_updated` or
 *    working-dot change for viewers.
 *
 * Isolation: `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR`
 * point at temp dirs, and the real ~/.wherever is asserted untouched.
 */

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
      } else if (st.isFile()) {
        const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
        entries.push(`${prefix}${name}:${h}`);
      }
    }
  };
  walk(dir, '');
  return entries.join('\n');
}
const realBefore = snapshotDir(REAL_WHEREVER_DIR);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(() => {
  expect(snapshotDir(REAL_WHEREVER_DIR)).toBe(realBefore);
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-cli-bridge-')));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function boot(root: string, config: Record<string, unknown>): Promise<Harness> {
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  const h = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir } });
  cleanups.push(() => h.cleanup());
  return h;
}

async function client(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

async function assistantStatus(port: number): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/config`);
  return (await res.json()).assistant;
}

const pointerFile = (root: string) => path.join(root, 'state', 'assistant-session.json');

/** Register a CLI-bridge session the way the extension does. */
async function register(h: Harness, sessionFile: string, cwd: string, extra: Record<string, unknown> = {}): Promise<TestClient> {
  const cli = await client(h);
  cli.send({ type: 'cli_register', sessionFile, cwd, model: 'fake:fake-model', isStreaming: false, ...extra });
  await h.waitForActive(sessionFile);
  return cli;
}

async function request(cli: TestClient, op: string, args?: unknown): Promise<any> {
  const id = crypto.randomUUID();
  cli.send({ type: 'cli_request', id, op, ...(args === undefined ? {} : { args }) });
  return cli.waitFor((m) => m.type === 'cli_response' && m.id === id);
}

async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

async function waitInactive(h: Harness, sessionFile: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = (await (await fetch(`http://127.0.0.1:${h.port}/sessions`)).json()) as { activeSessions?: { sessionFile: string }[] };
    if (!data.activeSessions?.some((s) => s.sessionFile.endsWith(path.basename(sessionFile)))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('CLI bridge foundation (real server)', () => {
  it('a fresh pi in assistantFolder (isNew) moves the pointer; pi -c, an old extension and other folders do not', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder });
    const sessions = path.join(root, 'cli-sessions');
    fs.mkdirSync(sessions, { recursive: true });

    // pi -c on an existing session in the folder: isNew false.
    await register(h, path.join(sessions, 'resumed.jsonl'), folder, { isNew: false, capabilities: ['agent_settled', 'cli_request'] });
    // An older extension: no isNew at all.
    await register(h, path.join(sessions, 'old-ext.jsonl'), folder);
    // A fresh pi elsewhere, and in jobs/.
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    await register(h, path.join(sessions, 'elsewhere.jsonl'), elsewhere, { isNew: true });
    await register(h, path.join(sessions, 'job.jsonl'), path.join(folder, 'jobs'), { isNew: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(pointerFile(root))).toBe(false);
    expect(await assistantStatus(h.port)).toMatchObject({ active: true, currentSessionFile: null });

    // A fresh pi in the folder: the pointer moves to it.
    const fresh = path.join(sessions, 'fresh.jsonl');
    const cli = await register(h, fresh, folder, { isNew: true, capabilities: ['agent_settled', 'cli_request'] });
    expect(await until(() => fs.existsSync(pointerFile(root)), 5_000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(pointerFile(root), 'utf8'))).toMatchObject({ folder, sessionFile: fresh });
    expect(await assistantStatus(h.port)).toMatchObject({ currentSessionFile: fresh });

    // The terminal reconnects (isNew is not repeated); another session in the
    // folder resumed later does not take the pointer either.
    // Wait for the old socket's teardown first: a register racing it is a
    // separate, pre-existing hazard (see work/notes/observations).
    cli.close();
    expect(await waitInactive(h, fresh)).toBe(true);
    await register(h, fresh, folder, { isNew: false });
    await register(h, path.join(sessions, 'resumed.jsonl'), folder, { isNew: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.parse(fs.readFileSync(pointerFile(root), 'utf8')).sessionFile).toBe(fresh);
  }, 60_000);

  it('with assistantFolder unset, isNew writes no pointer and assistant_info says not configured', async () => {
    const root = tmp();
    const h = await boot(root, {});
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const cli = await register(h, path.join(root, 'fresh.jsonl'), cwd, { isNew: true, capabilities: ['cli_request'] });
    const res = await request(cli, 'assistant_info');
    expect(res).toEqual({ type: 'cli_response', id: res.id, ok: true, result: { assistantFolder: null, timezone: null } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(pointerFile(root))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'state'))).toEqual([]);
  }, 60_000);

  it('assistant_info round-trips the active folder; an unknown op errors; an unregistered connection is refused', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder });

    // Not registered yet: refused, with the id echoed.
    const anon = await client(h);
    const refused = await request(anon, 'assistant_info');
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/cli_register/);

    const cli = await register(h, path.join(root, 's.jsonl'), path.join(root), { capabilities: ['cli_request'] });
    const info = await request(cli, 'assistant_info');
    expect(info).toMatchObject({ type: 'cli_response', ok: true, result: { assistantFolder: folder } });

    const unknown = await request(cli, 'no_such_op');
    expect(unknown.ok).toBe(false);
    expect(String(unknown.error)).toMatch(/unknown/i);

    // Answered only to the asker.
    expect(anon.messages.filter((m) => m.type === 'cli_response')).toHaveLength(1);
  }, 60_000);

  it('a forwarded agent_settled is silent for viewers (no frame, no sessions_updated, no working dot)', async () => {
    const root = tmp();
    const h = await boot(root, {});
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionFile = path.join(root, 'cli.jsonl');
    const cli = await register(h, sessionFile, cwd, { capabilities: ['agent_settled', 'cli_request'] });
    const viewer = await client(h);
    viewer.send({ type: 'session_load', sessionFile });
    await viewer.waitForType('session_created');
    const dashboard = await client(h);

    // A full turn so the session is idle, then let every frame land.
    cli.send({ type: 'cli_event', sessionFile, event: { type: 'agent_start' } });
    cli.send({ type: 'cli_event', sessionFile, event: { type: 'agent_end', messages: [] } });
    await viewer.waitForType('agent_end');
    await new Promise((r) => setTimeout(r, 500));
    const viewerBefore = viewer.messages.length;
    const dashBefore = dashboard.messages.length;

    cli.send({ type: 'cli_event', sessionFile, event: { type: 'agent_settled', aborted: false } });
    // A marker after it, on the same socket, proves the settle was processed.
    const marker = await request(cli, 'assistant_info');
    expect(marker.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(viewer.messages.slice(viewerBefore)).toEqual([]);
    expect(dashboard.messages.slice(dashBefore)).toEqual([]);
  }, 60_000);
});
