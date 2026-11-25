import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openShipmates } from 'shipmates';
import { startHarness, type Harness } from './harness.js';
import {
  MAX_CLOSED,
  MAX_CLOSE_FILES,
  ClosedCapError,
  ClosedUnavailableError,
  applyClose,
  applyReopen,
  applyReopenBatch,
  closeSessions,
  enforceClosedCap,
  forgetClosed,
  getClosedEntry,
  isSessionClosed,
  parseClosed,
  readClosedSet,
  reopenSessions,
  serializeClosed,
  validateCloseInput,
  type ClosedSession,
} from '../src/session-closed.js';

/**
 * Closed sessions (`POST /sessions/close`, the `closed` flag on `/sessions`,
 * ADR 0025). Closing hides a finished session without deleting it; the store is
 * server-side like stars, and the ONE writer of `closed-sessions.json`.
 *
 * Isolation: every server gets temp `WHEREVER_CONFIG_DIR` and
 * `WHEREVER_STATE_DIR`; the in-process store tests point `WHEREVER_STATE_DIR` at
 * a temp dir; the REAL `~/.wherever` (found through `os.userInfo()`, which
 * ignores HOME) is asserted untouched.
 */

const REAL_WHEREVER_DIR = path.join(os.userInfo().homedir, '.wherever');
const snapshot = (d: string) => {
  try {
    return fs
      .readdirSync(d)
      .sort()
      .map((n) => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`)
      .join(',');
  } catch {
    return 'ABSENT';
  }
};
const realBefore = snapshot(REAL_WHEREVER_DIR);

let harness: Harness | undefined;
const tmpDirs: string[] = [];
const savedStateDir = process.env.WHEREVER_STATE_DIR;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  if (savedStateDir === undefined) delete process.env.WHEREVER_STATE_DIR;
  else process.env.WHEREVER_STATE_DIR = savedStateDir;
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

afterAll(() => {
  expect(snapshot(REAL_WHEREVER_DIR)).toBe(realBefore);
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A server whose config and state dirs are temp dirs of this test. */
async function start(config?: unknown): Promise<{ h: Harness; stateDir: string; configDir: string }> {
  const configDir = tmpDir('wherever-closed-config-');
  const stateDir = tmpDir('wherever-closed-state-');
  if (config) fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir } });
  return { h: harness, stateDir, configDir };
}

async function api(
  port: number,
  pathname: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
      : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const close = (h: Harness, sessionFile: string, closed = true) =>
  api(h.port, '/sessions/close', { method: 'POST', body: { sessionFile, closed } });

/** Write a minimal session transcript under the harness's sessions dir. */
function writeSession(h: Harness, id: string, folder = '--workspace--'): string {
  const dir = path.join(h.agentDir, 'sessions', folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'session', id, cwd: h.workspace, timestamp: new Date().toISOString() }),
    JSON.stringify({
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: `hello from ${id}` },
    }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function listedSession(body: any, file: string): any {
  for (const folder of body.folders) {
    for (const s of folder.sessions) if (s.path === path.resolve(file)) return s;
  }
  return undefined;
}

const readStore = (stateDir: string) =>
  JSON.parse(fs.readFileSync(path.join(stateDir, 'closed-sessions.json'), 'utf8')) as {
    closed: ClosedSession[];
  };

describe('/sessions/close endpoint', () => {
  it('closes a session server-side, lists it with closed: true, broadcasts, and reopens it', async () => {
    const { h, stateDir } = await start();
    const file = writeSession(h, 'done');
    const web = await h.connect();
    await new Promise((r) => setTimeout(r, 1200)); // past the sessions_updated throttle window

    const res = await close(h, file);
    expect(res.status).toBe(200);
    expect(res.body.batch).toMatch(/^c_[0-9a-f]+$/);
    expect(res.body.sessions).toEqual([path.resolve(file)]);
    await web.waitForType('sessions_updated', 10_000);

    // Still returned (the client hides it), flagged closed.
    expect(listedSession((await api(h.port, '/sessions')).body, file)?.closed).toBe(true);
    const onDisk = readStore(stateDir);
    expect(onDisk.closed).toEqual([
      { sessionFile: path.resolve(file), closedAt: expect.any(Number), batch: res.body.batch },
    ]);
    // The transcript is untouched.
    expect(fs.existsSync(file)).toBe(true);

    // Idempotent: a repeated close keeps the original entry and closes nothing new.
    const again = await close(h, file);
    expect(again.status).toBe(200);
    expect(again.body.batch).not.toBe(res.body.batch);
    expect(again.body.sessions).toEqual([]);
    expect(readStore(stateDir).closed[0].batch).toBe(res.body.batch);

    const reopen = await close(h, file, false);
    expect(reopen.status).toBe(200);
    expect(reopen.body).toEqual({ batch: null, sessions: [path.resolve(file)] });
    expect(listedSession((await api(h.port, '/sessions')).body, file)?.closed).toBeUndefined();
    web.close();
  }, 60_000);

  it('refuses a path outside the sessions directory and a non-boolean flag', async () => {
    const { h } = await start();
    expect((await close(h, '/etc/passwd.jsonl')).status).toBe(400);
    const file = writeSession(h, 's');
    const bad = await api(h.port, '/sessions/close', { method: 'POST', body: { sessionFile: file, closed: 'yes' } });
    expect(bad.status).toBe(400);
  }, 60_000);

  it('never clobbers an unreadable store, and the listing still works', async () => {
    const { h, stateDir } = await start();
    const storePath = path.join(stateDir, 'closed-sessions.json');
    fs.writeFileSync(storePath, '{not json');
    const file = writeSession(h, 's');
    expect((await close(h, file)).status).toBe(500);
    expect(fs.readFileSync(storePath, 'utf8')).toBe('{not json');
    const listed = await api(h.port, '/sessions');
    expect(listed.status).toBe(200);
    expect(listedSession(listed.body, file)).toBeDefined();
  }, 60_000);

  it('a closed session is NOT retention-exempt (sessions.maxSessions)', async () => {
    const { h } = await start({ sessions: { maxSessions: 1 } });
    const older = writeSession(h, 'older');
    const newer = writeSession(h, 'newer');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);
    expect((await close(h, older)).status).toBe(200);
    const listed = (await api(h.port, '/sessions')).body;
    expect(listedSession(listed, newer)).toBeDefined();
    expect(listedSession(listed, older)).toBeUndefined();
    // A star, by contrast, keeps it: the exemption stays stars-only.
    await api(h.port, '/sessions/star', { method: 'POST', body: { sessionFile: older, starred: true } });
    expect(listedSession((await api(h.port, '/sessions')).body, older)?.starred).toBe(true);
  }, 60_000);
});

describe('close and star are exclusive', () => {
  it('closing a starred session unstars it and records unstarred: true', async () => {
    const { h, stateDir } = await start();
    const file = writeSession(h, 'starred');
    await api(h.port, '/sessions/star', { method: 'POST', body: { sessionFile: file, starred: true } });
    expect((await close(h, file)).status).toBe(200);
    const s = listedSession((await api(h.port, '/sessions')).body, file);
    expect(s?.closed).toBe(true);
    expect(s?.starred).toBeUndefined();
    expect(readStore(stateDir).closed[0].unstarred).toBe(true);
    const stars = JSON.parse(fs.readFileSync(path.join(stateDir, 'starred-sessions.json'), 'utf8'));
    expect(stars.starred).toEqual([]);
  }, 60_000);

  it('a close of an unstarred session records no unstarred flag', async () => {
    const { h, stateDir } = await start();
    const file = writeSession(h, 'plain');
    await close(h, file);
    expect(readStore(stateDir).closed[0]).not.toHaveProperty('unstarred');
  }, 60_000);

  it('starring a closed session reopens it', async () => {
    const { h, stateDir } = await start();
    const file = writeSession(h, 'closed');
    await close(h, file);
    const star = await api(h.port, '/sessions/star', { method: 'POST', body: { sessionFile: file, starred: true } });
    expect(star.status).toBe(200);
    const s = listedSession((await api(h.port, '/sessions')).body, file);
    expect(s?.starred).toBe(true);
    expect(s?.closed).toBeUndefined();
    expect(readStore(stateDir).closed).toEqual([]);
  }, 60_000);

  it('a corrupt stars file does not block a close', async () => {
    const { h, stateDir } = await start();
    const starsPath = path.join(stateDir, 'starred-sessions.json');
    fs.writeFileSync(starsPath, '{not json');
    const file = writeSession(h, 's');
    expect((await close(h, file)).status).toBe(200);
    expect(listedSession((await api(h.port, '/sessions')).body, file)?.closed).toBe(true);
    expect(fs.readFileSync(starsPath, 'utf8')).toBe('{not json');
  }, 60_000);
});

describe('cascading close and batch undo (ADR 0025)', () => {
  /**
   * owner -> child (another folder) -> grandchild, and owner -> shut (already
   * closed, so not part of a later batch). Ownership goes in this file's
   * SHIPMATES_STATE_DIR (setup-isolate-env.ts), which the server opens too.
   */
  async function orchestration() {
    const { h, stateDir } = await start();
    const owner = writeSession(h, 'owner');
    const child = writeSession(h, 'child', '--worktree-a--');
    const grandchild = writeSession(h, 'grandchild', '--worktree-b--');
    const shut = writeSession(h, 'shut');
    const k = openShipmates();
    k.recordOwnership({ session: child, owner, folder: '/w/a', via: 'host' });
    k.recordOwnership({ session: grandchild, owner: child, folder: '/w/b', via: 'host' });
    k.recordOwnership({ session: shut, owner, folder: '/w/a', via: 'host' });
    k.close();
    return { h, stateDir, owner, child, grandchild, shut };
  }

  const owned = (h: Harness, file: string) =>
    api(h.port, `/sessions/owned?sessionFile=${encodeURIComponent(file)}`);

  /** shipmates opens in the background after the server starts. */
  async function untilOwned(h: Harness, file: string, n: number) {
    const deadline = Date.now() + 20_000;
    let body: any;
    while (Date.now() < deadline) {
      body = (await owned(h, file)).body;
      if (body.sessions?.length === n) return body;
      await new Promise((r) => setTimeout(r, 100));
    }
    return body;
  }

  it('/sessions/owned answers the true N: the owned subtree a cascade would close, not what is listed', async () => {
    const { h, owner, child, grandchild, shut } = await orchestration();
    expect((await untilOwned(h, owner, 3)).sessions.sort()).toEqual([child, grandchild, shut].sort());
    // An already closed member would not be closed again: not counted.
    await close(h, shut);
    expect((await owned(h, owner)).body.sessions.sort()).toEqual([child, grandchild].sort());
    expect((await owned(h, grandchild)).body.sessions).toEqual([]);
    expect((await owned(h, '/etc/passwd.jsonl')).status).toBe(400);
  }, 60_000);

  it('a cascade closes the session and its transitive subtree as one batch; the batch reopen restores them and their stars', async () => {
    const { h, stateDir, owner, child, grandchild, shut } = await orchestration();
    await untilOwned(h, owner, 3);
    const shutClose = await close(h, shut);
    await api(h.port, '/sessions/star', { method: 'POST', body: { sessionFile: grandchild, starred: true } });

    const res = await api(h.port, '/sessions/close', {
      method: 'POST',
      body: { sessionFile: owner, closed: true, cascade: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.batch).toMatch(/^c_[0-9a-f]+$/);
    expect(res.body.sessions.sort()).toEqual([owner, child, grandchild].sort());
    const byFile = new Map(readStore(stateDir).closed.map((s) => [s.sessionFile, s]));
    for (const f of [owner, child, grandchild]) expect(byFile.get(f)?.batch).toBe(res.body.batch);
    expect(byFile.get(grandchild)?.unstarred).toBe(true);
    // Already closed before: keeps its own batch.
    expect(byFile.get(shut)?.batch).toBe(shutClose.body.batch);
    const listed = (await api(h.port, '/sessions')).body;
    expect(listedSession(listed, grandchild)).toMatchObject({ closed: true });
    expect(listedSession(listed, grandchild)?.starred).toBeUndefined();

    const undo = await api(h.port, '/sessions/close', { method: 'POST', body: { batch: res.body.batch, closed: false } });
    expect(undo.status).toBe(200);
    expect(undo.body.batch).toBe(res.body.batch);
    expect(undo.body.sessions.sort()).toEqual([owner, child, grandchild].sort());
    expect(readStore(stateDir).closed.map((s) => s.sessionFile)).toEqual([shut]);
    const after = (await api(h.port, '/sessions')).body;
    expect(listedSession(after, grandchild)?.starred).toBe(true);
    expect(listedSession(after, grandchild)?.closed).toBeUndefined();
    expect(listedSession(after, owner)?.starred).toBeUndefined();
  }, 60_000);

  it('the undo of a single close restores the star it removed', async () => {
    const { h, stateDir } = await start();
    const file = writeSession(h, 'starred');
    await api(h.port, '/sessions/star', { method: 'POST', body: { sessionFile: file, starred: true } });
    const res = await close(h, file);
    const undo = await api(h.port, '/sessions/close', { method: 'POST', body: { batch: res.body.batch, closed: false } });
    expect(undo.body).toEqual({ batch: res.body.batch, sessions: [path.resolve(file)] });
    expect(readStore(stateDir).closed).toEqual([]);
    expect(listedSession((await api(h.port, '/sessions')).body, file)?.starred).toBe(true);
    // An unknown (or already undone) batch reopens nothing.
    const again = await api(h.port, '/sessions/close', { method: 'POST', body: { batch: res.body.batch, closed: false } });
    expect(again.body).toEqual({ batch: res.body.batch, sessions: [] });
  }, 60_000);

  it('sessionFiles closes many sessions as ONE batch (no cascade), clears their stars, and the batch undo reopens all and restores the stars', async () => {
    const { h, stateDir, owner, child, shut } = await orchestration();
    await untilOwned(h, owner, 3);
    const a = writeSession(h, 'a');
    const b = writeSession(h, 'b');
    const shutClose = await close(h, shut);
    await api(h.port, '/sessions/star', { method: 'POST', body: { sessionFile: a, starred: true } });

    // `owner` owns `child` (another folder): a folder close does not cascade.
    const res = await api(h.port, '/sessions/close', {
      method: 'POST',
      body: { sessionFiles: [a, b, owner, shut, a], closed: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.batch).toMatch(/^c_[0-9a-f]+$/);
    // The sessions it newly closed: the already closed `shut` and the duplicate are not listed.
    expect(res.body.sessions.sort()).toEqual([a, b, owner].sort());
    const byFile = new Map(readStore(stateDir).closed.map((s) => [s.sessionFile, s]));
    for (const f of [a, b, owner]) expect(byFile.get(f)?.batch).toBe(res.body.batch);
    expect(byFile.get(a)?.unstarred).toBe(true);
    expect(byFile.get(b)).not.toHaveProperty('unstarred');
    expect(byFile.get(shut)?.batch).toBe(shutClose.body.batch);
    expect(byFile.has(child)).toBe(false);
    const listed = (await api(h.port, '/sessions')).body;
    expect(listedSession(listed, a)).toMatchObject({ closed: true });
    expect(listedSession(listed, a)?.starred).toBeUndefined();

    const undo = await api(h.port, '/sessions/close', { method: 'POST', body: { batch: res.body.batch, closed: false } });
    expect(undo.status).toBe(200);
    expect(undo.body.sessions.sort()).toEqual([a, b, owner].sort());
    expect(readStore(stateDir).closed.map((s) => s.sessionFile)).toEqual([shut]);
    const after = (await api(h.port, '/sessions')).body;
    expect(listedSession(after, a)?.starred).toBe(true);
    expect(listedSession(after, a)?.closed).toBeUndefined();
    expect(listedSession(after, b)?.closed).toBeUndefined();
  }, 60_000);

  it('sessionFiles refuses an over-long list, a path outside the sessions dir (closing nothing), and the wrong shapes', async () => {
    const { h, stateDir } = await start();
    const a = writeSession(h, 'a');
    const post = (body: unknown) => api(h.port, '/sessions/close', { method: 'POST', body });
    const tooMany = Array.from({ length: MAX_CLOSE_FILES + 1 }, () => a);
    expect((await post({ sessionFiles: tooMany, closed: true })).status).toBe(400);
    const outside = await post({ sessionFiles: [a, '/etc/passwd.jsonl'], closed: true });
    expect(outside.status).toBe(400);
    expect(fs.existsSync(path.join(stateDir, 'closed-sessions.json'))).toBe(false);
    expect((await post({ sessionFiles: [], closed: true })).status).toBe(400);
    expect((await post({ sessionFiles: [a], closed: false })).status).toBe(400);
    expect((await post({ sessionFiles: [a], closed: true, cascade: true })).status).toBe(400);
    expect((await post({ sessionFiles: [a], sessionFile: a, closed: true })).status).toBe(400);
    expect((await post({ sessionFiles: [a, 3], closed: true })).status).toBe(400);
    expect(listedSession((await api(h.port, '/sessions')).body, a)?.closed).toBeUndefined();
  }, 60_000);

  it('refuses cascade on a reopen and a batch on a close', async () => {
    const { h } = await start();
    const file = writeSession(h, 's');
    const post = (body: unknown) => api(h.port, '/sessions/close', { method: 'POST', body });
    expect((await post({ sessionFile: file, closed: false, cascade: true })).status).toBe(400);
    expect((await post({ batch: 'c_00', closed: true })).status).toBe(400);
    expect((await post({ batch: 'nope', closed: false })).status).toBe(400);
  }, 60_000);
});

describe('deleting a session drops its close flag', () => {
  it('the direct /session/delete', async () => {
    const { h, stateDir } = await start();
    const file = writeSession(h, 'doomed');
    await close(h, file);
    const del = await api(h.port, '/session/delete', { method: 'POST', body: { sessionFile: file } });
    expect(del.status).toBe(200);
    expect(readStore(stateDir).closed).toEqual([]);
  }, 60_000);

  it('the purge of a cascaded delete whose undo window passed', async () => {
    const configDir = tmpDir('wherever-closed-config-');
    const stateDir = tmpDir('wherever-closed-state-');
    const sessions = tmpDir('wherever-closed-sessions-');
    const owner = path.join(sessions, 'owner.jsonl');
    const child = path.join(sessions, 'child.jsonl');
    const kept = path.join(sessions, 'kept.jsonl');
    fs.writeFileSync(
      path.join(stateDir, 'closed-sessions.json'),
      serializeClosed([owner, child, kept].map((sessionFile) => ({ sessionFile, closedAt: 1 }))),
    );
    // shipmates' database (this file's SHIPMATES_STATE_DIR) holding a cascaded
    // delete made 8 days ago, and wherever's record of that batch.
    const eightDaysAgo = Date.now() - 8 * 86_400_000;
    const k = openShipmates({ now: () => eightDaysAgo });
    k.recordOwnership({ session: child, owner, folder: sessions, via: 'host' });
    const r = k.archive(owner, { kind: 'deleted', by: 'web' });
    k.close();
    fs.writeFileSync(
      path.join(stateDir, 'shipmates-archives.json'),
      JSON.stringify({ batches: [{ batch: r.batch, root: owner, sessions: [owner, child], at: r.at, undoUntil: r.undoUntil }] }),
    );

    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir } });
    // The purge runs once shipmates is open; wait for it.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && readStore(stateDir).closed.length > 1) {
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(readStore(stateDir).closed.map((s) => s.sessionFile)).toEqual([kept]);
  }, 60_000);
});

describe('closed-sessions store (in process)', () => {
  const useStateDir = () => {
    const dir = tmpDir('wherever-closed-store-');
    process.env.WHEREVER_STATE_DIR = dir;
    return dir;
  };

  it('round-trips through the file, including unstarred, and keeps an in-memory set per file', () => {
    const dir = useStateDir();
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    const r = closeSessions([a, b], { now: 10, unstarred: (f) => f === a });
    expect(r.sessions.sort()).toEqual([a, b].sort());
    expect(isSessionClosed(a)).toBe(true);
    expect(readClosedSet()).toEqual(new Set([a, b]));
    expect(getClosedEntry(a)).toEqual({ sessionFile: a, closedAt: 10, batch: r.batch, unstarred: true });
    expect(getClosedEntry(b)).toEqual({ sessionFile: b, closedAt: 10, batch: r.batch });
    expect(fs.statSync(path.join(dir, 'closed-sessions.json')).mode & 0o777).toBe(0o600);

    // Another state dir: a fresh set, not the cached one.
    useStateDir();
    expect(isSessionClosed(a)).toBe(false);
    process.env.WHEREVER_STATE_DIR = dir;
    expect(isSessionClosed(a)).toBe(true);

    expect(reopenSessions([a, path.join(dir, 'never.jsonl')])).toEqual([a]);
    expect(isSessionClosed(a)).toBe(false);
    forgetClosed(b);
    expect(readClosedSet().size).toBe(0);
  });

  it('a corrupt file fails closed on mutation and lists as nothing closed', () => {
    const dir = useStateDir();
    const store = path.join(dir, 'closed-sessions.json');
    fs.writeFileSync(store, '{not json');
    const err = console.error;
    console.error = () => {};
    try {
      expect(() => closeSessions([path.join(dir, 'a.jsonl')])).toThrow(ClosedUnavailableError);
      expect(() => reopenSessions([path.join(dir, 'a.jsonl')])).toThrow(ClosedUnavailableError);
      expect(readClosedSet().size).toBe(0);
      forgetClosed(path.join(dir, 'a.jsonl')); // best effort: no throw
    } finally {
      console.error = err;
    }
    expect(fs.readFileSync(store, 'utf8')).toBe('{not json');
  });
});

describe('closed list transforms', () => {
  it('reports a corrupt file as UNKNOWN (null), never as empty', () => {
    expect(parseClosed('{not json')).toBeNull();
    expect(parseClosed('{"other": 1}')).toBeNull();
    expect(parseClosed('[]')).toBeNull();
    expect(parseClosed('')).toEqual([]);
  });

  it('round-trips and dedupes by path, keeping the latest; unstarred only when true', () => {
    const raw = JSON.stringify({
      version: 1,
      closed: [
        { sessionFile: '/a.jsonl', closedAt: 1 },
        { sessionFile: '/a.jsonl', closedAt: 5, batch: 'c_x', unstarred: true },
        { sessionFile: '/b.jsonl', closedAt: 3, unstarred: false },
        { nope: true },
      ],
    });
    const parsed = parseClosed(raw)!;
    expect(parsed).toEqual([
      { sessionFile: '/a.jsonl', closedAt: 5, batch: 'c_x', unstarred: true },
      { sessionFile: '/b.jsonl', closedAt: 3 },
    ]);
    expect(parseClosed(serializeClosed(parsed))).toEqual(parsed);
  });

  it('a re-close keeps the original entry; reopen removes', () => {
    let { list, closed } = applyClose([], ['/a.jsonl'], { batch: 'c_1', now: 10 });
    expect(closed).toEqual(['/a.jsonl']);
    ({ list, closed } = applyClose(list, ['/a.jsonl', '/b.jsonl'], { batch: 'c_2', now: 20 }));
    expect(closed).toEqual(['/b.jsonl']);
    expect(list).toEqual([
      { sessionFile: '/b.jsonl', closedAt: 20, batch: 'c_2' },
      { sessionFile: '/a.jsonl', closedAt: 10, batch: 'c_1' },
    ]);
    expect(applyReopen(list, ['/b.jsonl'])).toEqual({
      list: [{ sessionFile: '/a.jsonl', closedAt: 10, batch: 'c_1' }],
      reopened: ['/b.jsonl'],
    });
  });

  it('at the cap prunes only entries whose transcript is gone, and refuses otherwise', () => {
    const limits = { maxEntries: 3, maxBytes: 1_000_000 };
    const list: ClosedSession[] = ['/a', '/b', '/c', '/new'].map((f, i) => ({ sessionFile: `${f}.jsonl`, closedAt: i }));
    const gone = new Set(['/b.jsonl']);
    const protect = new Set(['/new.jsonl']);
    const pruned = enforceClosedCap(list, protect, (f) => !gone.has(f), limits);
    expect(pruned.map((s) => s.sessionFile)).toEqual(['/a.jsonl', '/c.jsonl', '/new.jsonl']);
    // Every transcript exists: refused, nothing dropped.
    expect(() => enforceClosedCap(list, protect, () => true, limits)).toThrow(ClosedCapError);
    // The session being closed is never pruned, even if its file is not written yet.
    expect(() => enforceClosedCap(list, protect, (f) => f === '/a.jsonl' || f === '/b.jsonl' || f === '/c.jsonl', limits)).toThrow(
      ClosedCapError,
    );
    // Under the cap: untouched, whatever exists.
    expect(enforceClosedCap(list.slice(0, 3), new Set(), () => false, limits)).toHaveLength(3);
    // The byte cap counts too.
    expect(() => enforceClosedCap(list.slice(0, 2), new Set(), () => true, { maxEntries: 100, maxBytes: 50 })).toThrow(
      ClosedCapError,
    );
  });

  it('the default cap is MAX_CLOSED entries', () => {
    const list: ClosedSession[] = [];
    for (let i = 0; i <= MAX_CLOSED; i++) list.push({ sessionFile: `/s/${i}.jsonl`, closedAt: i });
    expect(() => enforceClosedCap(list, new Set(), () => true)).toThrow(ClosedCapError);
    expect(enforceClosedCap(list, new Set(), (f) => f !== '/s/0.jsonl')).toHaveLength(MAX_CLOSED);
  });

  it('validates input in one place', () => {
    expect(validateCloseInput({ sessionFile: '/a.jsonl', closed: true })).toBeNull();
    expect(validateCloseInput({ closed: true })).not.toBeNull();
    expect(validateCloseInput({ sessionFile: '/a.jsonl' })).not.toBeNull();
    expect(validateCloseInput({ sessionFile: '/a.jsonl', closed: true, cascade: true })).toBeNull();
    expect(validateCloseInput({ sessionFile: '/a.jsonl', closed: false, cascade: true })).not.toBeNull();
    expect(validateCloseInput({ batch: 'c_0123abcd', closed: false })).toBeNull();
    expect(validateCloseInput({ batch: 'c_0123abcd', closed: true })).not.toBeNull();
    expect(validateCloseInput({ batch: 'c_0123abcd', sessionFile: '/a.jsonl', closed: false })).not.toBeNull();
    expect(validateCloseInput({ batch: '../x', closed: false })).not.toBeNull();
    // The folder close: a bounded list of paths, close only, no cascade.
    expect(validateCloseInput({ sessionFiles: ['/a.jsonl', '/b.jsonl'], closed: true })).toBeNull();
    expect(validateCloseInput({ sessionFiles: [], closed: true })).not.toBeNull();
    expect(validateCloseInput({ sessionFiles: '/a.jsonl', closed: true })).not.toBeNull();
    expect(validateCloseInput({ sessionFiles: ['/a.jsonl', ''], closed: true })).not.toBeNull();
    expect(validateCloseInput({ sessionFiles: ['x'.repeat(5000)], closed: true })).not.toBeNull();
    expect(validateCloseInput({ sessionFiles: ['/a.jsonl'], closed: false })).not.toBeNull();
    expect(validateCloseInput({ sessionFiles: ['/a.jsonl'], closed: true, cascade: true })).not.toBeNull();
    expect(validateCloseInput({ sessionFiles: ['/a.jsonl'], sessionFile: '/a.jsonl', closed: true })).not.toBeNull();
    expect(validateCloseInput({ sessionFiles: ['/a.jsonl'], batch: 'c_01', closed: false })).not.toBeNull();
    const max = Array.from({ length: MAX_CLOSE_FILES }, (_, i) => `/${i}.jsonl`);
    expect(validateCloseInput({ sessionFiles: max, closed: true })).toBeNull();
    expect(validateCloseInput({ sessionFiles: [...max, '/x.jsonl'], closed: true })).not.toBeNull();
  });

  it('applyReopenBatch removes exactly one batch and returns its entries', () => {
    const list: ClosedSession[] = [
      { sessionFile: '/a.jsonl', closedAt: 2, batch: 'c_1', unstarred: true },
      { sessionFile: '/b.jsonl', closedAt: 2, batch: 'c_1' },
      { sessionFile: '/c.jsonl', closedAt: 1, batch: 'c_2' },
      { sessionFile: '/d.jsonl', closedAt: 0 },
    ];
    const r = applyReopenBatch(list, 'c_1');
    expect(r.reopened.map((s) => s.sessionFile)).toEqual(['/a.jsonl', '/b.jsonl']);
    expect(r.list.map((s) => s.sessionFile)).toEqual(['/c.jsonl', '/d.jsonl']);
  });
});
