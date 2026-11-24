/**
 * Conversation search: full-text search over EVERY past session, backed by the
 * memonaut index (`~/.local/share/memonaut/index.db`, an SQLite FTS5 file built
 * from the same `~/.pi/agent/sessions` transcripts wherever lists).
 *
 * Three rules hold this module together; breaking any of them breaks the server.
 *
 * 1. **NEVER build the index on a request path.** memonaut is built on
 *    `node:sqlite`, which is SYNCHRONOUS, and so is its indexer: a full build of
 *    a real corpus is ~40 s of blocked event loop, which would freeze every
 *    WebSocket client (the same failure mode the /sessions cache exists to
 *    avoid, see CONTEXT.md "Session-list cost control"). So `index()` is never
 *    called here, and neither is `syncIfStale()` (it opens the DB READ-WRITE and
 *    can itself trigger a full rebuild). Catch-up is delegated to a CHILD
 *    PROCESS (`maybeSpawnSync`), TTL-gated and never awaited. A missing index is
 *    a well-formed answer telling the user to run `recall index`, NOT an inline
 *    build.
 *    What DOES run in-process is one `search()` call: measured at 14-66 ms on a
 *    real index (open ~0 ms, `indexStats` ~17 ms, ~100-120 ms end to end for the
 *    whole endpoint, on 3,822 files / 464k entries). That is the same order as a
 *    warm /sessions pass and only happens on a debounced human action, so it is
 *    acceptable; anything heavier is not.
 *
 * 2. **Read-only, always.** The index belongs to memonaut. wherever opens it
 *    with `{readOnly: true}` (which also sets `PRAGMA query_only`) and never
 *    writes a byte.
 *
 * 3. **Two privacy axes, composed in ONE place** (`filterThreads` below).
 *    memonaut's `ignore`/`private` govern what is INDEXED and what AGENTS may
 *    read; wherever's `sessions.ignore`/`sessions.readOnly` govern what the
 *    DASHBOARD shows. Search is a dashboard surface, so it must obey the
 *    dashboard's rules on top of memonaut's, or it becomes a way to read back
 *    exactly what the user hid from the dashboard. Closed sessions (ADR 0025)
 *    are composed in the same place, as a dashboard-visibility rule the user
 *    can lift (`includeClosed`), unlike the privacy axes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  getWhereverConfig,
  makeIgnoreMatcher,
  normalizeSessionFile,
  resolveSessionCwd,
} from './session-pool.js';
import { readClosedSet } from './session-closed.js';

// The shapes we consume from memonaut. Declared structurally so this module
// compiles (and the server boots) even when the optional dependency is absent.
export interface MemonautThreadRef {
  fileId: number;
  path: string;
  name: string | null;
  cwd: string | null;
  project: string | null;
  lastActivity: string | null;
  entryCount: number;
  seq: number;
  after: number;
  isRoot: boolean;
}

export interface MemonautSearchHit {
  entryId: number;
  entryKey: string;
  lineageId: number;
  role: string;
  tool: string | null;
  ts: string | null;
  kind: string;
  snippet: string;
  score: number;
  threads: MemonautThreadRef[];
  threadTotal: number;
  otherHits: number;
}

interface MemonautModule {
  loadConfig(env?: NodeJS.ProcessEnv): { dbPath: string; configPath: string };
  openDb(dbPath: string, opts?: { readOnly?: boolean }): unknown;
  search(
    db: unknown,
    query: Record<string, unknown>,
  ): { hits: MemonautSearchHit[]; usedQuery: string; scanned: number; quotedFallback: boolean };
  indexStats(db: unknown): {
    files: number;
    entries: number;
    lineages: number;
    newest: string | null;
  };
}

/** One thread (session file) carrying a match, as sent to the web client. */
export interface SearchThreadResult {
  /**
   * Absolute transcript path, normalized with the SAME `normalizeSessionFile`
   * the /sessions listing uses. This is the join key: it is byte-identical to
   * `FolderSessionInfo.path`, so the client can hand it straight to
   * `switchSession()` and to the fork tree.
   */
  sessionPath: string;
  name: string | null;
  cwd: string;
  /** Basename of the cwd, matching how /sessions names a folder. */
  folderName: string;
  project: string | null;
  lastActivity: string | null;
  entryCount: number;
  /** Position of the matched entry within this thread. */
  seq: number;
  /** Entries this thread accumulated AFTER the match (what tells forks apart). */
  after: number;
  /** True when this thread is the lineage root, i.e. not itself a fork. */
  isRoot: boolean;
  /** True when the thread's cwd matches a `sessions.readOnly` glob. */
  readOnly: boolean;
  /**
   * True when the session is closed (`closed-sessions.json`, ADR 0025). Only
   * ever true with `includeClosed`: without it closed threads are dropped.
   */
  closed: boolean;
}

