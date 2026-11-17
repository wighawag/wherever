import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * Messages DROPPED from the assistant session are shown in the web (task
 * `web-sees-messages-dropped-from-the-assistant-session`), against the REAL
 * server (real pi, fake LLM): a web stop with a web steer queued, and a reset
 * with one queued, send the session's web viewers a `session_notice` naming the
 * dropped text, and pi's cleared queue reaches them as an empty `queue_update`
 * (the pending-steer UI clears). With `assistantFolder` unset nothing new is
 * sent on a stop.
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
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-dropped-')));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function boot(root: string, config: Record<string, unknown>): Promise<Harness> {
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  const h = await startHarness({
    initial: { kind: 'slow-reply', text: 'a very long and slow answer '.repeat(40), charDelayMs: 20 },
    env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir },
  });
  cleanups.push(() => h.cleanup());
  return h;
}

async function client(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

const after = (c: TestClient, from: number) => (m: { type: string }) => c.messages.indexOf(m as any) >= from;

async function openAssistant(c: TestClient): Promise<{ sessionFile: string; sessionId: string }> {
  const before = c.messages.length;
  c.send({ type: 'assistant_open' });
  const cur = await c.waitFor((m) => m.type === 'assistant_current' && after(c, before)(m));
  c.send({ type: 'session_load', sessionFile: cur.sessionFile });
  await c.waitFor((m) => m.type === 'session_ready' && m.sessionFile === cur.sessionFile && after(c, before)(m));
  return { sessionFile: cur.sessionFile as string, sessionId: cur.sessionId as string };
}

/** Start a slow turn and queue `steer` into it; resolves once pi reports it queued. */
async function queueSteer(c: TestClient, sessionId: string, steer: string): Promise<number> {
  const before = c.messages.length;
  c.send({ type: 'message', message: 'start something slow', sessionId });
  await c.waitFor((m) => m.type === 'message_update' && after(c, before)(m), 30_000);
  c.send({ type: 'message', message: steer, sessionId });
  await c.waitFor((m) => m.type === 'queue_update' && Array.isArray(m.steering) && m.steering.includes(steer), 30_000);
  return c.messages.length;
}

const droppedNotices = (c: TestClient, text: string) =>
  c.messages.filter((m) => m.type === 'session_notice' && String(m.message).includes(text));

describe('messages dropped from the assistant session are shown in the web (real server)', () => {
  it('a web stop with a web steer queued: the viewer gets a notice naming it, and the pending steer clears', async () => {
    const root = tmp();
    const h = await boot(root, { assistantFolder: path.join(root, 'assistant') });
    const c = await client(h);
    const cur = await openAssistant(c);
    const mark = await queueSteer(c, cur.sessionId, 'web steer to drop');

    c.send({ type: 'abort', sessionId: cur.sessionId });
    const notice = await c.waitFor((m) => m.type === 'session_notice' && String(m.message).includes('web steer to drop'), 30_000);
    expect(notice).toMatchObject({ sessionId: cur.sessionId, level: 'warning' });
    expect(String(notice.message)).toMatch(/^Stopped before it read/);
    // pi's cleared queue reached the viewer: nothing is left pending.
    await c.waitFor((m) => m.type === 'queue_update' && Array.isArray(m.steering) && m.steering.length === 0 && after(c, mark)(m), 30_000);
    const lastQueue = [...c.messages].reverse().find((m) => m.type === 'queue_update');
    expect(lastQueue?.steering).toEqual([]);
    // Reported once.
    await new Promise((r) => setTimeout(r, 500));
    expect(droppedNotices(c, 'web steer to drop')).toHaveLength(1);
  }, 90_000);

  it('a reset with a web steer queued: the viewers of the retired session get the notice', async () => {
    const root = tmp();
    const h = await boot(root, { assistantFolder: path.join(root, 'assistant') });
    const oldTab = await client(h);
    const old = await openAssistant(oldTab);
    await queueSteer(oldTab, old.sessionId, 'steer lost to the reset');

    const other = await client(h);
    other.send({ type: 'assistant_reset' });
    const next = await other.waitForType('assistant_current');
    expect(next.sessionFile).not.toBe(old.sessionFile);

    const notice = await oldTab.waitFor((m) => m.type === 'session_notice' && String(m.message).includes('steer lost to the reset'), 30_000);
    expect(notice).toMatchObject({ sessionId: old.sessionId, level: 'warning' });
    expect(String(notice.message)).toMatch(/reset/);
    // A tab not viewing that session is told nothing.
    expect(droppedNotices(other, 'steer lost to the reset')).toHaveLength(0);
  }, 90_000);

  it('unset: a stop with a steer queued sends no dropped notice (exactly as before)', async () => {
    const root = tmp();
    const h = await boot(root, {});
    const c = await client(h);
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');
    const sessionId = created.sessionId as string;
    await queueSteer(c, sessionId, 'plain steer');
    const before = c.messages.length;
    c.send({ type: 'abort', sessionId });
    await c.waitFor((m) => m.type === 'agent_end' && after(c, before)(m), 30_000);
    await new Promise((r) => setTimeout(r, 1000));
    expect(c.messages.some((m) => m.type === 'session_notice')).toBe(false);
  }, 90_000);
});
