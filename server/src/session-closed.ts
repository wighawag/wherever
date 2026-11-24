// Closed sessions: conversations the user is done with but does not want deleted.
//
// Closing hides a session from the sidebar and from search; the transcript on
// disk is never touched (ADR 0025). It is a wherever flag, not shipmates'
// archive marker, so it works without shipmates and a closed session can be
// woken (any activity reopens it, a later task).
//
// Built like the starred-sessions store (session-stars.ts): server-side so a
// close on the phone shows on the laptop, keyed by the NORMALIZED session file
// path (the listing's `path`), atomic write (tmp + rename, 0600), a corrupt file
// FAILS CLOSED on mutation and is never overwritten as empty.
//
// This module is the ONE writer of `<state dir>/closed-sessions.json`.
//
// Two differences from stars:
// - **No silent reopen at the cap.** Stars drop their oldest entry; here that
//   would silently reopen a session the user closed. At the cap the store first
//   prunes entries whose transcript no longer exists, and if that is not enough
//   it REFUSES the close (`ClosedCapError`). An entry for an existing transcript
//   is never dropped to make room.
// - **An in-memory set** for the per-event check of the auto-reopen task
//   (`isSessionClosed`). It is loaded lazily from disk on first use and keyed by
//   the resolved file path, because the state dir is re-read from
//   `WHEREVER_STATE_DIR` on every call (a plain module-level set would leak
//   between tests that point it elsewhere). Every mutation refreshes it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWhereverStateDir, normalizeSessionFile } from './session-pool.js';

/**
 * Entry cap. Far above any real use (a user closing 50 sessions a day for a
 * year is ~18k); it exists only so the file cannot grow without bound.
 */
export const MAX_CLOSED = 20_000;

/**
 * Byte cap on the serialized file, matching `MAX_CLOSED`: 20,000 pretty-printed
 * entries with typical paths (~150 chars) are ~5 MB. The file is never WRITTEN
 * above this, and a file found above it is treated as corrupt (fail closed).
 */
export const MAX_CLOSED_FILE_BYTES = 8 * 1024 * 1024;

/** A session path is a filesystem path; anything longer is a bug or abuse. */
export const MAX_CLOSED_PATH_CHARS = 4096;

export interface ClosedSession {
  /** Normalized absolute path of the session .jsonl file. */
  sessionFile: string;
  /** Epoch ms when it was closed. */
  closedAt: number;
  /** The close request (one fresh id per close) that closed it, for undo. */
  batch?: string;
  /** Present (true) only when closing it removed its star, so undo can restore it. */
  unstarred?: true;
}

interface ClosedFile {
  version: number;
  closed: ClosedSession[];
}

/**
 * The closed file exists but cannot be trusted. Every mutation is a
 * read-modify-write, so this aborts the write rather than overwrite the file as
 * "empty" and reopen every closed session at once.
 */
export class ClosedUnavailableError extends Error {
  constructor(reason: string) {
    super(`${getClosedPath()} could not be read (${reason}). Closed sessions left untouched.`);
    this.name = 'ClosedUnavailableError';
  }
}

/**
 * The store is full of entries for transcripts that still exist. Refused rather
 * than dropping one, since dropping one would silently reopen that session.
 */
export class ClosedCapError extends Error {
  constructor() {
    super(
      `Too many closed sessions (limit ${MAX_CLOSED} entries / ${MAX_CLOSED_FILE_BYTES} bytes). ` +
        'Delete or reopen some closed sessions first.',
    );
    this.name = 'ClosedCapError';
  }
}

/** State dir, not config dir: it is written on every close (see drafts.ts). */
export function getClosedPath(): string {
  return path.join(getWhereverStateDir(), 'closed-sessions.json');
}

/** A fresh close batch id: one per close request, even for a single session. */
export function newCloseBatch(): string {
  return `c_${crypto.randomBytes(8).toString('hex')}`;
}

/** Most recently closed first, ties broken by path so the order is deterministic. */
export function sortClosed(list: ClosedSession[]): ClosedSession[] {
  return [...list].sort(
    (a, b) => b.closedAt - a.closedAt || a.sessionFile.localeCompare(b.sessionFile),
  );
}