export interface SearchHitResult {
  entryKey: string;
  role: string;
  kind: string;
  tool: string | null;
  ts: string | null;
  /**
   * FTS5 snippet. Matched terms are wrapped in \u0001 ... \u0002; the web turns
   * those markers into <mark> (see web/src/lib/core/search-snippet.ts). They are
   * kept as-is on the wire so the server never has to know about HTML.
   */
  snippet: string;
  score: number;
  /**
   * Every VISIBLE thread carrying this entry, most recently active first. A
   * match in history shared by a fork family belongs to all of them, so this is
   * never collapsed to one.
   */
  threads: SearchThreadResult[];
  /** Visible threads carrying this entry (recomputed AFTER filtering). */
  threadTotal: number;
  /** Further matches in the same fork family that were folded into this hit. */
  otherHits: number;
}

export type SearchStatus = 'ok' | 'not-indexed' | 'unavailable' | 'error';

export interface SearchResponse {
  status: SearchStatus;
  query: string;
  /** The FTS5 expression actually used, after any quoting fallback. */
  usedQuery?: string;
  quotedFallback?: boolean;
  hits: SearchHitResult[];
  /** Groups found before `limit` was applied. */
  scanned?: number;
  /** Hits dropped entirely because none of their threads were visible here. */
  hiddenHits?: number;
  index?: { path: string; files: number; entries: number; newest: string | null };
  /** Human-facing explanation for a non-'ok' status. */
  message?: string;
}

export type SearchView = 'default' | 'readonly';

export interface SearchParams {
  query: string;
  view?: SearchView;
  limit?: number;
  /** Keep closed sessions (flagged `closed: true`) instead of dropping them. */
  includeClosed?: boolean;
  /**
   * Lower bound on when the MATCHED ENTRY was said (memonaut's entry `ts`), not
   * on the session's last activity. Any `Date.parse`-able form; absent or empty
   * means no bound, unparseable answers `status: 'error'`. See `parseSince`.
   */
  since?: string;
}

const require = createRequire(import.meta.url);

/** Threads asked of memonaut per hit, before wherever's own filtering. */
const THREAD_FETCH_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_SYNC_INTERVAL_MS = 60_000;

let memonaut: MemonautModule | null | undefined;
let db: unknown | undefined;
let openedDbPath: string | undefined;
let lastSyncAt = 0;
let syncInFlight = false;

/**
 * Drop the cached handle. Called when the configured index path changes and
 * when a query throws (the file may have been rebuilt underneath us), so a
 * stale handle can never wedge search for the life of the process.
 */
function closeDb(): void {
  const handle = db as { close?: () => void } | undefined;
  try {
    handle?.close?.();
  } catch {
    /* best effort */
  }
  db = undefined;
  openedDbPath = undefined;
}

async function loadMemonaut(): Promise<MemonautModule | null> {
  if (memonaut !== undefined) return memonaut;
  try {
    memonaut = (await import('memonaut')) as unknown as MemonautModule;
  } catch (err) {
    console.error('conversation search: memonaut is not available:', err);
    memonaut = null;
  }
  return memonaut;
}

/**
 * Kick off an incremental catch-up in a CHILD PROCESS, at most once per TTL and
 * never more than one at a time. Fire-and-forget on purpose: memonaut's own
 * `syncIfStale()` is synchronous (~130 ms warm, unbounded cold) and opens the DB
 * read-write, so calling it here would block every WebSocket client. The current
 * response is therefore served from the index AS IT IS and may be one sync
 * behind, which for a human search box is the right trade.
 */
function maybeSpawnSync(): void {
  const cfg = getWhereverConfig().conversationSearch;
  if (cfg?.autoSync === false) return;
  const ttl = typeof cfg?.syncIntervalMs === 'number' ? cfg.syncIntervalMs : DEFAULT_SYNC_INTERVAL_MS;
  const now = Date.now();
  if (syncInFlight || now - lastSyncAt < ttl) return;

  // Resolve the CLI as a SIBLING of the package entry point: memonaut's
  // `exports` map exposes only '.', so `require.resolve('memonaut/package.json')`
  // throws ERR_PACKAGE_PATH_NOT_EXPORTED and cannot be used to find the root.
  let cli: string;
  try {
    cli = path.join(path.dirname(require.resolve('memonaut')), 'cli.js');
  } catch {
    return;
  }
  if (!fs.existsSync(cli)) return;

  syncInFlight = true;
  lastSyncAt = now;
  try {
    const child = spawn(process.execPath, [cli, 'index'], {
      // No pipes to drain and no output to buffer; the child owns the write
      // side of the index and the server only ever reads it. It is unref'd (not
      // detached) below, so a shutting-down server is never held open waiting
      // for a catch-up it does not need.
      stdio: 'ignore',
      env: process.env,
    });
    child.on('error', (err) => {
      syncInFlight = false;
      console.error('conversation search: background index failed to start:', err);
    });
    child.on('exit', () => {
      syncInFlight = false;
    });
    child.unref?.();
  } catch (err) {
    syncInFlight = false;
    console.error('conversation search: background index failed:', err);
  }
}

