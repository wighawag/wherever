import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';
import {
  MAX_STARRED,
  applyStar,
  parseStars,
  serializeStars,
  validateStarInput,
  type StarredSession,
} from '../src/session-stars.js';

/**
 * Starred sessions (`POST /sessions/star`, the `starred` flag on `/sessions`).
 *
 * The flow this exists for: a session writes a prompt that the user launches in
 * a new session; the new one takes the top of the list, so the user stars the
 * first one to remember to come back to it. Like drafts, the store is
 * SERVER-SIDE so a star set on one device is visible on every other.
 */

let harness: Harness | undefined;
const tmpDirs: string[] = [];

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-stars-'));
  tmpDirs.push(dir);
  return dir;
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

/** Write a minimal session transcript under the harness's sessions dir. */
function writeSession(h: Harness, id: string): string {
  const dir = path.join(h.agentDir, 'sessions', '--workspace--');
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

describe('/sessions/star endpoint', () => {
  it('stars a session server-side, reports it on /sessions, and unstars it', async () => {
    const configDir = makeConfigDir();
    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir } });
    const file = writeSession(harness, 'parent');

    expect(listedSession((await api(harness.port, '/sessions')).body, file)?.starred).toBeUndefined();

    const res = await api(harness.port, '/sessions/star', {
      method: 'POST',
      body: { sessionFile: file, starred: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.starred.map((s: StarredSession) => s.sessionFile)).toEqual([path.resolve(file)]);
    expect(listedSession((await api(harness.port, '/sessions')).body, file)?.starred).toBe(true);

    // It is a file on the server, not browser state.
    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, 'starred-sessions.json'), 'utf8'));
    expect(onDisk.starred[0].sessionFile).toBe(path.resolve(file));

    await api(harness.port, '/sessions/star', { method: 'POST', body: { sessionFile: file, starred: false } });
    expect(listedSession((await api(harness.port, '/sessions')).body, file)?.starred).toBeUndefined();
  }, 60_000);

  it('refuses a path outside the sessions directory and a non-boolean flag', async () => {
    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: makeConfigDir() } });
    const outside = await api(harness.port, '/sessions/star', {
      method: 'POST',
      body: { sessionFile: '/etc/passwd.jsonl', starred: true },
    });
    expect(outside.status).toBe(400);
    const file = writeSession(harness, 's');
    const bad = await api(harness.port, '/sessions/star', {
      method: 'POST',
      body: { sessionFile: file, starred: 'yes' },
    });
    expect(bad.status).toBe(400);
  }, 60_000);

  it('keeps a starred session listed past sessions.maxAgeDays', async () => {
    // A star means "come back to this": it must not silently age out of the list.
    const configDir = makeConfigDir();
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ sessions: { maxAgeDays: 1 } }));
    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir } });
    const starredFile = writeSession(harness, 'old-starred');
    const plainFile = writeSession(harness, 'old-plain');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(starredFile, old, old);
    fs.utimesSync(plainFile, old, old);

    await api(harness.port, '/sessions/star', { method: 'POST', body: { sessionFile: starredFile, starred: true } });
    const listed = (await api(harness.port, '/sessions')).body;
    expect(listedSession(listed, starredFile)?.starred).toBe(true);
    expect(listedSession(listed, plainFile)).toBeUndefined();
  }, 60_000);

  it('never clobbers an unreadable store: it refuses the write and keeps the file', async () => {
    const configDir = makeConfigDir();
    const storePath = path.join(configDir, 'starred-sessions.json');
    fs.writeFileSync(storePath, '{not json');
    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir } });
    const file = writeSession(harness, 's');

    const res = await api(harness.port, '/sessions/star', { method: 'POST', body: { sessionFile: file, starred: true } });
    expect(res.status).toBe(500);
    expect(fs.readFileSync(storePath, 'utf8')).toBe('{not json');
    // The listing still works, just without stars.
    const listed = await api(harness.port, '/sessions');
    expect(listed.status).toBe(200);
    expect(listedSession(listed.body, file)).toBeDefined();
  }, 60_000);

  it('drops the star when the session is deleted', async () => {
    const configDir = makeConfigDir();
    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir } });
    const file = writeSession(harness, 'doomed');
    await api(harness.port, '/sessions/star', { method: 'POST', body: { sessionFile: file, starred: true } });
    const del = await api(harness.port, '/session/delete', { method: 'POST', body: { sessionFile: file } });
    expect(del.status).toBe(200);
    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, 'starred-sessions.json'), 'utf8'));
    expect(onDisk.starred).toEqual([]);
  }, 60_000);
});

describe('stars list transforms', () => {
  it('reports a corrupt file as UNKNOWN (null), never as empty', () => {
    expect(parseStars('{not json')).toBeNull();
    expect(parseStars('{"other": 1}')).toBeNull();
    expect(parseStars('')).toEqual([]);
  });

  it('round-trips and dedupes by path, keeping the latest', () => {
    const raw = JSON.stringify([
      { sessionFile: '/a.jsonl', starredAt: 1 },
      { sessionFile: '/a.jsonl', starredAt: 5 },
      { sessionFile: '/b.jsonl', starredAt: 3 },
      { nope: true },
    ]);
    const parsed = parseStars(raw)!;
    expect(parsed).toEqual([
      { sessionFile: '/a.jsonl', starredAt: 5 },
      { sessionFile: '/b.jsonl', starredAt: 3 },
    ]);
    expect(parseStars(serializeStars(parsed))).toEqual(parsed);
  });

  it('re-starring keeps the original starredAt, unstarring removes', () => {
    let stars = applyStar([], '/a.jsonl', true, 10);
    stars = applyStar(stars, '/b.jsonl', true, 20);
    stars = applyStar(stars, '/a.jsonl', true, 30);
    expect(stars).toEqual([
      { sessionFile: '/b.jsonl', starredAt: 20 },
      { sessionFile: '/a.jsonl', starredAt: 10 },
    ]);
    expect(applyStar(stars, '/b.jsonl', false, 40)).toEqual([{ sessionFile: '/a.jsonl', starredAt: 10 }]);
  });

  it('caps the list, dropping the oldest star', () => {
    let stars: StarredSession[] = [];
    for (let i = 0; i <= MAX_STARRED; i++) stars = applyStar(stars, `/s${i}.jsonl`, true, i);
    expect(stars).toHaveLength(MAX_STARRED);
    expect(stars.some((s) => s.sessionFile === '/s0.jsonl')).toBe(false);
  });

  it('validates input in one place', () => {
    expect(validateStarInput({ sessionFile: '/a.jsonl', starred: true })).toBeNull();
    expect(validateStarInput({ starred: true })).not.toBeNull();
    expect(validateStarInput({ sessionFile: '/a.jsonl' })).not.toBeNull();
  });
});
