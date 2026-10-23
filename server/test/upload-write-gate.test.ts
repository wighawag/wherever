import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';

// The upload WRITE GATE binds an upload to the session this socket PAINTED
// (docs/adr/0012), not merely to whatever it is attached to:
//
//  - the old gate checked the ATTACHED session's read-only verdict but wrote into
//    `msg.sessionId`'s folder, so a socket on a writable session A could drop a
//    file into session B's folder;
//  - the target folder came from `pool.getSession()`, which is null while a cold
//    session's agent is still building, so the file silently went to tmp even
//    with `uploads.type: 'session'`;
//  - a slow cold build that finished after the user left (or switched away)
//    re-attached the socket to the stale session and sent its session_ready.
//
// A test-only build delay (`WHEREVER_TEST_COLD_BUILD_DELAY_MS`) holds the cold
// build open long enough that "during a cold load" is deterministic rather than
// a race against a fast machine.
//
// Every test that may write an upload sets `uploads.type: 'session'` in its OWN
// config dir, so nothing is written to the real os.tmpdir(); and the AMBIENT
// state dir (what the server would use without the harness) is checked to be
// untouched.

const BUILD_DELAY_MS = 2_500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAYLOAD_TEXT = 'gate test payload\n';
const PAYLOAD = Buffer.from(PAYLOAD_TEXT).toString('base64');

// The state dir the server would resolve WITHOUT the harness's isolation (see
// getWhereverStateDir): an explicit WHEREVER_STATE_DIR, else the config dir,
// else ~/.wherever. On a deployed box this is a LIVE server's dir, so it is
// compared by entry names only (a concurrent drafts write must not flake this),
// ignoring the transient `.tmp` sibling of an atomic write.
const ambientStateDir = (() => {
  const state = process.env.WHEREVER_STATE_DIR?.trim();
  if (state) return path.resolve(state);
  const config = process.env.WHEREVER_CONFIG_DIR?.trim();
  if (config) return path.resolve(config);
  return path.join(os.homedir(), '.wherever');
})();
function snapshotAmbient(): string[] {
  try {
    return fs
      .readdirSync(ambientStateDir)
      .filter((n) => !n.endsWith('.tmp'))
      .sort();
  } catch {
    return ['<absent>'];
  }
}
let ambientBefore: string[];
beforeAll(() => {
  ambientBefore = snapshotAmbient();
});
afterAll(() => {
  expect(snapshotAmbient()).toEqual(ambientBefore);
});

let h: Harness | undefined;
let configDir: string | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

/** Boot a harness whose wherever config is `config` (in a throwaway dir). */
async function boot(config: object, opts?: { idleTimeoutMs?: number; delay?: boolean }): Promise<Harness> {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-upload-gate-cfg-'));
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  return startHarness({
    initial: { kind: 'reply', text: 'hi' },
    idleTimeoutMs: opts?.idleTimeoutMs ?? 0,
    env: {
      WHEREVER_CONFIG_DIR: configDir,
      ...(opts?.delay ? { WHEREVER_TEST_COLD_BUILD_DELAY_MS: String(BUILD_DELAY_MS) } : {}),
    },
  });
}

/** Create a session in `cwd` and give it one real turn, so it has history and a cwd on disk. */
async function seedSession(harness: Harness, cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  const c = await harness.connect();
  await c.waitForType('connected');
  c.send({ type: 'session_new', cwd });
  const created = await c.waitForType('session_created');
  c.send({ type: 'message', message: 'hello', sessionId: created.sessionId });
  await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant');
  await c.waitForType('agent_end');
  return { c, sessionFile: created.sessionFile as string, sessionId: created.sessionId as string };
}

/** Seed a session, then drop its only viewer so it is idle-evicted (cold). */
async function seedColdSession(harness: Harness, cwd: string) {
  const s = await seedSession(harness, cwd);
  s.c.close();
  await sleep(400);
  return s;
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true } as any) as any[]) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path ?? dir, entry.name));
  }
  return out;
}

function upload(c: TestClient, uploadId: string, sessionId: string, data = PAYLOAD) {
  c.send({ type: 'file_upload', uploadId, sessionId, filename: 'note.txt', data });
  return c.waitFor(
    (m) => (m.type === 'file_uploaded' || m.type === 'file_upload_error') && m.uploadId === uploadId,
    20_000,
  );
}

