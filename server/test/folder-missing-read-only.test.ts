import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

// A session's transcript and the FOLDER it refers to travel separately: the
// transcript syncs across machines, the git clone does not. Opening such a
// session used to look fine (the cheap header+history read never needed the
// folder) and then built a live agent against a directory that is not there --
// pi's SettingsManager.create() and DefaultResourceLoader.reload() both SUCCEED
// against a nonexistent cwd, so nothing threw and every later tool call was the
// first sign of trouble.
//
// FOLDER MISSING is now the third read-only reason, beside a configured
// sessions.readOnly rule and a folder conflict. It is HARD (no "Continue
// anyway") and cured only by restoring the folder and reloading.

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Create a session in `cwd` and give it one real turn, so it has history to paint. */
async function seedSession(harness: Harness, cwd: string) {
  const c = await harness.connect();
  await c.waitForType('connected');
  c.send({ type: 'session_new', cwd });
  const created = await c.waitForType('session_created');
  c.send({ type: 'message', message: 'hello', sessionId: created.sessionId });
  await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant');
  await c.waitForType('agent_end');
  return { c, sessionFile: created.sessionFile as string, sessionId: created.sessionId as string };
}

describe('a session whose working folder is gone', () => {
  it('paints its history, locks the client, and never builds an agent (cold load)', async () => {
    // idleTimeoutMs 0 -> the session is evicted when its last client leaves, so
    // the reload below is a genuine COLD load (the path that would build an
    // agent against the missing folder).
    h = await startHarness({ initial: { kind: 'reply', text: 'hi there' }, idleTimeoutMs: 0 });
    const doomed = path.join(h.workspace, 'doomed-project');
    fs.mkdirSync(doomed, { recursive: true });

    const { c, sessionFile } = await seedSession(h, doomed);
    c.close();
    await sleep(300);

    // The machine migration, in one line: the transcript survives, the clone does not.
    fs.rmSync(doomed, { recursive: true, force: true });
    const requestsBefore = h.fake.requests().length;

    const c2 = await h.connect();
    await c2.waitForType('connected');
    c2.send({ type: 'session_load', sessionFile });

    const painted = await c2.waitForType('session_created', 10_000);
    expect(painted.readOnly).toBe(true);
    expect(painted.folderMissing).toBe(true);

    // Reading never needed the folder, so the conversation still paints.
    const history = await c2.waitForType('message_history', 10_000);
    expect((history.messages as unknown[]).length).toBeGreaterThan(0);

    // The dedicated frame names the ABSOLUTE missing path, so the UI can say
    // exactly which folder to restore.
    const missing = await c2.waitForType('folder_missing', 10_000);
    expect(missing.cwd).toBe(doomed);

    // No agent is built: no session_ready ever arrives, so the composer stays disabled.
    await sleep(2_000);
    expect(c2.messages.some((m) => m.type === 'session_ready')).toBe(false);

    // A send is REFUSED out loud, and never reaches the model.
    c2.send({ type: 'message', message: 'do something', sessionId: painted.sessionId });
    const refusal = await c2.waitForType('session_error', 10_000);
    expect(String(refusal.error)).toContain(doomed);
    await sleep(500);
    expect(h.fake.requests().length).toBe(requestsBefore);
  }, 90_000);

  it('stays locked through "Continue anyway", and a sessions.readOnly rule still wins', async () => {
    // Precedence, all three reasons in one session: the folder is missing AND
    // its cwd matches a configured read-only rule. Neither is dismissible, and
    // the folder-conflict continue path must not lift either of them.
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-missing-cfg-'));
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({}));
    h = await startHarness({
      initial: { kind: 'reply', text: 'ok' },
      idleTimeoutMs: 0,
      env: { WHEREVER_CONFIG_DIR: configDir },
    });
    const doomed = path.join(h.workspace, 'fleet-project');
    fs.mkdirSync(doomed, { recursive: true });

    const { c, sessionFile } = await seedSession(h, doomed);
    c.close();
    await sleep(300);

    // The rule is configured AFTER seeding (the config is read per call), so the
    // session could be created and given history while still writable.
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ sessions: { readOnly: [`${doomed}/**`] } }),
    );
    fs.rmSync(doomed, { recursive: true, force: true });
    const requestsBefore = h.fake.requests().length;

    const c2 = await h.connect();
    await c2.waitForType('connected');
    c2.send({ type: 'session_load', sessionFile });
    const painted = await c2.waitForType('session_created', 10_000);
    expect(painted.readOnly).toBe(true);
    expect(painted.folderMissing).toBe(true);

    // The banner's escape hatch is not offered here, but a stale/older client
    // could still send it. It must not unlock anything.
    c2.send({ type: 'folder_conflict_continue', sessionId: painted.sessionId });
    await sleep(500);
    c2.send({ type: 'message', message: 'let me in', sessionId: painted.sessionId });
    const refusal = await c2.waitForType('session_error', 10_000);
    expect(String(refusal.error)).toContain(doomed);
    await sleep(500);
    expect(h.fake.requests().length).toBe(requestsBefore);

    fs.rmSync(configDir, { recursive: true, force: true });
  }, 90_000);

  it('locks a RESIDENT session too, without tearing down its running agent', async () => {
    // Detection is load-time and lives in the shared cheap meta read, so it
    // fires for a warm session as well. A folder that vanished under a live
    // session does NOT kill that session: this task only refuses to hand out a
    // FRESH write capability for a folder that is not there.
    h = await startHarness({ initial: { kind: 'reply', text: 'still alive' }, idleTimeoutMs: 300_000 });
    const doomed = path.join(h.workspace, 'resident-project');
    fs.mkdirSync(doomed, { recursive: true });

    const { c, sessionFile, sessionId } = await seedSession(h, doomed);

    // The folder disappears while the session stays resident (c is attached).
    fs.rmSync(doomed, { recursive: true, force: true });

    const c2 = await h.connect();
    await c2.waitForType('connected');
    c2.send({ type: 'session_load', sessionFile });
    const painted = await c2.waitFor(
      (m) => m.type === 'session_created' && m.sessionFile === sessionFile,
      10_000,
    );
    // Warm: the agent is still there (no pending phase), but this client is locked.
    expect(painted.pending).not.toBe(true);
    expect(painted.readOnly).toBe(true);
    expect(painted.folderMissing).toBe(true);
    const missing = await c2.waitForType('folder_missing', 10_000);
    expect(missing.cwd).toBe(doomed);

    // The already-attached client's live agent was NOT torn down: it still runs a turn.
    h.setNext({ kind: 'reply', text: 'still alive' });
    c.send({ type: 'message', message: 'are you there', sessionId });
    const end = await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
    expect(end.content).toBe('still alive');
  }, 90_000);

  it('leaves a session whose folder EXISTS exactly as it was', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'present' }, idleTimeoutMs: 0 });
    const alive = path.join(h.workspace, 'live-project');
    fs.mkdirSync(alive, { recursive: true });

    const { c, sessionFile } = await seedSession(h, alive);
    c.close();
    await sleep(300);

    const c2 = await h.connect();
    await c2.waitForType('connected');
    c2.send({ type: 'session_load', sessionFile });
    const painted = await c2.waitForType('session_created', 10_000);
    expect(painted.folderMissing).toBeFalsy();
    expect(painted.readOnly).toBeFalsy();
    await c2.waitForType('session_ready', 30_000);
    expect(c2.messages.some((m) => m.type === 'folder_missing')).toBe(false);

    // Still sendable, end to end.
    h.setNext({ kind: 'reply', text: 'second reply' });
    c2.send({ type: 'message', message: 'again', sessionId: painted.sessionId });
    const end = await c2.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
    expect(end.content).toBe('second reply');
  }, 90_000);
});
