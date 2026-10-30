import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * The current assistant session against the REAL server (spec
 * `assistant-session-and-channels`): the Assistant entry point (`assistant_open`)
 * creates and points at a session when there is none, a reset (`assistant_reset`,
 * or a web `/new` / `/reset`, which is a forceNew `session_new` in the folder)
 * yields a NEW session even while a tab views the old one and retires the old
 * one, `jobs/` and other folders never move the pointer, and the pointer survives
 * a restart. With `assistantFolder` unset none of it exists.
 *
 * Isolation: `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR`
 * all point at temp dirs, and the real ~/.wherever is asserted untouched.
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
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-ptr-')));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function boot(root: string, config: Record<string, unknown>, opts?: Parameters<typeof startHarness>[0]): Promise<Harness> {
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  const h = await startHarness({ ...opts, env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir } });
  cleanups.push(() => h.cleanup());
  return h;
}

async function assistantStatus(port: number): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/config`);
  return (await res.json()).assistant;
}

async function client(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

/** Open the current assistant session the way the web does: assistant_open, then session_load. */
async function openAssistant(c: TestClient): Promise<{ sessionFile: string; sessionId: string }> {
  const before = c.messages.length;
  c.send({ type: 'assistant_open' });
  const cur = await c.waitFor((m) => m.type === 'assistant_current' && c.messages.indexOf(m) >= before);
  c.send({ type: 'session_load', sessionFile: cur.sessionFile });
  await c.waitFor((m) => m.type === 'session_ready' && m.sessionFile === cur.sessionFile);
  return { sessionFile: cur.sessionFile as string, sessionId: cur.sessionId as string };
}

describe('assistant pointer (real server)', () => {
  it('unset: no Assistant, and session_new behaves as before', async () => {
    const root = tmp();
    const h = await boot(root, {});
    const status = await assistantStatus(h.port);
    expect(status).toEqual({ configured: false, folder: null, active: false, lock: null });

    const c = await client(h);
    c.send({ type: 'assistant_open' });
    const err = await c.waitForType('session_error');
    expect(String(err.error)).toMatch(/not active/i);

    c.send({ type: 'session_new', cwd: path.join(root, 'work') });
    const created = await c.waitForType('session_created');
    expect(created.readOnly).toBeFalsy();
    expect(fs.existsSync(path.join(root, 'state', 'assistant-session.json'))).toBe(false);
  }, 60_000);

  it('opening the Assistant with no pointer creates a session in the folder and points at it', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder });
    expect(await assistantStatus(h.port)).toMatchObject({ active: true, currentSessionId: null, currentSessionFile: null });

    const c = await client(h);
    const cur = await openAssistant(c);
    const created = c.messages.find((m) => m.type === 'session_created' && m.sessionFile === cur.sessionFile)!;
    expect(created.cwd).toBe(folder);
    expect(await assistantStatus(h.port)).toMatchObject({ currentSessionId: cur.sessionId, currentSessionFile: cur.sessionFile });
    const pointer = JSON.parse(fs.readFileSync(path.join(root, 'state', 'assistant-session.json'), 'utf8'));
    expect(pointer).toMatchObject({ folder, sessionFile: cur.sessionFile });

    // A second tab opening the Assistant lands in the SAME session.
    const c2 = await client(h);
    expect((await openAssistant(c2)).sessionFile).toBe(cur.sessionFile);
  }, 60_000);

  it('reset yields a NEW session while a tab views the old one, aborts its turn and clears its queue', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder }, {
      initial: { kind: 'slow-reply', text: 'a long reply streaming slowly '.repeat(20), charDelayMs: 40 },
    });
    const viewer = await client(h);
    const old = await openAssistant(viewer);

    // A running turn with a queued steer.
    viewer.send({ type: 'message', message: 'start working', sessionId: old.sessionId });
    await viewer.waitForType('message_update');
    viewer.send({ type: 'message', message: 'queued steer', sessionId: old.sessionId });
    await viewer.waitFor((m) => m.type === 'queue_update' && (m as any).steering?.includes('queued steer'));

    const other = await client(h);
    other.send({ type: 'assistant_reset' });
    const next = await other.waitForType('assistant_current');
    expect(next.sessionFile).not.toBe(old.sessionFile);
    expect(next.cwd).toBe(folder);
    expect((await assistantStatus(h.port)).currentSessionFile).toBe(next.sessionFile);

    // The old turn ended (aborted, long before the slow reply could finish) and
    // its queue was cleared.
    await viewer.waitFor((m) => m.type === 'agent_end', 10_000);
    await viewer.waitFor((m) => m.type === 'queue_update' && Array.isArray((m as any).steering) && (m as any).steering.length === 0);
    // Every dashboard heard that the pointer moved.
    await viewer.waitFor((m) => m.type === 'assistant_status' && m.currentSessionFile === next.sessionFile);
  }, 90_000);

  it('a web /new in the folder moves the pointer; jobs/ and elsewhere never do', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder });
    const c = await client(h);
    const cur = await openAssistant(c);

    for (const cwd of [path.join(folder, 'jobs'), path.join(root, 'elsewhere')]) {
      const before = c.messages.length;
      c.send({ type: 'session_new', cwd });
      await c.waitFor((m) => m.type === 'session_created' && c.messages.indexOf(m) >= before);
      expect((await assistantStatus(h.port)).currentSessionFile).toBe(cur.sessionFile);
    }

    // What the composer's local /new and /reset send, from inside the assistant session.
    const before = c.messages.length;
    c.send({ type: 'session_new', cwd: folder });
    const created = await c.waitFor((m) => m.type === 'session_created' && c.messages.indexOf(m) >= before);
    expect(created.sessionFile).not.toBe(cur.sessionFile);
    await c.waitFor((m) => m.type === 'assistant_status' && m.currentSessionFile === created.sessionFile);
    expect((await assistantStatus(h.port)).currentSessionFile).toBe(created.sessionFile);
  }, 60_000);

  it('the pointer survives a restart', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder }, { initial: { kind: 'reply', text: 'hi there' } });
    const c = await client(h);
    const cur = await openAssistant(c);
    // Start the conversation so pi writes the session file.
    c.send({ type: 'message', message: 'remember me', sessionId: cur.sessionId });
    await c.waitForType('agent_end');
    await h.stop();
    expect(fs.existsSync(cur.sessionFile)).toBe(true);

    const h2 = await boot(root, { assistantFolder: folder });
    expect(await assistantStatus(h2.port)).toMatchObject({ currentSessionFile: cur.sessionFile, currentSessionId: cur.sessionId });
    const c2 = await client(h2);
    expect((await openAssistant(c2)).sessionFile).toBe(cur.sessionFile);
  }, 90_000);
});
