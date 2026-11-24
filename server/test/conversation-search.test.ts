import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

/**
 * Conversation search (`GET /search`), backed by the memonaut index.
 *
 * Everything here is isolated three ways so a developer's real setup can never
 * leak in (or be touched):
 *  - `MEMONAUT_CONFIG_DIR` + `MEMONAUT_DB` point the server at a throwaway index
 *    built from throwaway transcripts, never at ~/.local/share/memonaut;
 *  - `WHEREVER_CONFIG_DIR` gives the server its own config.json, so the
 *    developer's `sessions.ignore` cannot hide the fixtures (and this test's
 *    ignore rule cannot hide anything of theirs);
 *  - the index is built HERE, in the test process, never by the server: the
 *    server must never index on a request path (memonaut's indexer is
 *    synchronous, ~40 s on a real corpus, and would freeze every WS client).
 */

interface FixtureEntry {
  id: string;
  role?: 'user' | 'assistant';
  text: string;
  ts?: string;
}

interface FixtureSession {
  uuid: string;
  cwd: string;
  /** Absolute path of the transcript this one was forked from. */
  parent?: string;
  started?: string;
  entries: FixtureEntry[];
}

/** Write a transcript in pi's on-disk shape (mangled folder name included). */
function writeSession(root: string, session: FixtureSession): string {
  const folder = '--' + session.cwd.replace(/\//g, '-') + '--';
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const started = session.started ?? '2026-01-01T00:00:00.000Z';
  const file = path.join(dir, `${started.replace(/[:.]/g, '-')}_${session.uuid}.jsonl`);

  const line = (obj: unknown) => JSON.stringify(obj) + '\n';
  let out = line({
    type: 'session',
    version: 3,
    id: session.uuid,
    timestamp: started,
    cwd: session.cwd,
    ...(session.parent ? { parentSession: session.parent } : {}),
  });

  let previous: string | null = null;
  for (const entry of session.entries) {
    const role = entry.role ?? 'user';
    out += line({
      type: 'message',
      id: entry.id,
      parentId: previous,
      timestamp: entry.ts ?? started,
      message: { role, content: [{ type: 'text', text: entry.text }] },
    });
    previous = entry.id;
  }

  fs.writeFileSync(file, out);
  return file;
}

interface Fixture {
  root: string;
  dbPath: string;
  memonautConfigDir: string;
  whereverConfigDir: string;
  sessionsRoot: string;
  visibleCwd: string;
  hiddenCwd: string;
  fleetCwd: string;
  parentFile: string;
  forkFile: string;
  hiddenFile: string;
  fleetFile: string;
  /** Present only with `memonautPrivate`: a session in a memonaut `private` folder. */
  privateFile?: string;
  privateCwd: string;
  env: Record<string, string>;
}

/**
 * Build a throwaway corpus + index:
 *  - `visibleCwd`: a normal project, with a PARENT session and a FORK of it that
 *    shares the matched entry (so the fan-out is exercised for real);
 *  - `hiddenCwd`: a project the wherever config will put in `sessions.ignore`;
 *  - `fleetCwd`: a project in `sessions.readOnly` (the separate read-only page).
 * Every session contains the same needle, so any leak is a visible failure.
 */
async function makeFixture(opts?: {
  skipIndex?: boolean;
  /** Also write a session in a folder memonaut's config marks `private`. */
  memonautPrivate?: boolean;
  /** Extra sessions written before the index is built. */
  extraSessions?: (dirs: { visibleCwd: string }) => FixtureSession[];
}): Promise<Fixture & { extraFiles: string[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-search-'));
  const sessionsRoot = path.join(root, 'sessions');
  const memonautConfigDir = path.join(root, 'memonaut-config');
  const whereverConfigDir = path.join(root, 'wherever-config');
  const dbPath = path.join(root, 'index.db');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.mkdirSync(memonautConfigDir, { recursive: true });
  fs.mkdirSync(whereverConfigDir, { recursive: true });

  const visibleCwd = path.join(root, 'projects', 'alpha');
  const hiddenCwd = path.join(root, 'projects', 'hidden');
  const fleetCwd = path.join(root, 'projects', 'fleet');
  const privateCwd = path.join(root, 'projects', 'private');

  const parentFile = writeSession(sessionsRoot, {
    uuid: '00000000-0000-4000-8000-00000000aaaa',
    cwd: visibleCwd,
    started: '2026-02-01T10:00:00.000Z',
    entries: [
      { id: 'aaaa0001', text: 'we should keep the flamingo protocol simple', ts: '2026-02-01T10:00:00.000Z' },
      { id: 'aaaa0002', role: 'assistant', text: 'agreed, one endpoint', ts: '2026-02-01T10:01:00.000Z' },
    ],
  });

  // A fork copies the shared prefix (same entry ids) and then diverges, so the
  // needle above lands in history carried by BOTH threads.
  const forkFile = writeSession(sessionsRoot, {
    uuid: '00000000-0000-4000-8000-00000000bbbb',
    cwd: visibleCwd,
    parent: parentFile,
    started: '2026-02-02T10:00:00.000Z',
    entries: [
      { id: 'aaaa0001', text: 'we should keep the flamingo protocol simple', ts: '2026-02-01T10:00:00.000Z' },
      { id: 'aaaa0002', role: 'assistant', text: 'agreed, one endpoint', ts: '2026-02-01T10:01:00.000Z' },
      { id: 'bbbb0003', text: 'actually lets revisit that', ts: '2026-02-02T10:02:00.000Z' },
      { id: 'bbbb0004', role: 'assistant', text: 'ok', ts: '2026-02-02T10:03:00.000Z' },
    ],
  });

  const hiddenFile = writeSession(sessionsRoot, {
    uuid: '00000000-0000-4000-8000-00000000cccc',
    cwd: hiddenCwd,
    started: '2026-02-03T10:00:00.000Z',
    entries: [{ id: 'cccc0001', text: 'the flamingo protocol secret nobody should see' }],
  });

  const fleetFile = writeSession(sessionsRoot, {
    uuid: '00000000-0000-4000-8000-00000000dddd',
    cwd: fleetCwd,
    started: '2026-02-04T10:00:00.000Z',
    entries: [{ id: 'dddd0001', text: 'flamingo protocol run by the autonomous fleet' }],
  });

  const privateFile = opts?.memonautPrivate
    ? writeSession(sessionsRoot, {
        uuid: '00000000-0000-4000-8000-00000000ffff',
        cwd: privateCwd,
        started: '2026-02-06T10:00:00.000Z',
        entries: [{ id: 'ffff0001', text: 'flamingo protocol in a private folder' }],
      })
    : undefined;

  const extraFiles = (opts?.extraSessions?.({ visibleCwd }) ?? []).map((session) =>
    writeSession(sessionsRoot, session),
  );

  fs.writeFileSync(
    path.join(memonautConfigDir, 'config.json'),
    JSON.stringify(
      {
        sources: [{ id: 'pi', kind: 'pi', root: sessionsRoot }],
        ...(opts?.memonautPrivate ? { private: [privateCwd, `${privateCwd}/**`] } : {}),
      },
      null,
      2,
    ),
  );

  const env: Record<string, string> = {
    MEMONAUT_CONFIG_DIR: memonautConfigDir,
    MEMONAUT_DB: dbPath,
    WHEREVER_CONFIG_DIR: whereverConfigDir,
  };

  if (!opts?.skipIndex) {
    const { loadConfig, index } = await import('memonaut');
    const config = loadConfig({ ...process.env, ...env });
    index({ config });
  }

  return {
    root,
    dbPath,
    memonautConfigDir,
    whereverConfigDir,
    sessionsRoot,
    visibleCwd,
    hiddenCwd,
    fleetCwd,
    parentFile,
    forkFile,
    hiddenFile,
    fleetFile,
    privateFile,
    privateCwd,
    env,
    extraFiles,
  };
}

/**
 * Close sessions the way the store does it: `closed-sessions.json` in the
 * server's STATE dir. The harness blanks `WHEREVER_STATE_DIR`, so the state dir
 * is the fixture's throwaway `WHEREVER_CONFIG_DIR`, never the real one.
 */
function writeClosed(fixture: Fixture, files: string[]): void {
  fs.writeFileSync(
    path.join(fixture.whereverConfigDir, 'closed-sessions.json'),
    JSON.stringify({
      version: 1,
      closed: files.map((sessionFile, i) => ({ sessionFile, closedAt: 1000 + i, batch: 'c_test' })),
    }),
  );
}

/** Write the server-side wherever config (auto-sync off: no child indexers here). */
function writeWhereverConfig(
  fixture: Fixture,
  sessions: Record<string, string[]>,
  conversationSearch: Record<string, unknown> = { autoSync: false },
): void {
  fs.writeFileSync(
    path.join(fixture.whereverConfigDir, 'config.json'),
    JSON.stringify({ conversationSearch, sessions }, null, 2),
  );
}

interface SearchResponseShape {
  status: string;
  query: string;
  hits: Array<{
    entryKey: string;
    role: string;
    kind: string;
    snippet: string;
    threads: Array<{
      sessionPath: string;
      cwd: string;
      folderName: string;
      lastActivity: string | null;
      seq: number;
      after: number;
      isRoot: boolean;
      readOnly: boolean;
      closed: boolean;
    }>;
    threadTotal: number;
  }>;
  hiddenHits?: number;
  index?: { path: string; files: number; entries: number };
  message?: string;
}

async function search(
  h: Harness,
  query: string,
  view?: 'default' | 'readonly',
  includeClosed?: boolean,
): Promise<SearchResponseShape> {
  const url =
    `http://127.0.0.1:${h.port}/search?q=${encodeURIComponent(query)}` +
    (view ? `&view=${view}` : '') +
    (includeClosed ? '&includeClosed=1' : '');
  const res = await fetch(url);
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponseShape;
}

/** One raw `GET /search` with arbitrary query-string params (e.g. `since`). */
async function searchParams(
  h: Harness,
  params: Record<string, string>,
): Promise<SearchResponseShape> {
  const res = await fetch(`http://127.0.0.1:${h.port}/search?${new URLSearchParams(params)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponseShape;
}

function hitPaths(body: SearchResponseShape): string[] {
  return body.hits.flatMap((hit) => hit.threads.map((t) => t.sessionPath));
}

/**
 * A NEWER match in the visible project (2026-02-10T10:00Z), on top of the
 * fixture's older ones (the shared parent/fork entry is 2026-02-01T10:00Z).
 */
const recentSession = ({ visibleCwd }: { visibleCwd: string }): FixtureSession[] => [
  {
    uuid: '00000000-0000-4000-8000-0000000011aa',
    cwd: visibleCwd,
    started: '2026-02-10T10:00:00.000Z',
    entries: [
      { id: '11aa0001', text: 'flamingo protocol, revisited recently', ts: '2026-02-10T10:00:00.000Z' },
    ],
  },
];

let harness: Harness | undefined;
let cleanupDirs: string[] = [];

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  for (const dir of cleanupDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  cleanupDirs = [];
});

describe('conversation search', () => {
  it('answers with status:not-indexed instead of building the index inline', async () => {
    // No index file at all. Building one here would be ~40 s of BLOCKED event
    // loop, so the only correct answer is a well-formed "run `recall index`".
    const fixture = await makeFixture({ skipIndex: true });
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, {});
    expect(fs.existsSync(fixture.dbPath)).toBe(false);

    harness = await startHarness({ env: fixture.env });
    const body = await search(harness, 'flamingo');

    expect(body.status).toBe('not-indexed');
    expect(body.hits).toEqual([]);
    expect(body.message).toContain('recall index');
    expect(body.index?.path).toBe(fixture.dbPath);
    // The endpoint must not have created it as a side effect.
    expect(fs.existsSync(fixture.dbPath)).toBe(false);

    // And the server is still perfectly responsive afterwards.
    const health = await fetch(`http://127.0.0.1:${harness.port}/health`);
    expect(health.ok).toBe(true);
  }, 60_000);

  it('never returns a session hidden by sessions.ignore', async () => {
    const fixture = await makeFixture();
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, { ignore: [`${fixture.hiddenCwd}/**`] });

    // The index itself DOES contain the hidden session: this asserts wherever's
    // own rule is what removes it, not an accident of what was indexed.
    const { loadConfig, openDb, search: memonautSearch } = await import('memonaut');
    const config = loadConfig({ ...process.env, ...fixture.env });
    const db = openDb(config.dbPath, { readOnly: true });
    const raw = memonautSearch(db, { text: 'flamingo', limit: 20, threadLimit: 100 });
    const rawPaths = raw.hits.flatMap((hit) => hit.threads.map((t) => t.path));
    expect(rawPaths).toContain(fixture.hiddenFile);
    db.close();

    harness = await startHarness({ env: fixture.env });
    const body = await search(harness, 'flamingo');

    expect(body.status).toBe('ok');
    const paths = body.hits.flatMap((hit) => hit.threads.map((t) => t.sessionPath));
    expect(paths).not.toContain(fixture.hiddenFile);
    expect(paths.some((p) => p.startsWith(fixture.hiddenCwd))).toBe(false);
    // The visible project is still searchable, so this is a filter, not a break.
    expect(paths).toContain(fixture.parentFile);
    // Nothing leaks through the snippets either.
    expect(JSON.stringify(body.hits)).not.toContain('nobody should see');
  }, 60_000);

  it('keeps sessions.readOnly folders on their own view, exactly like /sessions', async () => {
    const fixture = await makeFixture();
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, {
      ignore: [`${fixture.hiddenCwd}/**`],
      readOnly: [`${fixture.fleetCwd}/**`],
    });

    harness = await startHarness({ env: fixture.env });

    const main = await search(harness, 'flamingo');
    const mainPaths = main.hits.flatMap((hit) => hit.threads.map((t) => t.sessionPath));
    expect(mainPaths).toContain(fixture.parentFile);
    expect(mainPaths).not.toContain(fixture.fleetFile);
    // A hit whose every thread was filtered out is counted, not silently lost.
    expect(main.hiddenHits).toBeGreaterThan(0);

    const readonly = await search(harness, 'flamingo', 'readonly');
    const roPaths = readonly.hits.flatMap((hit) => hit.threads.map((t) => t.sessionPath));
    expect(roPaths).toContain(fixture.fleetFile);
    expect(roPaths).not.toContain(fixture.parentFile);
    // Still minus sessions.ignore: readOnly is a different axis, not an escape.
    expect(roPaths).not.toContain(fixture.hiddenFile);
    expect(readonly.hits.every((hit) => hit.threads.every((t) => t.readOnly))).toBe(true);
  }, 60_000);

  it('returns every fork carrying a shared match, newest-active first', async () => {
    const fixture = await makeFixture();
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, {});

    harness = await startHarness({ env: fixture.env });
    const body = await search(harness, '"flamingo protocol"');

    expect(body.status).toBe('ok');
    const shared = body.hits.find((hit) =>
      hit.threads.some((t) => t.sessionPath === fixture.parentFile),
    );
    expect(shared).toBeDefined();

    // A match in shared history belongs to BOTH threads and is never collapsed.
    const paths = shared!.threads.map((t) => t.sessionPath);
    expect(paths).toContain(fixture.parentFile);
    expect(paths).toContain(fixture.forkFile);
    expect(shared!.threadTotal).toBe(2);
    // Most recently active first: the fork was touched a day later.
    expect(paths[0]).toBe(fixture.forkFile);
    // `after` is what tells byte-identical siblings apart.
    const fork = shared!.threads.find((t) => t.sessionPath === fixture.forkFile)!;
    const parent = shared!.threads.find((t) => t.sessionPath === fixture.parentFile)!;
    expect(fork.after).toBeGreaterThan(parent.after);
    expect(parent.isRoot).toBe(true);
    expect(fork.isRoot).toBe(false);

    // The join key: an absolute, resolved transcript path, i.e. exactly what
    // /sessions reports as FolderSessionInfo.path, so a result is clickable.
    for (const thread of shared!.threads) {
      expect(path.isAbsolute(thread.sessionPath)).toBe(true);
      expect(thread.sessionPath).toBe(path.resolve(thread.sessionPath));
      expect(thread.cwd).toBe(fixture.visibleCwd);
      expect(thread.folderName).toBe(path.basename(fixture.visibleCwd));
    }

    // Snippet carries FTS5 highlight markers for the web to render.
    expect(shared!.snippet).toContain('\u0001');
    expect(body.index?.files).toBeGreaterThan(0);
  }, 60_000);

  it('requires the same token as the other endpoints', async () => {
    const fixture = await makeFixture();
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, {});

    harness = await startHarness({
      env: { ...fixture.env, PI_REMOTE_TOKEN: 'secret-token' },
    });

    const unauthorized = await fetch(`http://127.0.0.1:${harness.port}/search?q=flamingo`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(
      `http://127.0.0.1:${harness.port}/search?q=flamingo&token=secret-token`,
    );
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as SearchResponseShape;
    expect(body.status).toBe('ok');
    expect(body.hits.length).toBeGreaterThan(0);
  }, 60_000);

  it('catches the index up in a CHILD process, never inline', async () => {
    const fixture = await makeFixture();
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, {}, { autoSync: true, syncIntervalMs: 0 });

    // A session written AFTER the index was built. Picking it up means walking
    // transcripts and writing SQLite, which is exactly the synchronous work that
    // must never happen on a request path.
    const lateFile = writeSession(fixture.sessionsRoot, {
      uuid: '00000000-0000-4000-8000-00000000eeee',
      cwd: fixture.visibleCwd,
      started: '2026-02-05T10:00:00.000Z',
      entries: [{ id: 'eeee0001', text: 'a wombat appeared after indexing' }],
    });

    harness = await startHarness({ env: fixture.env });

    const started = Date.now();
    const first = await search(harness, 'wombat');
    const elapsed = Date.now() - started;

    // Served from the index AS IT IS: the new session is not in it yet. If this
    // ever starts returning the late session, something began indexing inline.
    expect(first.status).toBe('ok');
    expect(first.hits).toEqual([]);
    expect(elapsed).toBeLessThan(2000);

    // ...but the request did kick off a background catch-up, so the session
    // becomes searchable shortly after, with no further help from anyone.
    const { loadConfig, openDb, search: memonautSearch } = await import('memonaut');
    const config = loadConfig({ ...process.env, ...fixture.env });
    const deadline = Date.now() + 30_000;
    let indexed = false;
    while (Date.now() < deadline && !indexed) {
      await new Promise((r) => setTimeout(r, 250));
      const db = openDb(config.dbPath, { readOnly: true });
      try {
        const raw = memonautSearch(db, { text: 'wombat', limit: 5, threadLimit: 10 });
        indexed = raw.hits.some((hit) => hit.threads.some((t) => t.path === lateFile));
      } finally {
        db.close();
      }
    }
    expect(indexed).toBe(true);

    // And the freshly indexed session is now returned by the endpoint too.
    const second = await search(harness, 'wombat');
    const paths = second.hits.flatMap((hit) => hit.threads.map((t) => t.sessionPath));
    expect(paths).toContain(lateFile);
  }, 90_000);

  it('drops closed sessions by default and returns them flagged with includeClosed=1', async () => {
    const fixture = await makeFixture();
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, {});
    // The parent is closed; its fork (which carries the same shared entry) is not.
    writeClosed(fixture, [fixture.parentFile]);
    // The operator's real store: the ambient state dir (production sets one),
    // else ~/.wherever.
    const realState = path.join(
      process.env.WHEREVER_STATE_DIR?.trim() || path.join(os.homedir(), '.wherever'),
      'closed-sessions.json',
    );
    const realBefore = fs.existsSync(realState) ? fs.readFileSync(realState, 'utf8') : null;

    harness = await startHarness({ env: fixture.env });

    const byDefault = await search(harness, '"flamingo protocol"');
    expect(byDefault.status).toBe('ok');
    const defaultPaths = byDefault.hits.flatMap((hit) => hit.threads.map((t) => t.sessionPath));
    expect(defaultPaths).not.toContain(fixture.parentFile);
    // The open fork survives, and the shared hit counts only it.
    const shared = byDefault.hits.find((hit) =>
      hit.threads.some((t) => t.sessionPath === fixture.forkFile),
    );
    expect(shared).toBeDefined();
    expect(shared!.threadTotal).toBe(1);
    expect(shared!.threads.every((t) => t.closed === false)).toBe(true);

    const included = await search(harness, '"flamingo protocol"', undefined, true);
    const sharedAll = included.hits.find((hit) =>
      hit.threads.some((t) => t.sessionPath === fixture.parentFile),
    );
    expect(sharedAll).toBeDefined();
    expect(sharedAll!.threadTotal).toBe(2);
    const parent = sharedAll!.threads.find((t) => t.sessionPath === fixture.parentFile)!;
    const fork = sharedAll!.threads.find((t) => t.sessionPath === fixture.forkFile)!;
    expect(parent.closed).toBe(true);
    expect(fork.closed).toBe(false);

    // The real state dir was never touched.
    const realAfter = fs.existsSync(realState) ? fs.readFileSync(realState, 'utf8') : null;
    expect(realAfter).toBe(realBefore);
  }, 60_000);

  it('applies the closed rule on view=readonly too', async () => {
    const fixture = await makeFixture();
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, { readOnly: [`${fixture.fleetCwd}/**`] });
    writeClosed(fixture, [fixture.fleetFile]);

    harness = await startHarness({ env: fixture.env });

    const byDefault = await search(harness, 'flamingo', 'readonly');
    const paths = byDefault.hits.flatMap((hit) => hit.threads.map((t) => t.sessionPath));
    expect(paths).not.toContain(fixture.fleetFile);
    expect(byDefault.hiddenHits).toBeGreaterThan(0);

    const included = await search(harness, 'flamingo', 'readonly', true);
    const fleet = included.hits
      .flatMap((hit) => hit.threads)
      .find((t) => t.sessionPath === fixture.fleetFile);
    expect(fleet).toMatchObject({ readOnly: true, closed: true });
  }, 60_000);

  it('keeps sessions.ignore, sessions.readOnly and memonaut private intact under includeClosed=1', async () => {
    const fixture = await makeFixture({ memonautPrivate: true });
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, {
      ignore: [`${fixture.hiddenCwd}/**`],
      readOnly: [`${fixture.fleetCwd}/**`],
    });
    // Close EVERY session, hidden ones included: including closed sessions must
    // never become a way around the other rules.
    writeClosed(fixture, [
      fixture.parentFile,
      fixture.forkFile,
      fixture.hiddenFile,
      fixture.fleetFile,
      fixture.privateFile!,
    ]);

    harness = await startHarness({ env: fixture.env });

    const main = await search(harness, 'flamingo', undefined, true);
    const mainPaths = main.hits.flatMap((hit) => hit.threads.map((t) => t.sessionPath));
    expect(mainPaths).toContain(fixture.parentFile);
    expect(mainPaths).not.toContain(fixture.hiddenFile);
    expect(mainPaths).not.toContain(fixture.fleetFile);
    expect(mainPaths).not.toContain(fixture.privateFile);
    expect(JSON.stringify(main.hits)).not.toContain('nobody should see');
    expect(JSON.stringify(main.hits)).not.toContain('private folder');

    const readonly = await search(harness, 'flamingo', 'readonly', true);
    const roPaths = readonly.hits.flatMap((hit) => hit.threads.map((t) => t.sessionPath));
    expect(roPaths).toContain(fixture.fleetFile);
    expect(roPaths).not.toContain(fixture.parentFile);
    expect(roPaths).not.toContain(fixture.hiddenFile);
    expect(roPaths).not.toContain(fixture.privateFile);
  }, 60_000);

  it('treats an empty query as an empty result, not an error', async () => {
    const fixture = await makeFixture();
    cleanupDirs.push(fixture.root);
    writeWhereverConfig(fixture, {});

    harness = await startHarness({ env: fixture.env });
    const body = await search(harness, '   ');
    expect(body.status).toBe('ok');
    expect(body.hits).toEqual([]);
  }, 60_000);
  describe('since (date range)', () => {
    it('excludes an older match and keeps a newer one, by the matched entry ts', async () => {
      const fixture = await makeFixture({ extraSessions: recentSession });
      cleanupDirs.push(fixture.root);
      writeWhereverConfig(fixture, {});
      const [recentFile] = fixture.extraFiles;

      harness = await startHarness({ env: fixture.env });

      // Unbounded: both the old shared entry and the recent one match.
      const all = await searchParams(harness, { q: '"flamingo protocol"' });
      expect(all.status).toBe('ok');
      expect(hitPaths(all)).toContain(fixture.parentFile);
      expect(hitPaths(all)).toContain(recentFile);

      // Bounded after the old entry: only the recent match survives. The fork
      // was ACTIVE on 2026-02-02, but its matched (inherited) entry is from
      // 2026-02-01, so it is out: the bound is on the entry, not the session.
      const bounded = await searchParams(harness, {
        q: '"flamingo protocol"',
        since: '2026-02-05T00:00:00.000Z',
      });
      expect(bounded.status).toBe('ok');
      expect(hitPaths(bounded)).toContain(recentFile);
      expect(hitPaths(bounded)).not.toContain(fixture.parentFile);
      expect(hitPaths(bounded)).not.toContain(fixture.forkFile);
    }, 60_000);

    it('treats an absent or empty since as no bound', async () => {
      const fixture = await makeFixture({ extraSessions: recentSession });
      cleanupDirs.push(fixture.root);
      writeWhereverConfig(fixture, {});

      harness = await startHarness({ env: fixture.env });

      for (const params of [{ q: '"flamingo protocol"' }, { q: '"flamingo protocol"', since: '' }]) {
        const body = await searchParams(harness, params);
        expect(body.status).toBe('ok');
        expect(hitPaths(body)).toContain(fixture.parentFile);
        expect(hitPaths(body)).toContain(fixture.extraFiles[0]);
      }
    }, 60_000);

    it('normalizes an offset form to Z before comparing', async () => {
      const fixture = await makeFixture({ extraSessions: recentSession });
      cleanupDirs.push(fixture.root);
      writeWhereverConfig(fixture, {});
      const [recentFile] = fixture.extraFiles;

      harness = await startHarness({ env: fixture.env });

      // 11:00+02:00 is 09:00Z, BEFORE the 10:00Z entry, so it must match. As
      // raw TEXT, "2026-02-10T10:00..." < "2026-02-10T11:00...", so an
      // unnormalized bound would wrongly exclude it.
      const body = await searchParams(harness, {
        q: '"flamingo protocol"',
        since: '2026-02-10T11:00:00+02:00',
      });
      expect(body.status).toBe('ok');
      expect(hitPaths(body)).toContain(recentFile);
      expect(hitPaths(body)).not.toContain(fixture.parentFile);

      // And a bound after the entry (13:00+02:00 = 11:00Z) drops it.
      const after = await searchParams(harness, {
        q: '"flamingo protocol"',
        since: '2026-02-10T13:00:00+02:00',
      });
      expect(hitPaths(after)).not.toContain(recentFile);
    }, 60_000);

    it('answers status:error on an unparseable since', async () => {
      const fixture = await makeFixture();
      cleanupDirs.push(fixture.root);
      writeWhereverConfig(fixture, {});

      harness = await startHarness({ env: fixture.env });
      const body = await searchParams(harness, { q: 'flamingo', since: 'last tuesday-ish' });
      expect(body.status).toBe('error');
      expect(body.hits).toEqual([]);
      expect(body.message).toContain('since');
    }, 60_000);

    it('answers ok for an empty query even with a garbage since', async () => {
      const fixture = await makeFixture();
      cleanupDirs.push(fixture.root);
      writeWhereverConfig(fixture, {});

      harness = await startHarness({ env: fixture.env });
      const body = await searchParams(harness, { q: '  ', since: 'garbage' });
      expect(body.status).toBe('ok');
      expect(body.hits).toEqual([]);
    }, 60_000);

    it('answers error, not not-indexed, for a garbage since with no index', async () => {
      const fixture = await makeFixture({ skipIndex: true });
      cleanupDirs.push(fixture.root);
      writeWhereverConfig(fixture, {});

      harness = await startHarness({ env: fixture.env });
      const body = await searchParams(harness, { q: 'flamingo', since: 'garbage' });
      expect(body.status).toBe('error');
      expect(fs.existsSync(fixture.dbPath)).toBe(false);
    }, 60_000);

    it('still drops hidden, read-only and closed threads with since set', async () => {
      const fixture = await makeFixture({ extraSessions: recentSession });
      cleanupDirs.push(fixture.root);
      writeWhereverConfig(fixture, {
        ignore: [`${fixture.hiddenCwd}/**`],
        readOnly: [`${fixture.fleetCwd}/**`],
      });
      const [recentFile] = fixture.extraFiles;
      writeClosed(fixture, [recentFile]);

      harness = await startHarness({ env: fixture.env });

      // The hidden (02-03), fleet (02-04) and closed recent (02-10) matches are
      // all INSIDE the window, so only the visibility rules can remove them.
      const since = '2026-02-02T00:00:00.000Z';
      const body = await searchParams(harness, { q: 'flamingo', since });
      expect(body.status).toBe('ok');
      expect(hitPaths(body)).not.toContain(fixture.hiddenFile);
      expect(hitPaths(body)).not.toContain(fixture.fleetFile);
      expect(hitPaths(body)).not.toContain(recentFile);
      expect(JSON.stringify(body.hits)).not.toContain('nobody should see');
      expect(body.hiddenHits).toBeGreaterThan(0);

      const included = await searchParams(harness, { q: 'flamingo', since, includeClosed: '1' });
      const recent = included.hits
        .flatMap((hit) => hit.threads)
        .find((t) => t.sessionPath === recentFile);
      expect(recent).toMatchObject({ closed: true });
      expect(hitPaths(included)).not.toContain(fixture.hiddenFile);
      expect(hitPaths(included)).not.toContain(fixture.fleetFile);
    }, 60_000);
  });
});