describe('upload write gate binds to the painted session', () => {
  it('refuses an upload for a session other than the one this socket is on, and writes nothing there', async () => {
    h = await boot({ uploads: { type: 'session' } }, { idleTimeoutMs: 60_000 });
    const projA = path.join(h.workspace, 'proj-a');
    const projB = path.join(h.workspace, 'proj-b');
    // B stays resident (its seeding viewer stays connected), so the old handler
    // could resolve its cwd and write into it.
    const b = await seedSession(h, projB);

    fs.mkdirSync(projA, { recursive: true });
    const a = await h.connect();
    await a.waitForType('connected');
    a.send({ type: 'session_new', cwd: projA });
    const created = await a.waitForType('session_created');
    expect(created.readOnly).toBeFalsy();
    const before = filesUnder(projB);

    const reply = await upload(a, 'cross', b.sessionId);
    expect(reply.type).toBe('file_upload_error');
    expect(String(reply.error)).toMatch(/not for the session this connection is on/i);
    expect(filesUnder(projB)).toEqual(before);

    // The same socket can still upload into ITS session.
    const own = await upload(a, 'own', created.sessionId as string);
    expect(own.type).toBe('file_uploaded');
    expect(String(own.savedPath).startsWith(path.join(projA, '.wherever', 'uploads'))).toBe(true);
  }, 90_000);

  it('accepts an upload during a cold load and lands it in the session upload dir, before session_ready', async () => {
    h = await boot({ uploads: { type: 'session' } }, { delay: true });
    const proj = path.join(h.workspace, 'cold-project');
    const { sessionFile } = await seedColdSession(h, proj);

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_load', sessionFile });
    const painted = await c.waitForType('session_created', 10_000);
    expect(painted.pending).toBe(true); // only meaningful when cold
    expect(painted.readOnly).toBeFalsy();

    const reply = await upload(c, 'cold', painted.sessionId as string);
    expect(reply.type).toBe('file_uploaded');
    // Arrived while the agent was still building: without the fix the target
    // dir was resolved from the (absent) live session and fell back to tmp.
    expect(c.messages.some((m) => m.type === 'session_ready')).toBe(false);
    const saved = String(reply.savedPath);
    expect(saved.startsWith(path.join(proj, '.wherever', 'uploads') + path.sep)).toBe(true);
    expect(fs.readFileSync(saved, 'utf8')).toBe(PAYLOAD_TEXT);

    const ready = await c.waitForType('session_ready', 30_000);
    expect(ready.sessionId).toBe(painted.sessionId);
    const iUploaded = c.messages.findIndex((m) => m.type === 'file_uploaded');
    const iReady = c.messages.findIndex((m) => m.type === 'session_ready');
    expect(iUploaded).toBeLessThan(iReady);
  }, 90_000);

  it('a leave during a cold load prevents the late attach: no stale session_ready, uploads refused', async () => {
    h = await boot({ uploads: { type: 'session' } }, { delay: true });
    const proj = path.join(h.workspace, 'left-project');
    const { sessionFile } = await seedColdSession(h, proj);

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_load', sessionFile });
    const painted = await c.waitForType('session_created', 10_000);
    expect(painted.pending).toBe(true);
    c.send({ type: 'session_leave', sessionId: painted.sessionId });

    // Outlast the delayed build (plus the real build after it).
    await sleep(BUILD_DELAY_MS + 4_000);
    expect(c.messages.some((m) => m.type === 'session_ready')).toBe(false);
    expect(c.messages.some((m) => m.type === 'session_error')).toBe(false);

    // Had the stale build re-attached the socket, this would be accepted.
    const before = filesUnder(proj);
    const reply = await upload(c, 'after-leave', painted.sessionId as string);
    expect(reply.type).toBe('file_upload_error');
    expect(filesUnder(proj)).toEqual(before);
  }, 90_000);

  it('a switch during a cold load prevents the late attach of the first session', async () => {
    h = await boot({ uploads: { type: 'session' } }, { delay: true });
    const projA = path.join(h.workspace, 'switch-a');
    const projB = path.join(h.workspace, 'switch-b');
    const a = await seedColdSession(h, projA);
    const b = await seedColdSession(h, projB);

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_load', sessionFile: a.sessionFile });
    const paintedA = await c.waitFor((m) => m.type === 'session_created' && m.sessionId === a.sessionId, 10_000);
    expect(paintedA.pending).toBe(true);
    c.send({ type: 'session_load', sessionFile: b.sessionFile });
    const readyB = await c.waitFor((m) => m.type === 'session_ready' && m.sessionId === b.sessionId, 30_000);
    expect(readyB.sessionFile).toBe(b.sessionFile);
    // A's (earlier-started) build has finished by now; give any stale tail a beat.
    await sleep(1_000);

    expect(c.messages.some((m) => m.type === 'session_ready' && m.sessionId === a.sessionId)).toBe(false);
    expect(c.messages.some((m) => m.type === 'session_error')).toBe(false);
    // The last ready the client saw is B's: nothing re-attached it to A.
    const readies = c.messages.filter((m) => m.type === 'session_ready');
    expect(readies[readies.length - 1].sessionId).toBe(b.sessionId);

    const beforeA = filesUnder(projA);
    const toA = await upload(c, 'to-a', a.sessionId);
    expect(toA.type).toBe('file_upload_error');
    expect(filesUnder(projA)).toEqual(beforeA);

    const toB = await upload(c, 'to-b', b.sessionId);
    expect(toB.type).toBe('file_uploaded');
    expect(String(toB.savedPath).startsWith(path.join(projB, '.wherever', 'uploads'))).toBe(true);
  }, 120_000);

  it('refuses an oversized legacy upload against uploads.maxBytes, with a reason', async () => {
    h = await boot({ uploads: { type: 'session', maxBytes: 8 } }, { idleTimeoutMs: 60_000 });
    const proj = path.join(h.workspace, 'size-project');
    fs.mkdirSync(proj, { recursive: true });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: proj });
    const created = await c.waitForType('session_created');

    const before = filesUnder(proj);
    const big = await upload(c, 'big', created.sessionId as string);
    expect(big.type).toBe('file_upload_error');
    expect(String(big.error)).toMatch(/too large/i);
    expect(filesUnder(proj)).toEqual(before);

    const small = await upload(c, 'small', created.sessionId as string, Buffer.from('tiny').toString('base64'));
    expect(small.type).toBe('file_uploaded');
  }, 90_000);
});
