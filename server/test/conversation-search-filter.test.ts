import { describe, it, expect } from 'vitest';
import {
  filterHits,
  filterThreads,
  type ThreadFilter,
} from '../src/conversation-search.js';

/**
 * The pure visibility composition behind `GET /search` (`filterThreads` /
 * `filterHits`), without an index: every rule (sessions.ignore,
 * sessions.readOnly, closed) is a predicate handed in, so each axis can be
 * pinned on its own. The end-to-end version (a real throwaway memonaut index,
 * a real closed-sessions.json) is in conversation-search.test.ts.
 */

type Thread = Parameters<typeof filterThreads>[0][number];
type Hit = Parameters<typeof filterHits>[0][number];

function thread(sessionPath: string, cwd: string | null, extra: Partial<Thread> = {}): Thread {
  return {
    fileId: 1,
    path: sessionPath,
    name: null,
    cwd,
    project: null,
    lastActivity: null,
    entryCount: 3,
    seq: 1,
    after: 0,
    isRoot: true,
    ...extra,
  };
}

function hit(entryKey: string, threads: Thread[]): Hit {
  return {
    entryId: 1,
    entryKey,
    lineageId: 1,
    role: 'user',
    tool: null,
    ts: null,
    kind: 'user',
    snippet: 'x',
    score: 1,
    threads,
    threadTotal: threads.length,
    otherHits: 0,
  };
}

const PARENT = '/s/--p-alpha--/parent.jsonl';
const FORK = '/s/--p-alpha--/fork.jsonl';
const LONE = '/s/--p-alpha--/lone.jsonl';
const HIDDEN = '/s/--p-hidden--/hidden.jsonl';
const FLEET = '/s/--p-fleet--/fleet.jsonl';

function filter(overrides: Partial<ThreadFilter> = {}): ThreadFilter {
  return {
    view: 'default',
    includeClosed: false,
    isIgnored: (cwd) => cwd.startsWith('/p/hidden'),
    isReadOnly: (cwd) => cwd.startsWith('/p/fleet'),
    isClosed: () => false,
    ...overrides,
  };
}

describe('conversation search visibility (closed sessions)', () => {
  it('drops closed threads by default and keeps them flagged with includeClosed', () => {
    const closed = new Set([LONE]);
    const threads = [thread(PARENT, '/p/alpha'), thread(LONE, '/p/alpha')];

    const byDefault = filterThreads(threads, filter({ isClosed: (p) => closed.has(p) }));
    expect(byDefault.map((t) => t.sessionPath)).toEqual([PARENT]);
    expect(byDefault[0].closed).toBe(false);

    const included = filterThreads(
      threads,
      filter({ includeClosed: true, isClosed: (p) => closed.has(p) }),
    );
    expect(included.map((t) => [t.sessionPath, t.closed])).toEqual([
      [PARENT, false],
      [LONE, true],
    ]);
  });

  it('a fork family with one closed thread: the open one survives, threadTotal excludes the closed one', () => {
    const closed = new Set([PARENT]);
    const hits = [hit('shared', [thread(FORK, '/p/alpha', { isRoot: false }), thread(PARENT, '/p/alpha')])];

    const byDefault = filterHits(hits, filter({ isClosed: (p) => closed.has(p) }));
    expect(byDefault.hiddenHits).toBe(0);
    expect(byDefault.hits).toHaveLength(1);
    expect(byDefault.hits[0].threads.map((t) => t.sessionPath)).toEqual([FORK]);
    expect(byDefault.hits[0].threadTotal).toBe(1);

    const included = filterHits(hits, filter({ includeClosed: true, isClosed: (p) => closed.has(p) }));
    expect(included.hits[0].threadTotal).toBe(2);
    expect(included.hits[0].threads.find((t) => t.sessionPath === PARENT)?.closed).toBe(true);
  });

  it('a hit carried only by closed threads is dropped and counted in hiddenHits', () => {
    const hits = [hit('gone', [thread(LONE, '/p/alpha')]), hit('kept', [thread(PARENT, '/p/alpha')])];
    const out = filterHits(hits, filter({ isClosed: (p) => p === LONE }));
    expect(out.hits.map((h) => h.entryKey)).toEqual(['kept']);
    expect(out.hiddenHits).toBe(1);
  });

  it('matches the closed set on the NORMALIZED path (the /sessions join key)', () => {
    const closed = new Set([LONE]);
    const out = filterThreads(
      [thread('/s/--p-alpha--/../--p-alpha--/lone.jsonl', '/p/alpha')],
      filter({ isClosed: (p) => closed.has(p) }),
    );
    expect(out).toEqual([]);
  });

  it('leaves sessions.ignore and sessions.readOnly unchanged under includeClosed', () => {
    const everythingClosed = { includeClosed: true, isClosed: () => true };
    const threads = [
      thread(PARENT, '/p/alpha'),
      thread(HIDDEN, '/p/hidden'),
      thread(FLEET, '/p/fleet'),
      thread('/s/unknown.jsonl', null),
    ];

    const main = filterThreads(threads, filter(everythingClosed));
    expect(main.map((t) => t.sessionPath)).toEqual([PARENT]);

    const readonly = filterThreads(threads, filter({ ...everythingClosed, view: 'readonly' }));
    expect(readonly.map((t) => [t.sessionPath, t.readOnly, t.closed])).toEqual([[FLEET, true, true]]);
  });

  it('applies the closed rule on view=readonly too', () => {
    const out = filterThreads(
      [thread(FLEET, '/p/fleet')],
      filter({ view: 'readonly', isClosed: (p) => p === FLEET }),
    );
    expect(out).toEqual([]);
  });
});
