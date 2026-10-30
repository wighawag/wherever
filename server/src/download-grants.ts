import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Attach grants: files the agent EXPLICITLY offered for download in a session.
 *
 * `GET /session/download` is deny-by-default: it serves a file only when its real
 * path is under an allowed root (session cwd, upload dir, `downloads.roots`).
 * That broke `attach_file` for any deliverable the agent wrote OUTSIDE the
 * session cwd (a sibling project, a build dir elsewhere): the tool reported
 * success and the UI showed a button that always 404ed.
 *
 * A successful `attach_file` call is itself the grant. The agent could already
 * read that file and paste it into the conversation, so serving exactly that
 * file to the same session's viewers exposes nothing new, while every other
 * path outside the roots stays denied.
 *
 * The grants are read from the session TRANSCRIPT rather than kept in memory, so
 * they survive a server restart, cover CLI-bridge sessions (whose tools run in
 * another process but whose transcript is the same pi jsonl file), and work for
 * a session that is not currently loaded. Only SUCCESSFUL `attach_file` tool
 * results count (`isError` false), and the path used is the tool's own
 * `details.path` (realpath-resolved at attach time), never the raw argument. The
 * endpoint realpath-resolves it again before the exact match, so a grant can only
 * ever name a regular file, never a directory.
 */

interface CacheEntry {
  mtimeMs: number;
  size: number;
  paths: string[];
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 64;

/** Cheap pre-filter so only lines that can possibly be an attach result are JSON-parsed. */
const NEEDLE = '"toolName":"attach_file"';

/**
 * The absolute paths granted by successful `attach_file` tool results in the
 * transcript at `sessionFile`. Returns `[]` when the file is missing/unreadable.
 * Cached against the file's mtime + size, so a long transcript is re-scanned
 * only after it changes.
 */
export async function readAttachGrants(sessionFile: string): Promise<string[]> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(sessionFile);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];

  const cached = cache.get(sessionFile);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.paths;
  }

  const paths = new Set<string>();
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(sessionFile, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.includes(NEEDLE)) continue;
      const granted = attachGrantFromLine(line);
      if (granted) paths.add(granted);
    }
  } catch {
    return [];
  }

  const result = Array.from(paths);
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(sessionFile)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(sessionFile, { mtimeMs: stat.mtimeMs, size: stat.size, paths: result });
  return result;
}

/** Extract the granted path from one transcript line, or null if it is not a successful attach_file result. */
export function attachGrantFromLine(line: string): string | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if ((entry as { type?: unknown } | null)?.type !== 'message') return null;
  const message = (entry as { message?: unknown }).message as
    | { role?: unknown; toolName?: unknown; isError?: unknown; details?: { path?: unknown } }
    | undefined;
  if (!message || message.role !== 'toolResult' || message.toolName !== 'attach_file') return null;
  if (message.isError === true) return null;
  const p = message.details?.path;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

/** Test hook: forget every cached scan. */
export function clearAttachGrantCache(): void {
  cache.clear();
}
