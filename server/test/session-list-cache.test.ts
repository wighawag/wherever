import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanDiskSessions,
  clearSessionIndexCache,
  getSessionBodyReadCount,
} from '../src/session-pool.js';

// Regression: `/sessions` used to re-read and re-parse EVERY session file on
// EVERY request (fs.readFileSync + JSON.parse per line), synchronously. On a
// real sessions dir (~2800 files / 1.1 GB) that is ~7s of blocking work, and the
// dashboard refetches the list on every `sessions_updated` broadcast -- so the
// event loop was pinned and the WebSocket could not deliver the session-load
// reply, leaving "Loading session..." hanging.
//
// The scan must therefore: cache per file against (mtime, size), re-read ONLY
// what changed, evict what disappeared, and yield to the event loop.
//
// "Read" here means READING A BODY (streaming the transcript and parsing it),
// which `getSessionBodyReadCount()` reports. Asserting on an fs primitive would
// conflate that with the cheap per-folder HEADER probe, which also opens a file
// but never reads past the first line.

let root: string;

function writeSession(
  dirName: string,
  fileName: string,
  cwd: string,
  messages: string[],
): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  const lines = [
    JSON.stringify({ type: 'session', id: fileName.replace(/\.jsonl$/, ''), cwd, timestamp: new Date().toISOString() }),
    ...messages.map((text, i) =>
      JSON.stringify({
        type: 'message',
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        message: { role: i % 2 === 0 ? 'user' : 'assistant', content: text },
      }),
    ),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function appendMessage(file: string, text: string): void {
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: text },
    }) + '\n',
  );
}

