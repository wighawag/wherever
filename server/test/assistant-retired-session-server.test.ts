import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * A RETIRED assistant session against the REAL server (ADR 0020): a session in
 * `assistantFolder` (not `jobs/`) that is not the current pointer session is
 * read-only for web viewers, the verdict is HARD ("Continue anyway" does not
 * lift it), its viewers are told live when the pointer moves, and it never
 * counts as an occupant for the folder-conflict check, so the CURRENT session
 * opens writable while a tab still views the old one. With `assistantFolder`
 * unset nothing is retired and the folder-conflict rule is as before.
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
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-retired-')));
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

async function client(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

/** Messages `c` received from index `from` on. */
const after = (c: TestClient, from: number) => (m: { type: string }) => c.messages.indexOf(m as any) >= from;

/** Open the current assistant session the way the web does: assistant_open, then session_load. */
async function openAssistant(c: TestClient): Promise<{ sessionFile: string; sessionId: string; created: any }> {
  const before = c.messages.length;
  c.send({ type: 'assistant_open' });
  const cur = await c.waitFor((m) => m.type === 'assistant_current' && after(c, before)(m));
  c.send({ type: 'session_load', sessionFile: cur.sessionFile });
  const created = await c.waitFor((m) => m.type === 'session_created' && m.sessionFile === cur.sessionFile && after(c, before)(m));
  await c.waitFor((m) => m.type === 'session_ready' && m.sessionFile === cur.sessionFile && after(c, before)(m));
  return { sessionFile: cur.sessionFile as string, sessionId: cur.sessionId as string, created };
}

/** Send a message and wait for its turn to end. */
async function talk(c: TestClient, sessionId: string, text: string): Promise<void> {
  const before = c.messages.length;
  c.send({ type: 'message', message: text, sessionId });
  await c.waitFor((m) => m.type === 'agent_end' && after(c, before)(m));
}

describe('retired assistant session (real server)', () => {
  it('after a reset with a tab on the old session, the new one opens writable and the old tab turns read-only, hard', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder }, { initial: { kind: 'reply', text: 'ok' } });

    const oldTab = await client(h);
    const old = await openAssistant(oldTab);
    expect(old.created.readOnly).toBeFalsy();
    expect(old.created.assistantRetired).toBeFalsy();

    const newTab = await client(h);
    newTab.send({ type: 'assistant_reset' });
    const next = await newTab.waitForType('assistant_current');
    expect(next.sessionFile).not.toBe(old.sessionFile);

    // The old tab is told LIVE (no reload) that its session is retired.
    const retired = await oldTab.waitFor((m) => m.type === 'assistant_retired');
    expect(retired).toMatchObject({ sessionId: old.sessionId, retired: true, readOnly: true });

    // The new session opens writable, with no conflict banner, although the old
    // tab is still attached to the old session in the same folder.
    const before = newTab.messages.length;
    newTab.send({ type: 'session_load', sessionFile: next.sessionFile });
    const created = await newTab.waitFor((m) => m.type === 'session_created' && after(newTab, before)(m));
    expect(created.readOnly).toBe(false);
    expect(created.folderConflict).toBe(false);
    expect(created.assistantRetired).toBeFalsy();
    await newTab.waitFor((m) => m.type === 'session_ready' && after(newTab, before)(m));
    await talk(newTab, next.sessionId as string, 'hello current');
    // No folder_conflict ever re-locked the current tab.
    expect(newTab.messages.some((m) => m.type === 'folder_conflict' && m.readOnly === true && after(newTab, before)(m))).toBe(false);

    // The old tab's sends are refused, naming the reset.
    oldTab.send({ type: 'message', message: 'into the past', sessionId: old.sessionId });
    const refused = await oldTab.waitFor((m) => m.type === 'session_error' && /retired|reset/i.test(String(m.error)));
    expect(String(refused.error)).toMatch(/current assistant session/i);

    // "Continue anyway" cannot lift it.
    const cBefore = oldTab.messages.length;
    oldTab.send({ type: 'folder_conflict_continue', sessionId: old.sessionId });
    const ack = await oldTab.waitFor((m) => m.type === 'folder_conflict' && after(oldTab, cBefore)(m));
    expect(ack.readOnly).toBe(true);
    // A retired session is not a party to a folder conflict.
    expect(ack.active).toBe(false);

    // The notice's action: opening the Assistant from the old tab lands in the
    // current session, writable.
    const reopened = await openAssistant(oldTab);
    expect(reopened.sessionFile).toBe(next.sessionFile);
    expect(reopened.created.readOnly).toBe(false);
    expect(reopened.created.assistantRetired).toBeFalsy();
  }, 90_000);

  it('a web /new in the folder retires the session other tabs are viewing, and the new one is writable', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder });

    const a = await client(h);
    const b = await client(h);
    const old = await openAssistant(a);
    await openAssistant(b);

    const before = a.messages.length;
    a.send({ type: 'session_new', cwd: folder });
    const created = await a.waitFor((m) => m.type === 'session_created' && after(a, before)(m));
    expect(created.sessionFile).not.toBe(old.sessionFile);
    expect(created.readOnly).toBe(false);
    expect(created.folderConflict).toBe(false);
    expect(created.assistantRetired).toBeFalsy();

    const retired = await b.waitFor((m) => m.type === 'assistant_retired');
    expect(retired).toMatchObject({ sessionId: old.sessionId, retired: true, readOnly: true });
    // The tab that moved on is never told its NEW session is retired.
    expect(a.messages.some((m) => m.type === 'assistant_retired' && m.sessionId === created.sessionId && m.retired === true)).toBe(false);
  }, 60_000);

  it('an old assistant session opened from the list (cold, after a restart) is read-only; jobs/ sessions never are', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder }, { initial: { kind: 'reply', text: 'ok' } });
    const c = await client(h);
    const old = await openAssistant(c);
    // Start the conversation so pi writes the session file (it is listable).
    await talk(c, old.sessionId, 'remember me');
    const resetFrom = c.messages.length;
    c.send({ type: 'assistant_reset' });
    const next = await c.waitFor((m) => m.type === 'assistant_current' && after(c, resetFrom)(m));
    expect(next.sessionFile).not.toBe(old.sessionFile);
    await h.stop();
    expect(fs.existsSync(old.sessionFile)).toBe(true);

    // Restarted: nothing is resident, so the old session loads COLD.
    const h2 = await boot(root, { assistantFolder: folder }, { initial: { kind: 'reply', text: 'ok' } });
    const c2 = await client(h2);
    c2.send({ type: 'session_load', sessionFile: old.sessionFile });
    const created = await c2.waitFor((m) => m.type === 'session_created' && m.sessionFile === old.sessionFile);
    expect(created.readOnly).toBe(true);
    expect(created.assistantRetired).toBe(true);
    expect(created.folderConflict).toBe(false);
    await c2.waitFor((m) => m.type === 'session_ready' && m.sessionFile === old.sessionFile);
    // Still read-only after the cold build re-derived the verdict.
    c2.send({ type: 'message', message: 'hi', sessionId: created.sessionId });
    await c2.waitFor((m) => m.type === 'session_error' && /retired|reset/i.test(String(m.error)));

    // A jobs/ session is never retired, and two of them conflict as ordinary sessions do.
    const jobs = path.join(folder, 'jobs');
    const j1 = await client(h2);
    j1.send({ type: 'session_new', cwd: jobs });
    const jc = await j1.waitForType('session_created');
    expect(jc.readOnly).toBe(false);
    expect(jc.assistantRetired).toBeFalsy();
    const j2 = await client(h2);
    j2.send({ type: 'session_new', cwd: jobs });
    const jc2 = await j2.waitForType('session_created');
    expect(jc2.folderConflict).toBe(true);
    expect(jc2.readOnly).toBe(true);
    expect(jc2.assistantRetired).toBeFalsy();
  }, 120_000);

  it('unset: no session is retired and two sessions in one folder still conflict as before', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, {});
    const a = await client(h);
    a.send({ type: 'session_new', cwd: folder });
    const ca = await a.waitForType('session_created');
    expect(ca.readOnly).toBe(false);
    expect(ca.assistantRetired).toBeFalsy();

    const b = await client(h);
    b.send({ type: 'session_new', cwd: folder });
    const cb = await b.waitForType('session_created');
    expect(cb.folderConflict).toBe(true);
    expect(cb.readOnly).toBe(true);
    expect(cb.assistantRetired).toBeFalsy();

    b.send({ type: 'folder_conflict_continue', sessionId: cb.sessionId });
    const ack = await b.waitFor((m) => m.type === 'folder_conflict' && m.readOnly === false);
    expect(ack.active).toBe(true);
    expect([...a.messages, ...b.messages].some((m) => m.type === 'assistant_retired')).toBe(false);
  }, 60_000);
});
