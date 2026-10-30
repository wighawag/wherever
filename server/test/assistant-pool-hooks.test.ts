import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionPool } from '../src/session-pool.ts';

/**
 * The two pool hooks the assistant controller rides on (spec
 * `assistant-session-and-channels`):
 *  - `onSessionCreated` fires on a REAL creation only: never for the
 *    existing-viewed-session return, never for a caller that joins a pending
 *    create, and a throwing callback never fails `createNewSession`;
 *  - a PINNED CLI session is exempt from idle teardown (an idle CLI session with
 *    no viewers is otherwise destroyed, and a message in its reconnect window
 *    would build a server agent on the same file). Unpinned sessions, and every
 *    server session, are evicted exactly as before.
 *
 * No LLM call is made. PI_CODING_AGENT_DIR, WHEREVER_CONFIG_DIR and
 * WHEREVER_STATE_DIR are temp dirs; the real ~/.wherever is asserted untouched.
 */

const REAL_WHEREVER_DIR = path.join(os.homedir(), '.wherever');
const snapshot = (d: string) => {
  try {
    return fs.readdirSync(d).sort().map((n) => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`).join(',');
  } catch {
    return 'ABSENT';
  }
};
let realBefore: string;
let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  realBefore = snapshot(REAL_WHEREVER_DIR);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-pool-')));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
    ['WHEREVER_STATE_DIR', 'wherever-state'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  expect(snapshot(REAL_WHEREVER_DIR)).toBe(realBefore);
});

function freshCwd(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeCliWs = () => ({ send() {}, close() {}, readyState: 1 }) as any;

describe('SessionPool.onSessionCreated', () => {
  it('fires once per real creation, with the session file and cwd', async () => {
    const pool = new SessionPool(300_000);
    const seen: Array<[string, string]> = [];
    pool.onSessionCreated = (file, cwd) => void seen.push([file, cwd]);
    const cwd = freshCwd();
    const a = await pool.createNewSession(cwd, undefined, false, false);
    const b = await pool.createNewSession(cwd, undefined, false, false, undefined, true);
    expect(seen).toEqual([
      [a.tracked.sessionFile, cwd],
      [b.tracked.sessionFile, cwd],
    ]);
    await pool.disposeAll();
  }, 30_000);

  it('does not fire when createNewSession returns the existing viewed session', async () => {
    const pool = new SessionPool(300_000);
    let count = 0;
    pool.onSessionCreated = () => void count++;
    const cwd = freshCwd();
    const a = await pool.createNewSession(cwd, undefined, false, false);
    pool.addClient(a.tracked.sessionFile, 'viewer');
    const again = await pool.createNewSession(cwd, undefined, false, false);
    expect(again.tracked.sessionFile).toBe(a.tracked.sessionFile);
    expect(count).toBe(1);
    await pool.disposeAll();
  }, 30_000);

  it('does not fire for a caller that joins a pending create', async () => {
    const pool = new SessionPool(300_000);
    let count = 0;
    pool.onSessionCreated = () => void count++;
    const cwd = freshCwd();
    const [a, b] = await Promise.all([
      pool.createNewSession(cwd, undefined, false, false),
      pool.createNewSession(cwd, undefined, false, false),
    ]);
    expect(b.tracked.sessionFile).toBe(a.tracked.sessionFile);
    expect(count).toBe(1);
    await pool.disposeAll();
  }, 30_000);

  it('a throwing (or rejecting) callback never fails createNewSession', async () => {
    const pool = new SessionPool(300_000);
    pool.onSessionCreated = () => {
      throw new Error('callback boom');
    };
    const a = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(a.error).toBeUndefined();
    expect(pool.getSession(a.tracked.sessionFile)).not.toBeNull();

    pool.onSessionCreated = (() => Promise.reject(new Error('async boom'))) as any;
    const b = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(b.error).toBeUndefined();
    await sleep(10); // an unhandled rejection would fail the run
    await pool.disposeAll();
  }, 30_000);

  it('with no callback registered, creation is unchanged', async () => {
    const pool = new SessionPool(300_000);
    const a = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(a.error).toBeUndefined();
    await pool.disposeAll();
  }, 30_000);
});

describe('SessionPool pinning (CLI idle teardown)', () => {
  it('an idle, unviewed CLI session is torn down; a pinned one is not; unpinning restores eviction', async () => {
    const pool = new SessionPool(50);
    const cwd = freshCwd();
    const pinnedFile = path.join(root, 'pinned.jsonl');
    const plainFile = path.join(root, 'plain.jsonl');
    pool.pinSession(pinnedFile);
    await pool.registerCliSession(pinnedFile, cwd, '', fakeCliWs());
    await pool.registerCliSession(plainFile, cwd, '', fakeCliWs());
    // A viewer comes and goes: removeClient arms the idle check.
    for (const f of [pinnedFile, plainFile]) {
      pool.addClient(f, 'v');
      pool.removeClient(f, 'v');
    }
    // A turn ends: agent_end arms it too.
    pool.handleCliEvent(pinnedFile, { type: 'agent_start' } as any);
    pool.handleCliEvent(pinnedFile, { type: 'agent_end' } as any);
    await sleep(200);
    expect(pool.getSession(plainFile)).toBeNull();
    expect(pool.getSession(pinnedFile)).not.toBeNull();

    pool.unpinSession(pinnedFile);
    await sleep(200);
    expect(pool.getSession(pinnedFile)).toBeNull();
    await pool.disposeAll();
  }, 30_000);

  it('a pinned SERVER session is still idle-evicted (the next send reloads it)', async () => {
    const pool = new SessionPool(50);
    const a = await pool.createNewSession(freshCwd(), undefined, false, false);
    pool.pinSession(a.tracked.sessionFile);
    pool.addClient(a.tracked.sessionFile, 'v');
    pool.removeClient(a.tracked.sessionFile, 'v');
    await sleep(250);
    expect(pool.getSession(a.tracked.sessionFile)).toBeNull();
    await pool.disposeAll();
  }, 30_000);
});

describe('SessionPool.clearQueuedMessages', () => {
  it('returns null for a session that is not resident', () => {
    const pool = new SessionPool(300_000);
    expect(pool.clearQueuedMessages(path.join(root, 'nope.jsonl'))).toBeNull();
  });

  it('returns empty queues for an idle server session', async () => {
    const pool = new SessionPool(300_000);
    const a = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(pool.clearQueuedMessages(a.tracked.sessionFile)).toEqual({ steering: [], followUp: [] });
    await pool.disposeAll();
  }, 30_000);
});