/**
 * Parse the file. NULL means "not a closed file" (corrupt, truncated, other
 * JSON) and must be treated as unknown, never as empty. A malformed member is
 * dropped; a duplicate path keeps its most recent entry.
 */
export function parseClosed(raw: string | null | undefined): ClosedSession[] | null {
  if (raw == null) return null;
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const arr =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as ClosedFile).closed)
      ? ((parsed as ClosedFile).closed as unknown[])
      : null;
  if (!arr) return null;
  const byFile = new Map<string, ClosedSession>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.sessionFile !== 'string' || s.sessionFile.length === 0) continue;
    const entry: ClosedSession = {
      sessionFile: normalizeSessionFile(s.sessionFile),
      closedAt: typeof s.closedAt === 'number' ? s.closedAt : 0,
      ...(typeof s.batch === 'string' && s.batch ? { batch: s.batch } : {}),
      ...(s.unstarred === true ? { unstarred: true as const } : {}),
    };
    const prev = byFile.get(entry.sessionFile);
    if (!prev || prev.closedAt < entry.closedAt) byFile.set(entry.sessionFile, entry);
  }
  return sortClosed([...byFile.values()]);
}

export function serializeClosed(list: ClosedSession[]): string {
  const file: ClosedFile = { version: 1, closed: list };
  return JSON.stringify(file, null, 2);
}

export interface CloseOptions {
  /** The batch id recorded on newly closed entries. */
  batch: string;
  now: number;
  /** Whether closing this session removed its star (recorded as `unstarred`). */
  unstarred?: (sessionFile: string) => boolean;
}

/**
 * Close `files`. An already closed session keeps its entry as it is (its
 * original `closedAt`, `batch` and `unstarred`): a repeated tap must not move it
 * into a new batch. Returns the new list and the sessions this call closed.
 */
export function applyClose(
  list: ClosedSession[],
  files: string[],
  opts: CloseOptions,
): { list: ClosedSession[]; closed: string[] } {
  const byFile = new Map(list.map((s) => [s.sessionFile, s]));
  const closed: string[] = [];
  for (const raw of files) {
    const sessionFile = normalizeSessionFile(raw);
    if (byFile.has(sessionFile)) continue;
    byFile.set(sessionFile, {
      sessionFile,
      closedAt: opts.now,
      batch: opts.batch,
      ...(opts.unstarred?.(sessionFile) ? { unstarred: true as const } : {}),
    });
    closed.push(sessionFile);
  }
  return { list: sortClosed([...byFile.values()]), closed };
}

/** Reopen `files`. Returns the new list and the sessions that were closed. */
export function applyReopen(
  list: ClosedSession[],
  files: string[],
): { list: ClosedSession[]; reopened: string[] } {
  const drop = new Set(files.map(normalizeSessionFile));
  const reopened = list.filter((s) => drop.has(s.sessionFile)).map((s) => s.sessionFile);
  return { list: list.filter((s) => !drop.has(s.sessionFile)), reopened };
}

/**
 * Enforce the cap WITHOUT a silent reopen: when over, drop only entries whose
 * transcript no longer exists (never one in `protect`, the sessions being closed
 * right now, which may not be written yet). Still over: `ClosedCapError`.
 */
export function enforceClosedCap(
  list: ClosedSession[],
  protect: ReadonlySet<string>,
  exists: (file: string) => boolean = fs.existsSync,
  limits: { maxEntries: number; maxBytes: number } = {
    maxEntries: MAX_CLOSED,
    maxBytes: MAX_CLOSED_FILE_BYTES,
  },
): ClosedSession[] {
  const over = (l: ClosedSession[]) =>
    l.length > limits.maxEntries || Buffer.byteLength(serializeClosed(l)) > limits.maxBytes;
  if (!over(list)) return list;
  const pruned = list.filter((s) => protect.has(s.sessionFile) || exists(s.sessionFile));
  if (over(pruned)) throw new ClosedCapError();
  return pruned;
}