/**
 * Every visibility rule of one search request, as predicates compiled ONCE per
 * request (as `listSessions` does) so the hit loop never re-reads config or the
 * closed store. Built by `visibility()`; tests hand in their own.
 */
export interface ThreadFilter {
  view: SearchView;
  /** Keep closed sessions (flagged) instead of dropping them. */
  includeClosed: boolean;
  /** `sessions.ignore`, on the resolved cwd. */
  isIgnored: (cwd: string) => boolean;
  /** `sessions.readOnly`, on the resolved cwd. */
  isReadOnly: (cwd: string) => boolean;
  /** Closed-sessions store, on the NORMALIZED session path (the /sessions join key). */
  isClosed: (sessionPath: string) => boolean;
}

/**
 * Build the per-request filter from the wherever config and the closed store.
 * `readClosedSet()` never throws (a broken store reads as "nothing closed"),
 * matching `/sessions`, which marks nothing closed in that case either.
 */
function visibility(view: SearchView, includeClosed: boolean): ThreadFilter {
  const sessions = getWhereverConfig().sessions;
  const closed = readClosedSet();
  return {
    view,
    includeClosed,
    isIgnored: makeIgnoreMatcher(sessions?.ignore),
    isReadOnly: makeIgnoreMatcher(sessions?.readOnly),
    isClosed: (sessionPath) => closed.has(sessionPath),
  };
}

/**
 * Compose the visibility rules, in ONE place.
 *
 * - memonaut `ignore`: never indexed, so invisible here by construction.
 * - memonaut `private`: we never pass `includePrivate`, so never returned.
 * - wherever `sessions.ignore`: dropped on EVERY view. A session hidden from the
 *   dashboard must not be readable through search, or search becomes a way to
 *   see what the user hid.
 * - wherever `sessions.readOnly`: mirrors /sessions exactly. `view=default`
 *   drops them; `view=readonly` returns ONLY them (still minus `ignore`).
 * - closed sessions (ADR 0025): dropped on BOTH views unless `includeClosed`,
 *   which keeps them flagged `closed: true`. It is checked LAST, so including
 *   closed sessions can never bring back a thread another rule removed.
 *
 * Filtering is per THREAD, not per hit: one entry in shared fork history can be
 * carried by both a visible and a hidden session. `threadTotal` is recomputed
 * from the surviving threads (`filterHits`), so a hidden fork does not leak even
 * as a count. A thread whose cwd is unknown is dropped (fail closed).
 *
 * Known limitation: matching is on the RESOLVED path (`path.resolve`, matching
 * `/sessions`), which does not follow symlinks. A cwd reached through a symlink
 * can therefore fail to match a glob written against its real path, exactly as
 * it would in the session list; the two surfaces stay consistent, which is the
 * property that matters here.
 */
export function filterThreads(
  threads: MemonautThreadRef[],
  filter: ThreadFilter,
): SearchThreadResult[] {
  const out: SearchThreadResult[] = [];
  for (const t of threads) {
    if (!t.cwd) continue; // fail closed: cannot prove it is allowed here
    const cwd = resolveSessionCwd(t.cwd);
    if (filter.isIgnored(cwd)) continue;
    const readOnly = filter.isReadOnly(cwd);
    if (filter.view === 'readonly' ? !readOnly : readOnly) continue;
    const sessionPath = normalizeSessionFile(t.path);
    const closed = filter.isClosed(sessionPath);
    if (closed && !filter.includeClosed) continue;
    out.push({
      sessionPath,
      name: t.name,
      cwd,
      folderName: path.basename(cwd) || cwd,
      project: t.project,
      lastActivity: t.lastActivity,
      entryCount: t.entryCount,
      seq: t.seq,
      after: t.after,
      isRoot: t.isRoot,
      readOnly,
      closed,
    });
  }
  return out;
}

/**
 * Apply `filterThreads` to every hit: `threadTotal` is recomputed from the
 * survivors, and a hit left with no visible thread is dropped and counted in
 * `hiddenHits` (never silently lost).
 */
export function filterHits(
  rawHits: MemonautSearchHit[],
  filter: ThreadFilter,
): { hits: SearchHitResult[]; hiddenHits: number } {
  let hiddenHits = 0;
  const hits: SearchHitResult[] = [];
  for (const hit of rawHits) {
    const threads = filterThreads(hit.threads, filter);
    if (threads.length === 0) {
      hiddenHits++;
      continue;
    }
    hits.push({
      entryKey: hit.entryKey,
      role: hit.role,
      kind: hit.kind,
      tool: hit.tool,
      ts: hit.ts,
      snippet: hit.snippet,
      score: hit.score,
      threads,
      threadTotal: threads.length,
      otherHits: hit.otherHits,
    });
  }
  return { hits, hiddenHits };
}