const wantAll = () => true;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-sessions-'));
  clearSessionIndexCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scanDiskSessions', () => {
  it('parses session files on a cold scan', async () => {
    writeSession('proj-a', 's1.jsonl', '/tmp/proj-a', ['hello there', 'hi back']);

    const infos = await scanDiskSessions(root, wantAll, 'test');

    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe('s1');
    expect(infos[0].cwd).toBe('/tmp/proj-a');
    expect(infos[0].messageCount).toBe(2);
    expect(infos[0].firstMessage).toBe('hello there');
  });

  it('does not re-read unchanged files on a second scan', async () => {
    writeSession('proj-a', 's1.jsonl', '/tmp/proj-a', ['one']);
    writeSession('proj-b', 's2.jsonl', '/tmp/proj-b', ['two']);

    const first = await scanDiskSessions(root, wantAll, 'test');
    expect(first).toHaveLength(2);

    const before = getSessionBodyReadCount();
    const second = await scanDiskSessions(root, wantAll, 'test');

    expect(getSessionBodyReadCount()).toBe(before);
    expect(second.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('re-reads only the file that changed', async () => {
    const f1 = writeSession('proj-a', 's1.jsonl', '/tmp/proj-a', ['one']);
    writeSession('proj-b', 's2.jsonl', '/tmp/proj-b', ['two']);
    await scanDiskSessions(root, wantAll, 'test');

    appendMessage(f1, 'a second message');
    const before = getSessionBodyReadCount();
    const infos = await scanDiskSessions(root, wantAll, 'test');

    expect(getSessionBodyReadCount() - before).toBe(1);
    expect(infos.find((s) => s.id === 's1')!.messageCount).toBe(2);
    expect(infos.find((s) => s.id === 's2')!.messageCount).toBe(1);
  });

  it('drops deleted sessions and never serves them from cache', async () => {
    const f1 = writeSession('proj-a', 's1.jsonl', '/tmp/proj-a', ['one']);
    await scanDiskSessions(root, wantAll, 'test');

    fs.rmSync(f1);
    expect(await scanDiskSessions(root, wantAll, 'test')).toHaveLength(0);

    // Same path reused by a NEW session: must be read afresh, not served from a
    // stale cache entry.
    writeSession('proj-a', 's1.jsonl', '/tmp/proj-a', ['brand new', 'reply', 'more']);
    const infos = await scanDiskSessions(root, wantAll, 'test');
    expect(infos).toHaveLength(1);
    expect(infos[0].firstMessage).toBe('brand new');
    expect(infos[0].messageCount).toBe(3);
  });

  it('prunes unwanted folders without reading their bodies', async () => {
    writeSession('proj-a', 's1.jsonl', '/tmp/proj-a', ['keep me']);
    writeSession('proj-b', 's2.jsonl', '/tmp/proj-b', ['ignore me']);

    const before = getSessionBodyReadCount();
    const infos = await scanDiskSessions(root, (cwd) => cwd === '/tmp/proj-a', 'test');

    expect(infos.map((s) => s.id)).toEqual(['s1']);
    expect(getSessionBodyReadCount() - before).toBe(1);
  });

  it('shares one pass between concurrent scans of the same view', async () => {
    for (let i = 0; i < 10; i++) {
      writeSession(`proj-${i}`, `s${i}.jsonl`, `/tmp/proj-${i}`, ['msg']);
    }

    const before = getSessionBodyReadCount();
    // N dashboard tabs asking at once during the cold pass must not each parse
    // every file.
    const results = await Promise.all([
      scanDiskSessions(root, wantAll, 'test'),
      scanDiskSessions(root, wantAll, 'test'),
      scanDiskSessions(root, wantAll, 'test'),
    ]);

    expect(getSessionBodyReadCount() - before).toBe(10);
    for (const r of results) expect(r).toHaveLength(10);
  });

  describe('retention (sessions.maxAgeDays / maxSessions)', () => {
    // Retention exists to bound the ONE cost that grows forever: a sessions
    // directory that has been accumulating for months. It is a LISTING limit,
    // never a deletion, and it is decided from the file's mtime BEFORE the body
    // is read -- so an excluded session must cost a stat and nothing else.

    function ageFile(file: string, days: number): void {
      const t = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      fs.utimesSync(file, t, t);
    }

    it('drops sessions older than maxAgeDays without reading them', async () => {
      const fresh = writeSession('proj-fresh', 'fresh.jsonl', '/tmp/proj-fresh', ['recent']);
      const old = writeSession('proj-old', 'old.jsonl', '/tmp/proj-old', ['ancient']);
      ageFile(old, 40);

      const before = getSessionBodyReadCount();
      const infos = await scanDiskSessions(root, wantAll, 'test', { maxAgeDays: 30 });

      expect(infos.map((s) => s.id)).toEqual(['fresh']);
      // The excluded file's BODY was never read: that is the whole point.
      expect(getSessionBodyReadCount() - before).toBe(1);
      expect(fs.existsSync(old)).toBe(true); // retention never deletes
    });

    it('keeps only the maxSessions most recently modified', async () => {
      const files: string[] = [];
      for (let i = 0; i < 5; i++) {
        files.push(writeSession(`proj-${i}`, `s${i}.jsonl`, `/tmp/proj-${i}`, ['msg']));
      }
      // s4 newest ... s0 oldest.
      files.forEach((f, i) => ageFile(f, 5 - i));

      const infos = await scanDiskSessions(root, wantAll, 'test', { maxSessions: 2 });
      expect(infos.map((s) => s.id).sort()).toEqual(['s3', 's4']);
    });

    it('keeps `keep` (starred) sessions regardless of both limits', async () => {
      // A star means "come back to this": it must not silently age out of the
      // list, and it must not cost a recent session its maxSessions slot.
      const fresh = writeSession('proj-fresh', 'fresh.jsonl', '/tmp/proj-fresh', ['recent']);
      const starred = writeSession('proj-old', 'starred.jsonl', '/tmp/proj-old', ['ancient']);
      const other = writeSession('proj-other', 'other.jsonl', '/tmp/proj-other', ['also old']);
      ageFile(starred, 400);
      ageFile(other, 400);
      ageFile(fresh, 1);

      const keep = (f: string) => f === path.resolve(starred);
      const infos = await scanDiskSessions(root, wantAll, 'listing', { maxAgeDays: 30, maxSessions: 1, keep });
      expect(infos.map((s) => s.id).sort()).toEqual(['fresh', 'starred']);
    });

    it('still resolves an excluded session on a scan without retention', async () => {
      // The by-ID lookup (findDiskSessionByIdOrName) deliberately scans WITHOUT
      // retention, so a deep link to an old session keeps working. If that ever
      // changes, retention silently becomes "unreachable", not "unlisted".
      const old = writeSession('proj-old', 'old.jsonl', '/tmp/proj-old', ['ancient']);
      ageFile(old, 400);

      expect(await scanDiskSessions(root, wantAll, 'listing', { maxAgeDays: 30 })).toHaveLength(0);
      const all = await scanDiskSessions(root, wantAll, 'lookup');
      expect(all.map((s) => s.id)).toEqual(['old']);
    });

    it('does not evict a retention-excluded session from the cache', async () => {
      // The eviction loop drops cache entries for files that are GONE. A file
      // merely excluded by retention is still on disk, so it must stay cached:
      // otherwise a retained scan would silently invalidate everything the
      // unretained (lookup) scan just paid to read.
      const old = writeSession('proj-old', 'old.jsonl', '/tmp/proj-old', ['ancient']);
      ageFile(old, 400);

      await scanDiskSessions(root, wantAll, 'lookup'); // caches it
      await scanDiskSessions(root, wantAll, 'listing', { maxAgeDays: 30 }); // excludes it

      const before = getSessionBodyReadCount();
      const all = await scanDiskSessions(root, wantAll, 'lookup');
      expect(all.map((s) => s.id)).toEqual(['old']);
      expect(getSessionBodyReadCount() - before).toBe(0); // served from cache
    });
  });

  it('yields to the event loop during a cold scan', async () => {
    for (let i = 0; i < 40; i++) {
      writeSession(`proj-${i}`, `s${i}.jsonl`, `/tmp/proj-${i}`, ['msg']);
    }

    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 0);

    await scanDiskSessions(root, wantAll, 'test');
    clearTimeout(timer);

    // A synchronous scan (the old readFileSync loop) would starve this timer
    // until it finished; the async, yielding scan lets it run.
    expect(ticked).toBe(true);
  });
});
