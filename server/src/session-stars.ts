// Starred sessions: conversations the user marked to come back to.
//
// The motivating flow: a session writes a prompt, the user launches it in a NEW
// session, and the first one now waits on that result. The new session takes the
// top of the list (it is the most recently modified), so nothing says which one
// spawned it. A star is the user's own "revisit this" marker, shown on the
// session's row in the sidebar and in the top bar.
//
// Server-side for the same reason as drafts: the machine holds the state and any
// device picks it up. A star set from the phone must be there on the laptop.
//
// Keyed by the NORMALIZED session file path (`normalizeSessionFile`), the same
// value the listing reports as `path` and the client holds as the open session's
// `sessionFile`, so no lookup is needed on either side. It also lets the listing
// exempt starred sessions from retention before reading any transcript body
// (retention is decided on paths and stat metadata alone).
//
// This module is the ONE writer. Mutations return the whole new list; clients
// learn of a change by re-listing `/sessions` on the `sessions_updated` broadcast.

import fs from 'node:fs';
import path from 'node:path';
import { getWhereverStateDir, normalizeSessionFile } from './session-pool.js';

/**
 * Cap on retained stars, dropping the oldest. A star is a short-lived "come back
 * to this" marker; without a cap a user who never unstars grows this file forever.
 */
export const MAX_STARRED = 500;

/** A session path is a filesystem path; anything longer is a bug or abuse. */
export const MAX_STAR_PATH_CHARS = 4096;

const MAX_STARS_FILE_BYTES = 2 * 1024 * 1024;

export interface StarredSession {
  /** Normalized absolute path of the session .jsonl file. */
  sessionFile: string;
  /** Epoch ms when it was starred. */
  starredAt: number;
}

interface StarsFile {
  version: number;
  starred: StarredSession[];
}

/**
 * The stars file exists but cannot be trusted. Every mutation is a
 * read-modify-write, so this must abort the write rather than let "I could not
 * read it" overwrite the file as "empty" and drop every star at once.
 */
export class StarsUnavailableError extends Error {
  constructor(reason: string) {
    super(`${getStarsPath()} could not be read (${reason}). Stars left untouched.`);
    this.name = 'StarsUnavailableError';
  }
}

/** State dir, not config dir: it is written on every toggle (see drafts.ts). */
export function getStarsPath(): string {
  return path.join(getWhereverStateDir(), 'starred-sessions.json');
}

/** Most recently starred first, ties broken by path so the order is deterministic. */
export function sortStars(stars: StarredSession[]): StarredSession[] {
  return [...stars].sort(
    (a, b) => b.starredAt - a.starredAt || a.sessionFile.localeCompare(b.sessionFile),
  );
}

/**
 * Parse the file. NULL means "not a stars file" (corrupt, truncated, other JSON)
 * and must be treated as unknown, never as empty. A malformed member is dropped;
 * a duplicate path keeps its most recent entry.
 */
export function parseStars(raw: string | null | undefined): StarredSession[] | null {
  if (raw == null) return null;
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as StarsFile).starred)
      ? (parsed as StarsFile).starred
      : null;
  if (!arr) return null;
  const byFile = new Map<string, StarredSession>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.sessionFile !== 'string' || s.sessionFile.length === 0) continue;
    const sessionFile = normalizeSessionFile(s.sessionFile);
    const starredAt = typeof s.starredAt === 'number' ? s.starredAt : 0;
    const prev = byFile.get(sessionFile);
    if (!prev || prev.starredAt < starredAt) byFile.set(sessionFile, { sessionFile, starredAt });
  }
  return sortStars([...byFile.values()]);
}

export function serializeStars(stars: StarredSession[]): string {
  const file: StarsFile = { version: 1, starred: stars };
  return JSON.stringify(file, null, 2);
}

/**
 * Star or unstar `sessionFile`, returning the new list. Re-starring an already
 * starred session keeps its original `starredAt`: a repeated tap (two devices,
 * a retried request) must not change its `starredAt`.
 */
export function applyStar(
  stars: StarredSession[],
  sessionFile: string,
  starred: boolean,
  now: number,
): StarredSession[] {
  const file = normalizeSessionFile(sessionFile);
  const rest = stars.filter((s) => s.sessionFile !== file);
  if (!starred) return sortStars(rest);
  const existing = stars.find((s) => s.sessionFile === file);
  return sortStars([existing ?? { sessionFile: file, starredAt: now }, ...rest]).slice(0, MAX_STARRED);
}

/** Validate an incoming toggle, returning an error message or null. */
export function validateStarInput(input: { sessionFile?: unknown; starred?: unknown }): string | null {
  if (typeof input.sessionFile !== 'string' || input.sessionFile.length === 0) {
    return 'Missing sessionFile';
  }
  if (input.sessionFile.length > MAX_STAR_PATH_CHARS) return 'sessionFile is too long';
  if (typeof input.starred !== 'boolean') return 'starred must be a boolean';
  return null;
}

/** Read the stored list. Missing file = empty; anything else wrong throws. */
export function readStars(): StarredSession[] {
  const file = getStarsPath();
  let raw: string;
  try {
    if (!fs.existsSync(file)) return [];
    const stat = fs.statSync(file);
    if (stat.size > MAX_STARS_FILE_BYTES) {
      throw new StarsUnavailableError(`${stat.size} bytes, implausibly large`);
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof StarsUnavailableError) throw err;
    throw new StarsUnavailableError((err as Error)?.message || 'read failed');
  }
  const parsed = parseStars(raw);
  if (parsed === null) throw new StarsUnavailableError('not a valid stars file');
  return parsed;
}

/**
 * The starred paths as a Set, for the listing. NEVER throws: a broken stars file
 * must not take the whole session list down with it, so the listing just shows
 * no stars (the error is logged, and the next toggle reports it to the user).
 */
export function readStarredSet(): Set<string> {
  try {
    return new Set(readStars().map((s) => s.sessionFile));
  } catch (err) {
    console.error('[wherever]', (err as Error).message);
    return new Set();
  }
}

/** Atomic write (tmp + rename), mode 0600. */
export function writeStars(stars: StarredSession[]): void {
  const file = getStarsPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.starred-sessions.json.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, serializeStars(stars), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/** Star/unstar and persist. Returns the new list. */
export function setSessionStarred(sessionFile: string, starred: boolean, now = Date.now()): StarredSession[] {
  const current = readStars();
  const next = applyStar(current, sessionFile, starred, now);
  // Skip the write when nothing changed (unstarring something never starred).
  if (serializeStars(next) !== serializeStars(current)) writeStars(next);
  return next;
}

/**
 * Drop the star of a deleted session. Best effort: a delete must never fail
 * because the stars file is unreadable.
 */
export function forgetStar(sessionFile: string): void {
  try {
    setSessionStarred(sessionFile, false);
  } catch (err) {
    console.error('[wherever]', (err as Error).message);
  }
}