/**
 * Validate and normalize a `since` bound.
 *
 * - absent or empty (after trim): `{ since: undefined }`, i.e. no bound;
 * - unparseable (`Date.parse` is NaN): `{ error }`. Unlike `view` and `limit`,
 *   which coerce silently, a bad bound is REFUSED: silently dropping it would
 *   return an unbounded result the user believes is bounded;
 * - otherwise normalized with `toISOString()` (UTC, `Z`). memonaut compares
 *   `ts >= since` as TEXT and pi writes `Z`-suffixed timestamps, so an offset
 *   form like `+02:00` would otherwise compare wrongly.
 *
 * Entries with no `ts` never satisfy a bound (memonaut's behaviour), so they
 * are excluded whenever one is set.
 */
export function parseSince(raw: string | undefined): { since?: string; error?: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return {};
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    return { error: `Invalid \`since\`: ${JSON.stringify(trimmed)} is not a parseable date (use ISO 8601).` };
  }
  return { since: new Date(ms).toISOString() };
}

/**
 * Run one search. Always resolves to a well-formed `SearchResponse`: a missing
 * index, a missing dependency and a bad query are ANSWERS, not failures, so the
 * dashboard can explain itself instead of showing a dead search box.
 */
export async function searchConversations(params: SearchParams): Promise<SearchResponse> {
  const query = (params.query || '').trim();
  const view: SearchView = params.view === 'readonly' ? 'readonly' : 'default';
  const limit = Math.min(Math.max(1, params.limit || DEFAULT_LIMIT), MAX_LIMIT);
  const includeClosed = params.includeClosed === true;

  if (!query) {
    return { status: 'ok', query, hits: [], scanned: 0, hiddenHits: 0 };
  }

  // Validated BEFORE memonaut is loaded or the index opened, so a bad bound is
  // reported as such even when there is no index (not as 'not-indexed').
  const bound = parseSince(params.since);
  if (bound.error) {
    return { status: 'error', query, hits: [], message: bound.error };
  }

  const mod = await loadMemonaut();
  if (!mod) {
    return {
      status: 'unavailable',
      query,
      hits: [],
      message:
        'Conversation search needs the `memonaut` package, which could not be loaded on the server.',
    };
  }

  let dbPath: string;
  try {
    dbPath = mod.loadConfig(process.env).dbPath;
  } catch (err) {
    return { status: 'error', query, hits: [], message: (err as Error).message };
  }

  // The index is a file memonaut owns and may rebuild under us; re-open when the
  // configured path changes.
  if (db !== undefined && openedDbPath !== dbPath) closeDb();

  if (db === undefined) {
    try {
      // Read-only: throws when the file does not exist, which is exactly the
      // "not indexed yet" case. We must NOT build it here (~40 s, blocking).
      db = mod.openDb(dbPath, { readOnly: true });
      openedDbPath = dbPath;
    } catch {
      return {
        status: 'not-indexed',
        query,
        hits: [],
        index: { path: dbPath, files: 0, entries: 0, newest: null },
        message: `No conversation index at ${dbPath}. Run \`recall index\` (from the memonaut package) to build it.`,
      };
    }
  }

  try {
    const outcome = mod.search(db, {
      text: query,
      limit,
      // Over-fetch threads so the visible count is honest after filtering.
      threadLimit: THREAD_FETCH_LIMIT,
      // Bounds the MATCHED ENTRY's ts; `otherHits` then counts only in-window
      // matches. Omitted entirely when unbounded.
      ...(bound.since ? { since: bound.since } : {}),
      // NEVER pass includePrivate: memonaut's `private` globs are the user's
      // "do not hand this back" boundary and search does not get to override it.
    });

    const { hits, hiddenHits } = filterHits(outcome.hits, visibility(view, includeClosed));

    const stats = mod.indexStats(db);

    // Only after the answer is built: never on the way in, never awaited.
    maybeSpawnSync();

    return {
      status: 'ok',
      query,
      usedQuery: outcome.usedQuery,
      quotedFallback: outcome.quotedFallback,
      hits,
      scanned: outcome.scanned,
      hiddenHits,
      index: {
        path: dbPath,
        files: stats.files,
        entries: stats.entries,
        newest: stats.newest,
      },
    };
  } catch (err) {
    // A stale handle (index rebuilt underneath us) should not wedge search.
    closeDb();
    return { status: 'error', query, hits: [], message: (err as Error).message };
  }
}