/** Validate an incoming close/reopen, returning an error message or null. */
export function validateCloseInput(input: { sessionFile?: unknown; closed?: unknown }): string | null {
  if (typeof input.sessionFile !== 'string' || input.sessionFile.length === 0) {
    return 'Missing sessionFile';
  }
  if (input.sessionFile.length > MAX_CLOSED_PATH_CHARS) return 'sessionFile is too long';
  if (typeof input.closed !== 'boolean') return 'closed must be a boolean';
  return null;
}

/** Read the stored list from disk. Missing file = empty; anything else wrong throws. */
export function readClosed(): ClosedSession[] {
  const file = getClosedPath();
  let raw: string;
  try {
    if (!fs.existsSync(file)) return [];
    const stat = fs.statSync(file);
    if (stat.size > MAX_CLOSED_FILE_BYTES) {
      throw new ClosedUnavailableError(`${stat.size} bytes, implausibly large`);
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof ClosedUnavailableError) throw err;
    throw new ClosedUnavailableError((err as Error)?.message || 'read failed');
  }
  const parsed = parseClosed(raw);
  if (parsed === null) throw new ClosedUnavailableError('not a valid closed-sessions file');
  return parsed;
}

/** Atomic write (tmp + rename), mode 0600. */
export function writeClosed(list: ClosedSession[]): void {
  const file = getClosedPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.closed-sessions.json.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, serializeClosed(list), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// --- In-memory set ----------------------------------------------------------

/** Keyed by the resolved file path, so a changed `WHEREVER_STATE_DIR` reloads. */
let cache: { file: string; set: Set<string> } | null = null;

function remember(list: ClosedSession[]): void {
  cache = { file: getClosedPath(), set: new Set(list.map((s) => s.sessionFile)) };
}

/**
 * The closed paths as a Set, for the listing. NEVER throws: a broken file must
 * not take the session list down, so it shows nothing closed (logged; the next
 * close reports it to the user). An unreadable file is not cached, so fixing it
 * by hand takes effect on the next listing.
 */
export function readClosedSet(): ReadonlySet<string> {
  const file = getClosedPath();
  if (cache && cache.file === file) return cache.set;
  try {
    remember(readClosed());
    return cache!.set;
  } catch (err) {
    console.error('[wherever]', (err as Error).message);
    return new Set();
  }
}

/** True when `sessionFile` is closed. Cheap (the in-memory set); never throws. */
export function isSessionClosed(sessionFile: string): boolean {
  return readClosedSet().has(normalizeSessionFile(sessionFile));
}

// --- Mutations --------------------------------------------------------------

function persist(current: ClosedSession[], next: ClosedSession[]): void {
  // Skip the write when nothing changed (reopening something never closed).
  if (serializeClosed(next) !== serializeClosed(current)) writeClosed(next);
  remember(next);
}

/**
 * Close `files` as ONE batch and persist. Returns the batch id and the sessions
 * it newly closed (empty when all were already closed).
 */
export function closeSessions(
  files: string[],
  opts: { unstarred?: (sessionFile: string) => boolean; now?: number; batch?: string } = {},
): { batch: string; sessions: string[] } {
  const batch = opts.batch ?? newCloseBatch();
  const current = readClosed();
  const applied = applyClose(current, files, { batch, now: opts.now ?? Date.now(), unstarred: opts.unstarred });
  const next = enforceClosedCap(applied.list, new Set(applied.closed));
  persist(current, next);
  return { batch, sessions: applied.closed };
}

/** Reopen `files` and persist. Returns the sessions that were closed. */
export function reopenSessions(files: string[]): string[] {
  const current = readClosed();
  const { list, reopened } = applyReopen(current, files);
  persist(current, list);
  return reopened;
}

/** The stored entry for `sessionFile`, or undefined. Throws like `readClosed`. */
export function getClosedEntry(sessionFile: string): ClosedSession | undefined {
  const file = normalizeSessionFile(sessionFile);
  return readClosed().find((s) => s.sessionFile === file);
}

/**
 * Drop the close flag of a deleted session. Best effort: a delete must never
 * fail because the closed file is unreadable.
 */
export function forgetClosed(sessionFile: string): void {
  try {
    reopenSessions([sessionFile]);
  } catch (err) {
    console.error('[wherever]', (err as Error).message);
  }
}
