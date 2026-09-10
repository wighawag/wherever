import path from 'path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  readSessionHeader,
  readSessionListingInfo,
  readTranscriptWindow,
  previewText,
  extractMessageText,
  type DiskSessionInfo,
} from './session-transcript.js';

export type { DiskSessionInfo } from './session-transcript.js';

/**
 * Normalize a path to prevent duplicate session folders.
 * - Removes trailing slashes (except for root "/")
 * - Resolves . and .. segments
 * - Ensures consistent encoding for same physical path
 */
export function normalizePath(p: string): string {
  // Resolve to absolute path first (handles . and ..)
  let normalized = path.resolve(p);
  
  // Remove trailing slash (except for root "/")
  if (normalized !== '/' && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  
  return normalized;
}

/**
 * Canonicalize a session .jsonl path so it can be used as a stable map key.
 *
 * The pool keys its in-memory `sessions` map by the session FILE PATH. That key
 * is produced by two independent producers that must agree on the exact string:
 *   1. the server itself (createNewSession/loadSession, via pi's SessionManager), and
 *   2. the CLI bridge extension, which reports `ctx.sessionManager.getSessionFile()`
 *      from whatever pi version the user's `pi` binary runs.
 *
 * pi >=0.80 canonicalizes the cwd before encoding the session directory name
 * (resolvePath: strips trailing slash, resolves `.`/`..`), whereas <0.80 encoded
 * the raw cwd. If the server SDK and the CLI are on different sides of that
 * change, the same logical session yields two different path strings, the map
 * keys don't collide, and the browser + CLI end up as two parallel sessions.
 *
 * Running everything through path.resolve() here makes both producers converge
 * on one key regardless of trailing slashes, `.`/`..` segments, or a future
 * version skew, without depending on symlink resolution (which could diverge if
 * only one side follows links). This is belt-and-suspenders on top of aligning
 * the SDK version.
 */
export function normalizeSessionFile(sessionFile: string): string {
  if (!sessionFile) return sessionFile;
  return path.resolve(sessionFile);
}

/** True only for a real Date with a finite (valid) time value. */
function isValidDate(d: Date | undefined | null): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * Convert a Date to an ISO string, tolerating invalid/missing dates.
 * Belt-and-suspenders guard: a single malformed session timestamp must never
 * crash listSessions(), even if a bad record slips past the upstream filter.
 */
function safeToISOString(d: Date | undefined | null): string {
  return isValidDate(d) ? d.toISOString() : new Date(0).toISOString();
}

export interface RemoteRepoRule {
  pattern: string;
  provider: 'github' | 'codeberg' | 'gitea' | 'forgejo';
  visibility?: 'private' | 'public';
}

export interface WhereverConfig {
  gitInitDefault?: boolean;
  remoteRepoRules?: RemoteRepoRule[];
  commonFolders?: string[];
  speech?: {
    apiKey?: string;
    apiUrl?: string;
    model?: string;
  };
  uploads?: {
    type?: 'tmp' | 'session' | 'custom';
    dir?: string;
    subDir?: string;
    method?: 'post' | 'websocket';
  };
  /**
   * Controls which files the `GET /session/download` endpoint will serve to a
   * client (phone/browser). Deny-by-default: a file is only served when its
   * REAL (symlink-resolved) path is inside one of the allowed roots. The
   * session's own cwd and the resolved upload dir are ALWAYS allowed; `roots`
   * adds extra roots. Tilde (~) is expanded. Set enabled:false to turn the
   * whole download feature off.
   */
  downloads?: {
    enabled?: boolean;
    roots?: string[];
    /** Max file size served, in bytes. Default 100 MiB. */
    maxBytes?: number;
  };
  /**
   * Waiting-for-human beep for the CLI bridge extension (read from this shared
   * config file by that extension). The web frontend has its own separate
   * localStorage-based beep config.
   */
  beep?: {
    /** Enable the beep by default for new CLI sessions. Overridden per-session by /remote-beep; the --remote-beep flag can also force it on. Default false. */
    enabled?: boolean;
    /** Shell command to play the sound (e.g. 'pw-play .../complete.oga'). Overrides the auto-detected player; --remote-beep-command overrides this. */
    command?: string;
  };
  /**
   * Conversation search (`GET /search`), backed by the memonaut index. This is
   * NOT related to `searchFolder` below (which is the "search mode" session
   * workspace); it controls full-text search over past transcripts.
   */
  conversationSearch?: {
    /**
     * Kick off an incremental index catch-up in a CHILD PROCESS after a search.
     * Never runs in-process: memonaut's indexer is synchronous and would block
     * every WebSocket client. Default true.
     */
    autoSync?: boolean;
    /** Minimum gap between background catch-ups, in ms. Default 60000. */
    syncIntervalMs?: number;
  };
  /** Folder used by "search mode" sessions. No default; must be set explicitly. */
  searchFolder?: string;
  /** When true, the on-demand search folder gets a remote, forced to private visibility. Default false. */
  searchCreateRemote?: boolean;
  /** Session listing controls. */
  sessions?: {
    /**
     * Glob patterns matched against a session's resolved cwd. Any session whose
     * cwd matches is fully excluded from the listing AND its folder is skipped
     * BEFORE its file bodies are read, so a large pile of throwaway sessions
     * (e.g. "/tmp/**") no longer slows down /sessions. Tilde (~) is expanded.
     * Empty/omitted = nothing ignored (no behaviour change).
     */
    ignore?: string[];
    /**
     * Glob patterns (same syntax as `ignore`) matched against a session's
     * resolved cwd. Matching sessions are HIDDEN from the default list (and,
     * like ignore, their folders are skipped before their bodies are read on
     * the default view), but remain viewable on a separate read-only page
     * (`/sessions?view=readonly`). Opening one is forced read-only: the server
     * refuses writes and the UI hides the composer. Intended for autonomous
     * fleets (e.g. agent-runner) you want to observe but not drive.
     */
    readOnly?: string[];
    /**
     * Retention for the LISTING only (nothing is ever deleted from disk):
     * session files not modified within the last `maxAgeDays` days, and
     * everything past the `maxSessions` most recently modified, are skipped
     * BEFORE their bodies are read. On a sessions directory that has grown for
     * months this is the difference between reading thousands of transcripts on
     * every cold pass (including the startup warm-up) and reading the handful
     * still in use. Both default to off (no limit).
     *
     * Opening a specific session by path or by short ID still works for an
     * excluded session: retention hides it from the list, it does not make it
     * unreachable.
     */
    maxAgeDays?: number;
    maxSessions?: number;
  };
}

/**
 * Convert a single glob pattern into a RegExp matched against a normalized,
 * absolute filesystem path. Supports `*` (does not cross a path separator),
 * `**` (crosses separators), and `?`. Tilde (`~`) is expanded to the home dir.
 * No new dependency: this is a deliberately small, path-oriented matcher.
 */
function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (g.startsWith('~')) {
    g = path.join(os.homedir(), g.slice(1));
  }
  // Normalize separators and collapse a trailing slash so "/tmp/" == "/tmp".
  g = g.replace(/\\/g, '/');
  if (g.length > 1 && g.endsWith('/')) g = g.slice(0, -1);

  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**` -> any chars including separators (optionally followed by a `/`).
        i++;
        if (g[i + 1] === '/') i++;
        re += '.*';
      } else {
        // `*` -> any chars except a path separator.
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Build a predicate that returns true when a resolved cwd should be IGNORED.
 * A cwd matches if it equals, or is nested under, any ignore glob. Patterns are
 * compiled once; an empty list yields a predicate that never matches.
 */
export function makeIgnoreMatcher(patterns: string[] | undefined): (cwd: string) => boolean {
  const globs = (patterns || []).filter((p) => typeof p === 'string' && p.trim().length > 0);
  if (globs.length === 0) return () => false;
  const regexps: RegExp[] = [];
  for (const g of globs) {
    try {
      // A pattern should ignore both the directory itself AND everything nested
      // under it, regardless of how it was written:
      //   "/tmp"      -> match "/tmp" and "/tmp/anything"
      //   "/tmp/**"   -> match "/tmp" and "/tmp/anything"
      //   "/tmp/*"    -> match "/tmp" and "/tmp/anything"
      // So we strip a trailing /* or /** to get the base, then add both the base
      // and a "/**" nested variant.
      const base = g.replace(/\/+\*{1,2}$/, '').replace(/\/+$/, '') || g;
      regexps.push(globToRegExp(base));
      regexps.push(globToRegExp(base + '/**'));
      // Also honour the pattern exactly as written (e.g. a mid-path glob).
      regexps.push(globToRegExp(g));
    } catch (err) {
      console.error(`Invalid sessions.ignore glob ${JSON.stringify(g)}:`, err);
    }
  }
  return (cwd: string) => {
    const norm = normalizePath(cwd).replace(/\\/g, '/');
    return regexps.some((re) => re.test(norm));
  };
}

/**
 * Read only the header (first line) of a session .jsonl to recover its
 * authoritative cwd, WITHOUT parsing the whole file. Returns '' if the header
 * is missing/unreadable. This is the cheap pre-filter that lets us skip an
 * ignored folder before reading its (potentially many, large) file bodies.
 */
async function readSessionCwdFromHeader(filePath: string): Promise<string> {
  const header = await readSessionHeader(filePath);
  return header?.cwd || '';
}

/**
 * Resolve a session's raw header cwd into a normalized absolute path, matching
 * how listSessions() buckets folders (tilde-expand; relative -> under home).
 */
export function resolveSessionCwd(rawCwd: string): string {
  const raw = rawCwd || '';
  let cwd = raw;
  if (raw.startsWith('~')) {
    cwd = path.join(os.homedir(), raw.slice(1));
  } else if (!path.isAbsolute(raw)) {
    cwd = path.join(os.homedir(), raw);
  }
  return normalizePath(cwd);
}

/**
 * One cached listing entry. `mtimeMs`+`size` is the validity stamp: a session
 * .jsonl is only ever APPENDED to, so an unchanged pair means the parsed info
 * is still exactly right and the (potentially huge) body never has to be read
 * again. `info: null` caches a known-bad file so it is not re-read either.
 */
interface DiskSessionCacheEntry {
  mtimeMs: number;
  size: number;
  info: DiskSessionInfo | null;
}

/**
 * Process-wide cache of parsed session-listing info, keyed by absolute file
 * path. Without it, EVERY `/sessions` request re-read and re-parsed every
 * session file on disk (measured: ~1.1 GB / 341k JSON lines / ~7s of blocking
 * work on a real sessions dir), and the dashboard refetches that list on every
 * `sessions_updated` broadcast. Entries for files that disappear from disk are
 * evicted at the end of each scan, so the cache stays proportional to the
 * sessions that actually exist.
 */
const diskSessionCache = new Map<string, DiskSessionCacheEntry>();

/**
 * Per-directory cwd probe cache. A session directory name is a stable encoding
 * of its cwd and every session inside shares that cwd, so one header probe
 * decides the whole folder forever (until the directory itself goes away).
 */
const dirCwdCache = new Map<string, string>();

/**
 * Scans currently running, keyed by `sessionsRoot::label`. `label` identifies
 * the FILTER (the view), so callers that want the same view share one pass
 * instead of each paying for its own: N dashboard tabs reconnecting at once,
 * or a burst of requests during the first (cold) scan after a restart, would
 * otherwise all parse the same files concurrently. A joiner gets the snapshot
 * of the in-flight pass, so it can be at most one scan-duration stale, which is
 * the same freshness guarantee a request arriving a moment earlier would get.
 */
const inFlightScans = new Map<string, Promise<DiskSessionInfo[]>>();

/**
 * Number of session BODIES read (streamed + parsed) since the last reset. The
 * whole point of the cache is that this stays at 0 on a warm pass, so it is the
 * thing tests assert on. Counting the IO primitive instead would conflate a
 * body read with the cheap header probe, which also opens a file.
 */
let sessionBodyReads = 0;

/** Test seam: how many session bodies have been read since the last reset. */
export function getSessionBodyReadCount(): number {
  return sessionBodyReads;
}

/**
 * Per-FOLDER existence cache: does this working folder exist on this machine?
 *
 * The third cache of the listing pass, and it exists for the same reason as the
 * other two. Transcripts and the folders they name travel separately, so on a
 * migrated machine most folders are absent and the browser marks them -- but a
 * session directory holds THOUSANDS of sessions and the dashboard refetches the
 * whole list on every `sessions_updated`, so a `stat` per session would put a
 * syscall storm back into the pass the (mtime, size) cache exists to keep free
 * of IO. One check per DISTINCT folder path, remembered briefly.
 *
 * Keyed by the same normalized cwd the listing groups folders under
 * (`resolveSessionCwd`), so a caller holding a differently-spelled path
 * (a trailing slash, a `~`, a `..` segment) invalidates the entry it means.
 *
 * No eviction pass, unlike the file cache above: an entry is a boolean and a
 * timestamp under a path, and the keys are the DISTINCT working folders seen
 * since boot (hundreds, where the file cache holds thousands of parsed
 * transcripts). A folder that stops being listed simply stops being asked about.
 */
const folderExistenceCache = new Map<string, { exists: boolean; checkedAt: number }>();

/**
 * How long an existence answer is reused. A folder that reappears by means
 * wherever knows nothing about (the user cloned it in a terminal, a mount came
 * back) loses its mark within this window with no invalidation at all, while a
 * burst of listing refetches -- the dashboard's own `sessions_updated` is
 * throttled to 2s -- costs one `stat` per distinct folder rather than one per
 * request. A restore completing does not wait for it: it invalidates the entry
 * (see `invalidateFolderExistence`).
 */
const FOLDER_EXISTENCE_TTL_MS = 10_000;

/**
 * Number of folder-existence `stat`s performed since the last reset. The cost
 * is the property under test (one per distinct folder, not one per session), so
 * it is counted rather than inferred.
 */
let folderExistenceChecks = 0;

/** Test seam: how many folder-existence checks have been performed. */
export function getFolderExistenceCheckCount(): number {
  return folderExistenceChecks;
}

/**
 * Forget the cached existence of one folder, so the next listing pass re-checks
 * it. Called when a RESTORE JOB SETTLES: that is the one moment wherever itself
 * changes whether a folder is there, and waiting out the TTL would leave the
 * mark on a folder the user just restored.
 */
export function invalidateFolderExistence(dir: string): void {
  folderExistenceCache.delete(resolveSessionCwd(dir));
}

/**
 * Stamp each listed folder with whether it EXISTS on this machine.
 *
 * `folders` is already one entry per distinct cwd (that is what `buildFolders`
 * produces), so this is one check per folder by construction -- the sessions
 * inside it are never consulted. A path that exists but is NOT a directory
 * counts as missing, the same rule the session-load check applies: it cannot be
 * a working folder either.
 */
export async function annotateFolderExistence(folders: FolderWithSessions[]): Promise<void> {
  const now = Date.now();
  await Promise.all(
    folders.map(async (folder) => {
      const key = resolveSessionCwd(folder.path);
      const cached = folderExistenceCache.get(key);
      if (cached && now - cached.checkedAt < FOLDER_EXISTENCE_TTL_MS) {
        folder.missing = !cached.exists;
        return;
      }
      folderExistenceChecks++;
      let exists = false;
      try {
        exists = (await fs.promises.stat(key)).isDirectory();
      } catch {
        exists = false;
      }
      folderExistenceCache.set(key, { exists, checkedAt: Date.now() });
      folder.missing = !exists;
    }),
  );
}

/** Test seam: drop all cached listing state. */
export function clearSessionIndexCache(): void {
  diskSessionCache.clear();
  dirCwdCache.clear();
  inFlightScans.clear();
  folderExistenceCache.clear();
  sessionBodyReads = 0;
  folderExistenceChecks = 0;
}

/**
 * Yield to the event loop. The scan runs on the same thread that serves the
 * WebSocket, so a cold pass must never hold the loop: a blocked loop is exactly
 * what made "Loading session..." hang while the browser hammered /sessions.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Session count above which startup points at the retention settings. Chosen to
 * be well past "a busy few months" so it is a real signal, not noise.
 */
const WARN_SESSION_COUNT = 1000;

/** How many files to parse between event-loop yields during a cold scan. */
const SCAN_YIELD_EVERY = 8;
/** Only log scan stats when a pass did real work (avoids a per-request log). */
const SCAN_LOG_MIN_READS = 10;

/**
 * Optional retention limits for a listing pass. Both are OFF by default (no
 * behaviour change). They are applied from the file's mtime BEFORE any body is
 * read, so an excluded session costs a `stat` and nothing else: on a corpus
 * that has been growing since May, that is the difference between reading
 * thousands of transcripts at startup and reading the handful still in use.
 */
export interface SessionRetention {
  /** Ignore session files not modified within the last N days. */
  maxAgeDays?: number;
  /** Keep at most the N most recently modified session files. */
  maxSessions?: number;
}

/**
 * Scan the sessions root and return listing info for every session whose folder
 * passes `folderWanted`. Async, cached and yielding: a warm pass is a `stat`
 * per file (milliseconds), and even a cold pass never blocks the event loop.
 */
export function scanDiskSessions(
  sessionsRoot: string,
  folderWanted: (cwd: string) => boolean,
  label: string,
  retention?: SessionRetention,
): Promise<DiskSessionInfo[]> {
  const key = `${sessionsRoot}::${label}`;
  const running = inFlightScans.get(key);
  if (running) return running;
  const scan = runDiskScan(sessionsRoot, folderWanted, label, retention).finally(() => {
    inFlightScans.delete(key);
  });
  inFlightScans.set(key, scan);
  return scan;
}

async function runDiskScan(
  sessionsRoot: string,
  folderWanted: (cwd: string) => boolean,
  label: string,
  retention?: SessionRetention,
): Promise<DiskSessionInfo[]> {
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const started = Date.now();
  const seenFiles = new Set<string>();
  const seenDirs = new Set<string>();
  const infos: DiskSessionInfo[] = [];
  // (path, stat) of every session file that survived the folder pre-filter.
  // Collected first so retention can be decided on metadata alone.
  const candidates: { filePath: string; mtimeMs: number; size: number; mtime: Date }[] = [];
  let prunedFolders = 0;
  let readCount = 0;
  let parsedSinceYield = 0;

  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory()) continue;
    const dirPath = path.join(sessionsRoot, dirEntry.name);
    let files: string[];
    try {
      files = (await fs.promises.readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    seenDirs.add(dirPath);
    for (const f of files) seenFiles.add(path.join(dirPath, f));

    // Cheap pre-filter: one header probe (cached per directory) recovers the
    // authoritative cwd for the whole folder. Unwanted folders are skipped
    // before any file body is read.
    let probeCwd = dirCwdCache.get(dirPath);
    if (probeCwd === undefined) {
      probeCwd = resolveSessionCwd(await readSessionCwdFromHeader(path.join(dirPath, files[0])));
      dirCwdCache.set(dirPath, probeCwd);
    }
    if (probeCwd && !folderWanted(probeCwd)) {
      prunedFolders++;
      continue;
    }

    for (const f of files) {
      const filePath = path.join(dirPath, f);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      candidates.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size, mtime: stats.mtime });
    }
  }

  // Retention, applied on (cheap) stat metadata BEFORE any body is read.
  let kept = candidates;
  if (retention?.maxAgeDays && retention.maxAgeDays > 0) {
    const cutoff = Date.now() - retention.maxAgeDays * 24 * 60 * 60 * 1000;
    kept = kept.filter((c) => c.mtimeMs >= cutoff);
  }
  if (retention?.maxSessions && retention.maxSessions > 0 && kept.length > retention.maxSessions) {
    kept = [...kept].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, retention.maxSessions);
  }
  const droppedByRetention = candidates.length - kept.length;

  for (const c of kept) {
    const cached = diskSessionCache.get(c.filePath);
    let info: DiskSessionInfo | null;
    if (cached && cached.mtimeMs === c.mtimeMs && cached.size === c.size) {
      info = cached.info;
    } else {
      // Streaming, bounded-memory read: never materialize the transcript (see
      // session-transcript.ts). This is the pass that used to peak near 1 GB of
      // RSS at startup on a 2 GB sessions directory.
      //
      // ONE bad file must cost ONE session, never the listing. An IO error
      // (EIO on a flaky disk, EACCES on a file another user owns) rejects the
      // read, and this scan's promise is SHARED by every concurrent waiter for
      // this view (inFlightScans), so letting it escape would turn a single
      // unreadable transcript into a 500 for the whole dashboard. Skip the file
      // and do NOT cache the failure: a transient error should be retried on
      // the next pass, unlike an unparseable file (cached as `info: null`).
      try {
        info = await readSessionListingInfo(c.filePath, c.mtime);
      } catch (err) {
        console.error(`[wherever] skipping unreadable session ${c.filePath}:`, err);
        continue;
      }
      diskSessionCache.set(c.filePath, { mtimeMs: c.mtimeMs, size: c.size, info });
      readCount++;
      sessionBodyReads++;
      if (++parsedSinceYield >= SCAN_YIELD_EVERY) {
        parsedSinceYield = 0;
        await yieldToEventLoop();
      }
    }
    if (!info) continue;
    // Defensive per-session re-check (mixed/edge cases the folder probe missed).
    if (!folderWanted(resolveSessionCwd(info.cwd))) continue;
    infos.push(info);
  }

  // Evict entries whose files/directories are gone (deleted sessions).
  for (const key of diskSessionCache.keys()) {
    if (!seenFiles.has(key)) diskSessionCache.delete(key);
  }
  for (const key of dirCwdCache.keys()) {
    if (!seenDirs.has(key)) dirCwdCache.delete(key);
  }

  if (readCount >= SCAN_LOG_MIN_READS) {
    console.log(
      `[wherever] ${label}: parsed ${readCount} changed session file(s) of ${seenFiles.size}` +
        `${prunedFolders > 0 ? `, skipped ${prunedFolders} folder(s)` : ''}` +
        `${droppedByRetention > 0 ? `, ${droppedByRetention} outside retention` : ''}` +
        ` in ${Date.now() - started}ms`,
    );
  }
  return infos;
}

/**
 * Directory holding `config.json`. `WHEREVER_CONFIG_DIR` overrides the default
 * `~/.wherever` so a test server can run in FULL isolation (ADR 0001): without
 * it, an isolated harness still reads the developer's real config, so e.g. a
 * personal `sessions.ignore: ["/tmp/**"]` silently hid the harness's own
 * temp-dir sessions from /sessions.
 */
export function getWhereverConfigDir(): string {
  const override = process.env.WHEREVER_CONFIG_DIR;
  return override && override.trim() ? path.resolve(override.trim()) : path.join(os.homedir(), '.wherever');
}

/**
 * Directory holding everything the RUNNING SERVER WRITES (drafts, generated
 * self-signed certs). Separate from the CONFIG directory because the two have
 * opposite requirements once the server is deployed declaratively: config is
 * rendered by the deployment (on NixOS, by sops-nix into a root-owned 0400 file
 * under /run) and is READ-ONLY to the service, while state must be writable and
 * must survive across activations. See docs/adr/0006.
 *
 * `WHEREVER_STATE_DIR` overrides it. It DEFAULTS to `getWhereverConfigDir()`,
 * so every existing install (and every existing test that only sets
 * `WHEREVER_CONFIG_DIR`) keeps writing exactly where it does today.
 */
export function getWhereverStateDir(): string {
  const override = process.env.WHEREVER_STATE_DIR;
  return override && override.trim() ? path.resolve(override.trim()) : getWhereverConfigDir();
}

/**
 * Directory holding the AUTO-GENERATED self-signed TLS pair. It is under the
 * STATE dir, not the config dir: these files are written by the server at boot.
 * (It used to be built from `os.homedir()` directly, so `WHEREVER_CONFIG_DIR`
 * did not move it and an isolated server still wrote into the developer's real
 * `~/.wherever`. With both variables unset this resolves to the same
 * `~/.wherever/certs` as before.) Explicit `--ssl-key`/`--ssl-cert` paths
 * bypass this entirely.
 */
export function getWhereverCertsDir(): string {
  return path.join(getWhereverStateDir(), 'certs');
}

export function getWhereverConfig(): WhereverConfig {
  const configDir = getWhereverConfigDir();
  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      const defaultConfig: WhereverConfig = {
        gitInitDefault: false,
        remoteRepoRules: [],
        commonFolders: []
      };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
      return defaultConfig;
    } catch (err) {
      // A READ-ONLY config dir is a supported deployment (the config is rendered
      // by the deployment and the service cannot write there), so seeding a
      // default must never be fatal, and must not look like a crash in the log.
      console.warn(
        `[wherever] could not seed a default config at ${configPath} ` +
          `(${(err as Error).message}); continuing with built-in defaults.`,
      );
    }
  } else {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      console.error('Failed to parse wherever config file:', err);
    }
  }
  return {};
}

const SEARCH_WORKSPACE_AGENTS_MD = `# Search workspace

This folder is a **search workspace**, not a coding project. Sessions started
here (from the wherever search bar, or via \`pisearch\`) exist to answer questions
with current information from the live web.

## How to behave here

- Use the **web-search skill**: lead with \`web_search\`, open the most promising
  1-3 results with \`web_fetch\` to verify, then answer.
- Answer the question **directly and concisely**, then list the **source URLs**
  you actually used. Prefer recent, authoritative sources; weight recency for
  time-sensitive questions.
- **Do not start a coding task** or edit files unless explicitly asked. There is
  no project to build here.
- If the web tools cannot reach Ollama (connection refused / 401), say so and
  tell the user to start Ollama or run \`ollama signin\`. Do not silently answer
  from memory without flagging it.
`;

/**
 * If resolvedCwd is the configured search folder, drop a default AGENTS.md into
 * it when none exists. Resolves the config's searchFolder (tilde-expanded) and
 * compares it to resolvedCwd via normalizePath. Best-effort: never throws, never
 * overwrites an existing AGENTS.md.
 */
export function maybeSeedSearchWorkspace(resolvedCwd: string): void {
  try {
    const config = getWhereverConfig();
    let searchFolder = config.searchFolder;
    if (!searchFolder) return;
    if (searchFolder.startsWith('~')) {
      searchFolder = path.join(os.homedir(), searchFolder.slice(1));
    }
    if (normalizePath(searchFolder) !== normalizePath(resolvedCwd)) return;
    const agentsPath = path.join(resolvedCwd, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) return;
    fs.writeFileSync(agentsPath, SEARCH_WORKSPACE_AGENTS_MD, 'utf8');
    console.log(`Seeded search workspace AGENTS.md in ${resolvedCwd}`);
  } catch (err) {
    console.error('Failed to seed search workspace AGENTS.md:', err);
  }
}

export function setupUpstreamTracking(resolvedCwd: string) {
  try {
    let defaultBranch = '';
    try {
      defaultBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: resolvedCwd }).toString().trim();
    } catch (e) {
      try {
        defaultBranch = execFileSync('git', ['config', '--get', 'init.defaultBranch'], { cwd: resolvedCwd }).toString().trim();
      } catch (e2) {}
    }
    if (!defaultBranch) {
      defaultBranch = 'main'; // fallback
    }

    execFileSync('git', ['config', `branch.${defaultBranch}.remote`, 'origin'], { cwd: resolvedCwd, stdio: 'ignore' });
    execFileSync('git', ['config', `branch.${defaultBranch}.merge`, `refs/heads/${defaultBranch}`], { cwd: resolvedCwd, stdio: 'ignore' });
    console.log(`Successfully pre-configured branch '${defaultBranch}' upstream tracking to origin`);
  } catch (err) {
    console.error('Failed to pre-configure upstream tracking branch:', err);
  }
}

/**
 * Resolve the authenticated user for a Codeberg/Gitea/Forgejo provider using the
 * same `tea`/`cb` CLIs the create path uses. Returns '' when it cannot be
 * determined (callers fall back to a placeholder or skip).
 */
function resolveGiteaUser(): string {
  try {
    return execFileSync('tea', ['whoami']).toString().trim().split(/\s+/).pop() || '';
  } catch (e) {
    try {
      return execFileSync('cb', ['auth', 'whoami']).toString().trim().split(/\s+/).pop() || '';
    } catch (e2) {
      return '';
    }
  }
}

export type RemoteRepoProbe =
  | { exists: true; sshUrl: string }
  | { exists: false; sshUrl?: undefined };

/**
 * Probe whether the remote repository that WOULD be created for `resolvedCwd`
 * under `rule` already exists, mirroring the owner-resolution used by the create
 * path (gh's authenticated user for GitHub; `tea`/`cb` whoami for Gitea-family).
 * On success returns the SSH clone URL (preferred for cloning). Network/CLI
 * failures are treated as "does not exist" so the caller falls back to creation.
 */
export function detectRemoteRepo(rule: RemoteRepoRule, repoName: string): RemoteRepoProbe {
  const provider = rule.provider;
  try {
    if (provider === 'github') {
      // `gh repo view` resolves the owner to the authenticated user just like
      // `gh repo create "<name>"` does. --json sshUrl gives us the SSH remote.
      const out = execFileSync('gh', ['repo', 'view', repoName, '--json', 'sshUrl', '-q', '.sshUrl'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      if (out) return { exists: true, sshUrl: out };
      return { exists: false };
    }

    if (provider === 'codeberg' || provider === 'gitea' || provider === 'forgejo') {
      const domain = provider === 'codeberg' ? 'codeberg.org' : 'gitea.com';
      const user = resolveGiteaUser();
      if (!user) return { exists: false };
      // `tea repo` / `cb repo` existence check. If either lists the repo, it
      // exists; construct the SSH URL the same way the create path does.
      let exists = false;
      try {
        const teaList = execFileSync('tea', ['repo', 'ls', '--output', 'simple'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
        const target = `${user}/${repoName}`.toLowerCase();
        if (teaList.split('\n').some(l => l.trim().toLowerCase().endsWith(target))) {
          exists = true;
        }
      } catch (e) {
        try {
          const cbList = execFileSync('cb', ['repo', 'list'], {
            stdio: ['ignore', 'pipe', 'ignore'],
          }).toString();
          if (cbList.toLowerCase().includes(`${user}/${repoName}`.toLowerCase())) {
            exists = true;
          }
        } catch (e2) {}
      }
      if (exists) {
        return { exists: true, sshUrl: `git@${domain}:${user}/${repoName}.git` };
      }
      return { exists: false };
    }
  } catch (e) {
    // Not found / not authenticated / CLI missing: treat as non-existent.
  }
  return { exists: false };
}

// NOTE: there is deliberately NO clone helper here any more. Cloning a remote
// into a folder is ONE implementation, the path-keyed restore job registry
// (`restore-jobs.ts`, `docs/adr/0009`), driven from the WebSocket/HTTP layer
// BEFORE session creation is asked for. The synchronous `cloneRemoteRepo()`
// that used to live here cloned non-recursively, reported no progress and blew
// past the client's create watchdog on any large repository; keeping it beside
// the registry would have meant two divergent clones, which is exactly the
// drift the registry exists to end. `setupUpstreamTracking` above is still used
// by the remote-CREATION path (a brand new repository); the registry configures
// tracking for a clone itself.

import { createAgentSession, AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent';
import type { BashOperations } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createAttachFileTool } from './attach-file-tool.js';
import { createSayTool } from './say-tool.js';
import { createConversationModeSignal, type ConversationModeSignal } from './conversation-mode-hint.js';
import { matchRemoteRepoRule } from './remote-candidates.js';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { SessionMessageEntry, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { SessionInfo, HistoryMessage, FolderWithSessions, ModelInfo, FolderSessionInfo, ContextUsageInfo, SkillCommand } from './session-types.js';
import type { WebSocket } from 'ws';

export interface ServerTrackedSession {
  type: 'server';
  sessionId: string;
  sessionFile: string;
  cwd: string;
  model: string;
  agentSession: AgentSession;
  clients: Set<string>;
  isIdle: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  eventUnsubscribe: () => void;
  createdAt: number;
  lastActivity: number;
  // Number of tool executions currently IN FLIGHT (tool_execution_start seen,
  // matching tool_execution_end not yet). > 0 means a tool call is running right
  // now. Used to decide, on a CLI takeover, whether an actual tool call was
  // interrupted (which leaves a dangling toolCall in the transcript), as opposed
  // to merely streaming assistant text (a normal, resumable state). Mirrors the
  // CLI's findDanglingToolCalls warning trigger.
  inFlightToolCount: number;
  // Per-turn conversation-mode signal for this session: armed from the message's
  // optional `conversationMode` flag and consumed by the inline extension's
  // before_agent_start hook, which appends the spoken-conversation hint to that
  // turn's system prompt. See conversation-mode-hint.ts.
  conversationSignal: ConversationModeSignal;
}

export interface CliTrackedSession {
  type: 'cli';
  sessionId: string;
  sessionFile: string;
  cwd: string;
  model: string;
  clients: Set<string>;
  isIdle: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  lastActivity: number;
  cliWs: WebSocket;
  isStreaming: boolean;
  // Latest context-usage snapshot reported by the CLI bridge (the server does
  // not run the agent for CLI sessions, so it cannot compute this itself).
  contextUsage?: ContextUsageInfo | null;
}

export type TrackedSession = ServerTrackedSession | CliTrackedSession;

export class SessionPool {
  private sessions = new Map<string, TrackedSession>();
  private pendingSessions = new Map<string, Promise<{ tracked: TrackedSession; error?: string }>>();
  private pendingCreateSessions = new Map<string, Promise<{ tracked: TrackedSession; error?: string; sessionFile?: string }>>();
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private agentDir: string;
  private idleTimeoutMs: number;

  // Pending `!sudo ...` commands awaiting a password from the client, keyed by a
  // one-shot promptId. The password never lives here: only the (password-free)
  // command and enough context to run it once the client replies. Entries are
  // removed as soon as the password arrives or the prompt is cancelled. A client
  // can also simply vanish (phone sleeps, tab closes) leaving its prompt
  // unanswered forever, so there are two backstops: the entry is dropped when
  // its session is destroyed (idle eviction, so it is bounded by the session's
  // own lifetime), and any entry past the TTL is swept when the next prompt is
  // armed. Small, but this is the one map here with no other bound.
  private pendingSudo = new Map<
    string,
    { sessionFileOrId: string; command: string; excludeFromContext: boolean; armedAt: number }
  >();

  /** How long an unanswered sudo prompt survives, if its session outlives it. */
  private static readonly SUDO_PROMPT_TTL_MS = 30 * 60_000;

  onEvent?: (sessionFile: string, event: AgentSessionEvent) => void;

  constructor(idleTimeoutMs = 300_000) {
    this.agentDir = getAgentDir();
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
    this.idleTimeoutMs = idleTimeoutMs;
  }

  async initialize(): Promise<void> {
    this.modelRegistry.refresh();
    this.warmSessionIndex();
  }

  /** Resolve the on-disk sessions directory (agentDir/sessions). Session files
   * always live here as <subdir>/*.jsonl, so deletion/operations on a session
   * file are scoped to this root to prevent deleting arbitrary .jsonl files. */
  getSessionsDir(): string {
    return path.join(this.agentDir, 'sessions');
  }

  /** True iff `resolvedFile` is a .jsonl file inside the sessions directory. */
  isSessionFile(resolvedFile: string): boolean {
    if (!resolvedFile.endsWith('.jsonl')) return false;
    const sessionsDir = this.getSessionsDir();
    const normalized = path.resolve(resolvedFile);
    return normalized === sessionsDir || normalized.startsWith(sessionsDir + path.sep);
  }

  /**
   * Populate the session-listing cache in the background at startup, so the
   * first dashboard load does not pay for the one cold pass over the sessions
   * directory (seconds on a large one). Deliberately not awaited: the scan
   * yields to the event loop, so the server accepts connections throughout, and
   * a request arriving mid-warm-up joins this same pass instead of duplicating
   * it (see inFlightScans).
   */
  private warmSessionIndex(): void {
    void this.listSessions('default')
      .then((folders) => {
        const count = folders.reduce((n, f) => n + f.sessions.length, 0);
        const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[wherever] session index warm: ${count} session(s) listed, RSS ${rssMb} MB`);
        // The sessions directory only ever grows, and every cold pass has to
        // look at all of it. Say so ONCE, at startup, with the two levers --
        // rather than leaving an operator to discover the cost when the machine
        // is already thrashing.
        const cfg = getWhereverConfig().sessions;
        if (count >= WARN_SESSION_COUNT && !cfg?.maxAgeDays && !cfg?.maxSessions) {
          console.log(
            `[wherever] tip: ${count} sessions is a lot to scan. Set sessions.maxAgeDays and/or ` +
              `sessions.maxSessions in ~/.wherever/config.json to bound the listing (nothing is ` +
              `deleted; older sessions stay openable by path/ID). See docs/USAGE.md.`,
          );
        }
      })
      .catch(() => {
        /* warm-up is best-effort: a real request will retry and report. */
      });
  }

  /**
   * List available models. `isDefault` is resolved against `cwd` (falling back to
   * the server's process cwd), so a folder-local harness/pi config default is
   * honored, not just the server global default.
   */
  getAvailableModels(cwd?: string): ModelInfo[] {
    const available = this.modelRegistry.getAvailable();
    const settings = SettingsManager.create(cwd || process.cwd(), this.agentDir);
    const defaultProvider = settings.getDefaultProvider();
    const defaultModel = settings.getDefaultModel();

    return available.map((m: Model<Api>) => {
      const isDefault = m.provider === defaultProvider && m.id === defaultModel;
      return {
        provider: m.provider,
        modelId: m.id,
        label: `${this.modelRegistry.getProviderDisplayName(m.provider)}: ${m.name}`,
        isDefault,
      };
    });
  }

  /**
   * Resolve the default model (as "provider:modelId") for a given folder, using
   * that folder's resolved settings (folder-local harness/pi config wins over the
   * server global). Returns null when no default is configured or the resolved
   * model is not among the available models.
   */
  getDefaultModelFor(cwd: string): string | null {
    const settings = SettingsManager.create(cwd, this.agentDir);
    const defaultProvider = settings.getDefaultProvider();
    const defaultModel = settings.getDefaultModel();
    if (!defaultProvider || !defaultModel) return null;
    const found = this.modelRegistry
      .getAvailable()
      .some((m: Model<Api>) => m.provider === defaultProvider && m.id === defaultModel);
    return found ? `${defaultProvider}:${defaultModel}` : null;
  }

  findModel(provider: string, modelId: string): Model<Api> | undefined {
    return this.modelRegistry.find(provider, modelId);
  }

  /**
   * Resolve a session identifier (short ID/name OR an absolute .jsonl path) to a
   * canonical absolute session file path, without building an agent.
   */
  private async resolveSessionFile(sessionFile: string): Promise<{ resolvedFile?: string; error?: string }> {
    let resolvedFile = sessionFile;
    if (!sessionFile.includes('/') && !sessionFile.includes('\\') && !sessionFile.endsWith('.json') && !sessionFile.endsWith('.jsonl')) {
      const active = Array.from(this.sessions.values()).find(s => s.sessionId === sessionFile);
      if (active) {
        resolvedFile = active.sessionFile;
      } else {
        const found = await this.findDiskSessionByIdOrName(sessionFile);
        if (found) {
          resolvedFile = found.path;
        } else {
          return { error: `Session with ID "${sessionFile}" not found` };
        }
      }
    }
    return { resolvedFile: normalizeSessionFile(resolvedFile) };
  }

  /**
   * Does this session's working folder still EXIST on this machine?
   *
   * Transcripts and the folders they refer to travel separately: a transcript
   * syncs (syncthing, a backup, a new laptop), the git clone it talks about does
   * not. pi's `SettingsManager.create()` and `DefaultResourceLoader.reload()`
   * both SUCCEED against a nonexistent cwd, so a missing folder throws nothing
   * and only shows up later as every file/bash tool misbehaving. Answering it
   * here, beside the read-only verdict in the cheap meta read, costs one stat.
   *
   * A path that exists but is NOT a directory counts as missing: it cannot be a
   * cwd either, and the honest lock is strictly better than an agent built on
   * it. (`stat` follows symlinks, so a link to a real directory exists and a
   * dangling one does not, which is what a user means by "the folder is there".)
   */
  private async folderExists(cwd: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(resolveSessionCwd(cwd));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * CHEAP read of a session's metadata + history WITHOUT building a live agent.
   * Opening a session for VIEWING only needs the header (id/cwd/model) and the
   * transcript (a file read); instantiating the agent (createAgentSession ->
   * extension/MCP load) is seconds and only needed to SEND. Splitting the two
   * lets the UI paint the conversation immediately and build the agent lazily
   * (see docs/plan-speed-up-long-session-load.md). Reads from a resident session
   * when present so a warm session stays a warm read.
   */
  async readSessionMeta(
    sessionFile: string,
    limit: number,
    modelStr?: string,
  ): Promise<
    | {
        sessionFile: string;
        sessionId: string;
        cwd: string;
        model: string;
        history: { messages: HistoryMessage[]; totalCount: number; offset: number };
        readOnly: boolean;
        /**
         * True when `cwd` does not exist on this machine. The THIRD read-only
         * reason (see folderExists above): reading the conversation never needed
         * the folder, but no live agent may be built for it and no client may be
         * given a write capability on it. Reported for a resident session too:
         * the check lives here so the warm and cold load branches share it.
         */
        folderMissing: boolean;
        resident: boolean;
      }
    | { error: string }
  > {
    const resolved = await this.resolveSessionFile(sessionFile);
    if (resolved.error || !resolved.resolvedFile) {
      return { error: resolved.error ?? 'Could not resolve session' };
    }
    const resolvedFile = resolved.resolvedFile;

    const residentTracked = this.sessions.get(resolvedFile);
    if (residentTracked) {
      return {
        sessionFile: resolvedFile,
        sessionId: residentTracked.sessionId,
        cwd: residentTracked.cwd,
        model: residentTracked.model,
        history: await this.getSessionHistoryWindow(resolvedFile, limit),
        readOnly: this.isReadOnlyCwd(residentTracked.cwd),
        folderMissing: !(await this.folderExists(residentTracked.cwd)),
        resident: true,
      };
    }

    try {
      // ONE streaming pass over the transcript yields the header, the last
      // model_change and the history window. This used to be three whole-file
      // loads (`SessionManager.open` alone reads and parses the file twice) plus
      // a full `HistoryMessage[]` of every entry, base64 tool images included,
      // just to slice the last 60 off the end.
      const read = await readTranscriptWindow(resolvedFile, limit);
      if (!read.header) {
        return { error: 'Session file has no header' };
      }
      const sessionId = read.header.id;
      const cwd = normalizePath(read.header.cwd || process.cwd());
      const model = modelStr || read.model;
      const history = { messages: read.messages, totalCount: read.totalCount, offset: read.offset };
      return {
        sessionFile: resolvedFile,
        sessionId,
        cwd,
        model,
        history,
        readOnly: this.isReadOnlyCwd(cwd),
        folderMissing: !(await this.folderExists(cwd)),
        resident: false,
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async loadSession(sessionFile: string, cwd?: string, modelStr?: string): Promise<{ tracked: TrackedSession; error?: string }> {
    let resolvedFile = sessionFile;

    // Resolve short session ID/name (no path delimiters and doesn't end in .json or .jsonl) to full absolute path
    if (!sessionFile.includes('/') && !sessionFile.includes('\\') && !sessionFile.endsWith('.json') && !sessionFile.endsWith('.jsonl')) {
      // 1. Check if the session is already active in memory
      const active = Array.from(this.sessions.values()).find(s => s.sessionId === sessionFile);
      if (active) {
        resolvedFile = active.sessionFile;
      } else {
        // 2. Scan the disk to find the session with the matching ID/name
        const found = await this.findDiskSessionByIdOrName(sessionFile);
        if (found) {
          resolvedFile = found.path;
        } else {
          return { tracked: null as any, error: `Session with ID "${sessionFile}" not found` };
        }
      }
    }

    // Canonicalize the resolved path so the map key matches the one the CLI
    // bridge reports for the same session (see normalizeSessionFile).
    resolvedFile = normalizeSessionFile(resolvedFile);

    // Continue with the resolved absolute path
    if (this.sessions.has(resolvedFile)) {
      return { tracked: this.sessions.get(resolvedFile)! };
    }

    if (this.pendingSessions.has(resolvedFile)) {
      return this.pendingSessions.get(resolvedFile)!;
    }

    const loadPromise = (async () => {
      try {
        const sessionManager = SessionManager.open(resolvedFile);
        const header = sessionManager.getHeader();

        if (!header) {
          return { tracked: null as any, error: 'Session file has no header' };
        }

        const sessionCwd = cwd || header.cwd || process.cwd();
        const normalizedCwd = normalizePath(sessionCwd);
        let model: Model<Api> | undefined;

        if (modelStr) {
          const parsed = this.parseModelStr(modelStr);
          if (parsed) {
            model = this.modelRegistry.find(parsed.provider, parsed.id);
          }
        }

        if (!model && header) {
          // Walk BACKWARDS in place for the last model_change. `[...entries]` +
          // reverse() copied the entire entry array (hundreds of thousands of
          // elements on a long session) to read one field. Note this path DOES
          // hold the whole transcript in memory, unavoidably: `SessionManager`
          // is what the live agent runs on and it needs the full context. That
          // is the AGENT-BUILD path; the VIEW path (readSessionMeta) never loads
          // it, which is why opening a session to read is now cheap even when
          // building its agent is not.
          const entries = sessionManager.getEntries();
          for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i] as SessionEntry;
            if (e.type !== 'model_change') continue;
            if ('provider' in e && 'modelId' in e) {
              model = this.modelRegistry.find(e.provider, e.modelId);
            }
            break;
          }
        }

        const settingsManager = SettingsManager.create(normalizedCwd, this.agentDir);
        // The conversation-mode signal is an INLINE pi extension (the SDK-supported
        // way to get a before_agent_start hook on a server-created session, the
        // counterpart of the pi.on(...) the CLI-bridge extension registers). It is
        // per session, so the armed flag can never cross sessions.
        const conversationSignal = createConversationModeSignal();
        const resourceLoader = new DefaultResourceLoader({
          cwd: normalizedCwd,
          agentDir: this.agentDir,
          settingsManager,
          extensionFactories: [conversationSignal.inlineExtension],
        });
        await resourceLoader.reload();

        const { session: agentSession } = await createAgentSession({
          cwd: normalizedCwd,
          authStorage: this.authStorage,
          modelRegistry: this.modelRegistry,
          model,
          sessionManager,
          settingsManager,
          resourceLoader,
          // Register attach_file + say for server-created sessions (web frontend
          // with no CLI bridge). Both tools are self-contained; their UI affordance
          // (attach_file's download button, say's spoken-reply card) is driven by
          // the tool call reaching the web UI, no bridge/marker needed.
          customTools: [createAttachFileTool(normalizedCwd), createSayTool()],
        });

        const modelLabel = agentSession.model ? `${agentSession.model.provider}:${agentSession.model.id}` : '';

        const tracked: TrackedSession = {
          type: 'server',
          sessionId: agentSession.sessionId,
          sessionFile: resolvedFile,
          cwd: normalizedCwd,
          model: modelLabel,
          agentSession,
          clients: new Set(),
          isIdle: true,
          idleTimer: null,
          eventUnsubscribe: this.setupEventListeners(resolvedFile, agentSession),
          createdAt: Date.now(),
          lastActivity: Date.now(),
          inFlightToolCount: 0,
          conversationSignal,
        };

        this.sessions.set(resolvedFile, tracked);
        return { tracked };
      } catch (err) {
        return { tracked: null as any, error: (err as Error).message };
      } finally {
        this.pendingSessions.delete(resolvedFile);
      }
    })();

    this.pendingSessions.set(resolvedFile, loadPromise);
    return loadPromise;
  }

  /**
   * Start a session in `cwd`.
   *
   * By default this is "give me A session here": an occupied folder hands back
   * the session already running in it, so a caller that only wants to reach the
   * folder does not spawn a duplicate agent beside a live one.
   *
   * `forceNew` is the other intent: "give me a NEW conversation here". It always
   * writes a fresh session, even when the folder is occupied, because handing an
   * existing conversation to someone who explicitly asked for a new one is never
   * the answer they can act on (see the `session_new` handler in index.ts). The
   * folder-sharing risk that the dedupe used to prevent is carried by the
   * folder-conflict banner (read-only until "Continue anyway") instead.
   */
  async createNewSession(cwd: string, modelStr?: string, gitInit?: boolean, createRemote?: boolean, repoVisibility?: 'private' | 'public', forceNew?: boolean): Promise<{ tracked: TrackedSession; error?: string; sessionFile?: string }> {
    let resolvedCwd = cwd;
    if (cwd.startsWith('~')) {
      resolvedCwd = path.join(os.homedir(), cwd.slice(1));
    } else if (!path.isAbsolute(cwd)) {
      resolvedCwd = path.join(os.homedir(), cwd);
    } else {
      resolvedCwd = path.resolve(cwd);
    }

    resolvedCwd = normalizePath(resolvedCwd);

    if (!forceNew) {
      const existing = this.findActiveSessionByCwd(resolvedCwd);
      if (existing && existing.clients.size > 0) {
        return { tracked: existing };
      }
    }

    const pendingCreate = this.pendingCreateSessions.get(resolvedCwd);
    if (pendingCreate) {
      // A create for this folder is already running. Without forceNew, join it
      // (that is the double-submit guard). With forceNew we still WAIT for it --
      // it may be doing the mkdir / git init this folder needs -- and then
      // create our own session on top, so "new" stays new.
      if (!forceNew) return pendingCreate;
      await pendingCreate.catch(() => {});
    }

    const createPromise = (async () => {
      try {
        // CLONING an existing remote into this folder is NOT done here: it is a
        // restore job, run to completion by the caller BEFORE it asks for a
        // session (see `cloneForNewSession` in index.ts). By the time we are
        // called the folder either exists (cloned, or already there) or is ours
        // to create. Everything below is therefore the CREATE-A-REMOTE branch
        // and the plain-folder branch, unchanged.
        if (!fs.existsSync(resolvedCwd)) {
          fs.mkdirSync(resolvedCwd, { recursive: true });
        }

        // If this is the configured search folder, seed a default AGENTS.md so
        // search sessions behave correctly even in the browser path (where the
        // web-search skill is only discoverable, not preloaded). Self-healing:
        // re-created if the folder was deleted. Never clobbers an existing file.
        maybeSeedSearchWorkspace(resolvedCwd);

        // Git initialization if requested. A folder that was just cloned already
        // has a `.git`, so the existence guard below makes this a no-op there.
        if (gitInit) {
          try {
            if (!fs.existsSync(path.join(resolvedCwd, '.git'))) {
              execFileSync('git', ['init'], { cwd: resolvedCwd, stdio: 'ignore' });
              console.log(`Initialized empty Git repository in ${resolvedCwd}`);
            }
          } catch (err) {
            console.error(`Failed to initialize git repository in ${resolvedCwd}:`, err);
          }
        }

        // Check if we should create a remote repo (GitHub/Codeberg etc) based on
        // config patterns. A folder that was just CLONED already has an `origin`,
        // so the `hasOrigin` check below leaves it alone.
        const config = getWhereverConfig();
        if (createRemote !== false) {
          // Through the SHARED matcher, which expands a leading `~` in the rule
          // pattern (users write `~/dev/github/me/`, mirroring commonFolders) and
          // treats an invalid pattern as a non-match instead of throwing. Matching
          // here with a bare RegExp meant a rule matched in /check-path and
          // /check-remote-repo but NOT at the moment the session was actually
          // created -- so the dialog promised a remote the create then skipped.
          const rule = matchRemoteRepoRule(config.remoteRepoRules, resolvedCwd);
          if (rule) {
            const provider = rule.provider;
            const visibility = repoVisibility || rule.visibility || 'private';
            const repoName = path.basename(resolvedCwd);

            // Initialize Git if matching rules and not yet a Git repo
            if (!fs.existsSync(path.join(resolvedCwd, '.git'))) {
              try {
                execFileSync('git', ['init'], { cwd: resolvedCwd, stdio: 'ignore' });
                console.log(`Initialized empty Git repository in ${resolvedCwd} (due to matching remote rule)`);
              } catch (e) {
                console.error(`Failed to initialize git repository in ${resolvedCwd} for remote rule:`, e);
              }
            }

            // Check if remote already exists
            let hasOrigin = false;
            try {
              const remotes = execFileSync('git', ['remote'], { cwd: resolvedCwd }).toString();
              hasOrigin = remotes.split('\n').map(r => r.trim()).includes('origin');
            } catch (e) {}

            if (!hasOrigin) {
              if (provider === 'github') {
                try {
                  console.log(`Creating GitHub repository: ${repoName} (${visibility})...`);
                  execFileSync('gh', ['repo', 'create', repoName, `--${visibility}`, '--source=.', '--remote=origin'], { cwd: resolvedCwd, stdio: 'ignore' });
                  console.log(`Successfully created GitHub repo ${repoName} and added remote 'origin'`);
                  setupUpstreamTracking(resolvedCwd);
                } catch (err) {
                  console.error('Failed to create GitHub repository:', err);
                }
              } else if (provider === 'codeberg' || provider === 'gitea' || provider === 'forgejo') {
                try {
                  let created = false;
                  let repoUrl = '';
                  console.log(`Creating Codeberg/Gitea repository: ${repoName}...`);

                  try {
                    // Try tea CLI
                    const output = execFileSync('tea', ['repo', 'create', '--name', repoName, ...(visibility === 'private' ? ['--private'] : [])], { cwd: resolvedCwd }).toString();
                    created = true;
                    const urlMatch = output.match(/https?:\/\/\S+/i) || output.match(/git@\S+/i);
                    if (urlMatch) repoUrl = urlMatch[0];
                  } catch (err) {
                    try {
                      // Try cb CLI
                      const output = execFileSync('cb', ['repo', 'create', '--name', repoName, ...(visibility === 'private' ? ['--private'] : [])], { cwd: resolvedCwd }).toString();
                      created = true;
                      const urlMatch = output.match(/https?:\/\/\S+/i) || output.match(/git@\S+/i);
                      if (urlMatch) repoUrl = urlMatch[0];
                    } catch (err2) {
                      console.error('Failed to create repository with tea or cb CLI:', err, err2);
                    }
                  }

                  if (created) {
                    if (!repoUrl) {
                      // fallback to constructing the URL
                      const domain = provider === 'codeberg' ? 'codeberg.org' : 'gitea.com';
                      let user = '';
                      try {
                        user = execFileSync('tea', ['whoami']).toString().trim().split(/\s+/).pop() || '';
                      } catch (e) {
                        try {
                          const cbWho = execFileSync('cb', ['auth', 'whoami']).toString().trim();
                          user = cbWho.split(/\s+/).pop() || '';
                        } catch (e2) {}
                      }
                      if (!user) {
                        user = 'username_placeholder';
                      }
                      repoUrl = `git@${domain}:${user}/${repoName}.git`;
                    }
                    execFileSync('git', ['remote', 'add', 'origin', repoUrl], { cwd: resolvedCwd, stdio: 'ignore' });
                    console.log(`Successfully created Codeberg/Gitea repo and added remote origin: ${repoUrl}`);
                    setupUpstreamTracking(resolvedCwd);
                  }
                } catch (err) {
                  console.error('Failed to configure remote repository:', err);
                }
              }
            }
          }
        }

        const sessionManager = SessionManager.create(resolvedCwd);
        let model: Model<Api> | undefined;

        if (modelStr) {
          const parsed = this.parseModelStr(modelStr);
          if (parsed) {
            model = this.modelRegistry.find(parsed.provider, parsed.id);
          }
        }

        const settingsManager = SettingsManager.create(resolvedCwd, this.agentDir);
        // Per-turn conversation-mode signal (see the other DefaultResourceLoader
        // call for the rationale).
        const conversationSignal = createConversationModeSignal();
        const resourceLoader = new DefaultResourceLoader({
          cwd: resolvedCwd,
          agentDir: this.agentDir,
          settingsManager,
          extensionFactories: [conversationSignal.inlineExtension],
        });
        await resourceLoader.reload();

        const { session: agentSession } = await createAgentSession({
          cwd: resolvedCwd,
          authStorage: this.authStorage,
          modelRegistry: this.modelRegistry,
          model,
          sessionManager,
          settingsManager,
          resourceLoader,
          // Register attach_file + say for server-created sessions (see the other
          // createAgentSession call for the rationale).
          customTools: [createAttachFileTool(resolvedCwd), createSayTool()],
        });

        const sessionFile = normalizeSessionFile(agentSession.sessionFile || '');
        const modelLabel = agentSession.model ? `${agentSession.model.provider}:${agentSession.model.id}` : '';

        const tracked: TrackedSession = {
          type: 'server',
          sessionId: agentSession.sessionId,
          sessionFile,
          cwd: resolvedCwd,
          model: modelLabel,
          agentSession,
          clients: new Set(),
          isIdle: true,
          idleTimer: null,
          eventUnsubscribe: this.setupEventListeners(sessionFile, agentSession),
          createdAt: Date.now(),
          lastActivity: Date.now(),
          inFlightToolCount: 0,
          conversationSignal,
        };

        this.sessions.set(sessionFile, tracked);
        return { tracked, sessionFile };
      } catch (err) {
        return { tracked: null as any, error: (err as Error).message };
      } finally {
        this.pendingCreateSessions.delete(resolvedCwd);
      }
    })();

    this.pendingCreateSessions.set(resolvedCwd, createPromise);
    return createPromise;
  }

  /**
   * Fork a session at a specific user message, mirroring pi's `/fork` with the
   * default `position: 'before'`. Opens the SOURCE session file, validates that
   * `entryId` points at a `user` message, and creates a NEW branched session
   * file containing only root -> the entry BEFORE that user message (the user
   * entry's parent). The new file's header records `parentSession` = source
   * path (so the fork hierarchy is captured), and the chosen user message's
   * text is returned as `prefillText` for the client to drop into the composer
   * to edit and resend.
   *
   * Does NOT build a live agent or attach any client: the caller loads the
   * returned `sessionFile` through the normal `session_load` path, reusing all
   * the existing fast-first-load / attach machinery.
   */
  async forkSession(
    sessionFileOrId: string,
    entryId: string,
  ): Promise<{ sessionFile: string; cwd: string; prefillText: string } | { error: string }> {
    const resolved = await this.resolveSessionFile(sessionFileOrId);
    if (resolved.error || !resolved.resolvedFile) {
      return { error: resolved.error ?? 'Could not resolve session' };
    }
    const sourceFile = resolved.resolvedFile;

    try {
      const sessionManager = SessionManager.open(sourceFile);
      const selectedEntry = sessionManager.getEntry(entryId);
      if (!selectedEntry) {
        return { error: 'Invalid entry id for forking' };
      }
      if (selectedEntry.type !== 'message' || (selectedEntry as SessionMessageEntry).message.role !== 'user') {
        return { error: 'Fork target must be a user message' };
      }

      const userMsg = (selectedEntry as SessionMessageEntry).message;
      const prefillText = extractMessageText(userMsg) || '';

      // pi's position:'before' -> the new branch ends just BEFORE the chosen
      // user message, i.e. at that entry's parent. A null parent means the user
      // message is the very first entry; forking before it yields an empty
      // session that still records the parent lineage.
      const targetLeafId = selectedEntry.parentId;

      let forkedFile: string | undefined;
      if (!targetLeafId) {
        // Nothing precedes the chosen message: create a fresh session in the
        // same cwd that records the parent lineage, matching pi's newSession
        // ({ parentSession }) branch of fork().
        const forkManager = SessionManager.create(
          sessionManager.getCwd(),
          sessionManager.getSessionDir(),
        );
        forkManager.newSession({ parentSession: sourceFile });
        forkedFile = forkManager.getSessionFile();
      } else {
        forkedFile = sessionManager.createBranchedSession(targetLeafId);
      }

      if (!forkedFile) {
        return { error: 'Failed to create forked session' };
      }
      return {
        sessionFile: normalizeSessionFile(forkedFile),
        cwd: normalizePath(sessionManager.getCwd()),
        prefillText,
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  addClient(sessionFileOrId: string, clientId: string): TrackedSession | null {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return null;
    tracked.clients.add(clientId);
    tracked.lastActivity = Date.now();
    this.cancelIdleCheck(tracked.sessionFile);
    return tracked;
  }

  removeClient(sessionFileOrId: string, clientId: string): void {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return;
    tracked.clients.delete(clientId);
    this.scheduleIdleCheck(tracked.sessionFile);
  }

  getSession(sessionFileOrId: string): TrackedSession | null {
    if (this.sessions.has(sessionFileOrId)) {
      return this.sessions.get(sessionFileOrId)!;
    }
    // The caller may pass a session FILE PATH that differs only cosmetically
    // from the stored key (trailing slash, ./.. segments, or a version-skewed
    // encoding). Canonicalize and retry before falling back to an id scan, so a
    // CLI-reported path still resolves to the server-tracked session.
    const canonical = normalizeSessionFile(sessionFileOrId);
    if (canonical !== sessionFileOrId && this.sessions.has(canonical)) {
      return this.sessions.get(canonical)!;
    }
    for (const s of this.sessions.values()) {
      if (s.sessionId === sessionFileOrId) return s;
    }
    return null;
  }

  /** All currently tracked (resident) sessions. Used for cross-session scans
   *  such as per-folder conflict detection. */
  getAllSessions(): TrackedSession[] {
    return Array.from(this.sessions.values());
  }

  findActiveSessionByCwd(cwd: string): TrackedSession | null {
    const normalizedCwd = normalizePath(cwd);
    for (const s of this.sessions.values()) {
      if (s.cwd === normalizedCwd) return s;
    }
    return null;
  }

  detectConflict(sessionFileOrId: string, targetCwd: string): { conflict: boolean; otherSessionId?: string; otherCwd?: string } {
    if (this.getSession(sessionFileOrId)) {
      return { conflict: false };
    }

    const normalizedTargetCwd = normalizePath(targetCwd);
    for (const s of this.sessions.values()) {
      if (s.cwd === normalizedTargetCwd && s.clients.size > 0) {
        return { conflict: true, otherSessionId: s.sessionId, otherCwd: s.cwd };
      }
    }
    return { conflict: false };
  }

  /**
   * Tail-first windowed history. Returns the last `limit` messages (the most
   * recent), along with the total count and the offset of the first returned
   * message, so the client can lazily request older history.
   *
   * `beforeOffset`, when provided, returns the window of `limit` messages
   * ending just before that offset (used for "load older" requests).
   *
   * Always read STREAMING from the transcript on disk (see
   * session-transcript.ts): the file is the source of truth for both resident
   * and cold sessions, and only the requested window is ever materialized. The
   * previous implementation mapped EVERY entry of the file into a
   * `HistoryMessage[]` (base64 tool images included) and threw all but 60 of
   * them away, on every session open and every "load older" page.
   */
  async getSessionHistoryWindow(
    sessionFileOrId: string,
    limit: number,
    beforeOffset?: number,
  ): Promise<{ messages: HistoryMessage[]; totalCount: number; offset: number }> {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return { messages: [], totalCount: 0, offset: 0 };
    const read = await readTranscriptWindow(tracked.sessionFile, limit, beforeOffset);
    return { messages: read.messages, totalCount: read.totalCount, offset: read.offset };
  }

  /**
   * List session folders.
   * - view='default' (the dashboard's main list): excludes `sessions.ignore`
   *   AND `sessions.readOnly` folders.
   * - view='readonly' (the separate read-only page): returns ONLY the
   *   `sessions.readOnly` folders (still excluding `sessions.ignore`), each
   *   tagged `readOnly: true`.
   * In both cases, excluded folders are pruned BEFORE their file bodies are
   *   read (cheap one-header probe per folder), so they cost nothing to scan.
   *
   * Backed by `scanDiskSessions`, which caches each file's parsed info against
   * its (mtime, size) stamp and yields to the event loop between parses. The
   * dashboard refetches this list on every `sessions_updated`, so an uncached
   * re-read of the whole sessions dir here stalls the WebSocket (and with it
   * any in-flight session load) for as long as the scan takes.
   *
   * Each folder is then stamped with whether it EXISTS on this machine
   * (`missing`), from the per-folder existence cache -- one check per distinct
   * folder, never one per session, for the same reason the scan is cached.
   */
  async listSessions(view: 'default' | 'readonly' = 'default'): Promise<FolderWithSessions[]> {
    const cfg = getWhereverConfig().sessions;
    const isIgnored = makeIgnoreMatcher(cfg?.ignore);
    const isReadOnly = makeIgnoreMatcher(cfg?.readOnly);

    // A folder is KEPT only if its cwd belongs in the requested view:
    // - default: not ignored AND not read-only.
    // - readonly: not ignored AND read-only.
    const folderWanted = (cwd: string): boolean => {
      if (isIgnored(cwd)) return false;
      return view === 'readonly' ? isReadOnly(cwd) : !isReadOnly(cwd);
    };

    const infos = await scanDiskSessions(
      path.join(this.agentDir, 'sessions'),
      folderWanted,
      `/sessions (${view})`,
      { maxAgeDays: cfg?.maxAgeDays, maxSessions: cfg?.maxSessions },
    );
    const folders = this.buildFolders(infos, view === 'readonly' ? isReadOnly : undefined);
    await annotateFolderExistence(folders);
    return folders;
  }

  /**
   * Find a session on disk by short ID or name, using the same cached scan as
   * listSessions(). Replaces `SessionManager.listAll()` on this lookup path:
   * that helper re-reads and re-parses every session file, which is seconds of
   * blocking work just to resolve one deep-linked session ID.
   */
  private async findDiskSessionByIdOrName(idOrName: string): Promise<DiskSessionInfo | undefined> {
    // Deliberately NOT retention-limited: retention governs what the dashboard
    // LISTS, not what can be opened, so a deep link to an old session must still
    // resolve.
    const infos = await scanDiskSessions(
      path.join(this.agentDir, 'sessions'),
      () => true,
      'session lookup',
    );
    return infos.find((s) => s.id === idOrName || s.name === idOrName);
  }

  /** True when the given (raw or resolved) cwd matches a sessions.readOnly glob. */
  isReadOnlyCwd(cwd: string): boolean {
    const patterns = getWhereverConfig().sessions?.readOnly;
    if (!patterns || patterns.length === 0) return false;
    return makeIgnoreMatcher(patterns)(resolveSessionCwd(cwd));
  }

  /**
   * Group flat disk-session infos into per-cwd folders, dropping stub sessions
   * with no valid creation time, and sorted newest-first. Shared by both the
   * fast (listAll) and directory-aware listing paths. When `isReadOnly` is
   * provided, each folder is tagged `readOnly` per its cwd.
   */
  private buildFolders(
    diskSessions: DiskSessionInfo[],
    isReadOnly?: (cwd: string) => boolean,
  ): FolderWithSessions[] {
    const folderMap = new Map<string, FolderSessionInfo[]>();

    for (const s of diskSessions) {
      // Skip incomplete/stub session files: a valid-looking `session` header
      // can still be missing its `timestamp` (e.g. test stubs written as
      // {"type":"session","id":"abc","cwd":"."}). Upstream tolerates a
      // missing timestamp for `modified` (falls back to file mtime) but not
      // for `created`, leaving it as an Invalid Date. Such a session has no
      // meaningful creation time, so we drop it from the list rather than
      // surfacing a bogus 1970 entry.
      if (!isValidDate(s.created)) {
        continue;
      }

      const cwd = resolveSessionCwd(s.cwd);

      if (!folderMap.has(cwd)) {
        folderMap.set(cwd, []);
      }
      const active = this.getSession(s.path);
      folderMap.get(cwd)!.push({
        // Normalize so a child's parentSessionPath (also normalized) matches this
        // path exactly when the client builds the fork-hierarchy tree.
        path: normalizeSessionFile(s.path),
        id: s.id,
        name: s.name,
        created: safeToISOString(s.created),
        modified: safeToISOString(s.modified),
        messageCount: s.messageCount,
        // Capped, whitespace-collapsed PREVIEW (not the full first message): the
        // dominant lever on /sessions payload size.
        firstMessage: previewText(s.firstMessage),
        isActive: !!active,
        clientCount: active ? active.clients.size : 0,
        ...(s.parentSessionPath ? { parentSessionPath: normalizeSessionFile(s.parentSessionPath) } : {}),
      });
    }

    const folders: FolderWithSessions[] = [];
    for (const [cwdPath, sessions] of folderMap.entries()) {
      const name = path.basename(cwdPath) || cwdPath;
      folders.push({
        path: cwdPath,
        name,
        sessions: sessions.sort((a, b) => b.modified.localeCompare(a.modified)),
        readOnly: isReadOnly ? isReadOnly(cwdPath) : undefined,
      });
    }

    return folders.sort((a, b) => {
      const aTime = a.sessions[0]?.modified || '';
      const bTime = b.sessions[0]?.modified || '';
      return bTime.localeCompare(aTime);
    });
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      sessionId: s.sessionId,
      sessionFile: s.sessionFile,
      cwd: s.cwd,
      model: s.model,
      clientCount: s.clients.size,
      isIdle: s.isIdle,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
    }));
  }

  async takeOver(cwd: string, targetSessionId: string): Promise<Set<string>> {
    const existing = this.findActiveSessionByCwd(cwd);
    const interruptedClientIds = new Set<string>();
    if (existing && existing.sessionId !== targetSessionId) {
      try {
        if (existing.type === 'server') {
          await existing.agentSession.abort();
        } else if (existing.type === 'cli') {
          existing.cliWs.send(JSON.stringify({ type: 'cli_abort' }));
        }
      } catch (err) {
        console.error(`Failed to abort session ${existing.sessionId} during takeover:`, err);
      }
      const interruptedClients = Array.from(existing.clients);
      for (const clientId of interruptedClients) {
        existing.clients.delete(clientId);
        interruptedClientIds.add(clientId);
      }
      this.scheduleIdleCheck(existing.sessionFile);
    }
    return interruptedClientIds;
  }

  /**
   * Deliver a user message to a session's agent.
   *
   * `conversationMode` is the per-turn spoken-conversation SIGNAL the web client
   * stamped on the message (absent/false = off). It never touches the message
   * text: for a server session it arms the session's ConversationModeSignal (whose
   * before_agent_start hook appends the hint to THIS turn's system prompt), and for
   * a CLI-bridge session it is relayed on `cli_message` so the extension's own
   * before_agent_start hook does the same in the bridged terminal pi.
   */
  async sendUserMessage(sessionFileOrId: string, text: string, streamingBehavior?: 'steer' | 'followUp', conversationMode = false): Promise<void> {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return;
    tracked.lastActivity = Date.now();
    this.cancelIdleCheck(tracked.sessionFile);

    const isBash = text.trimStart().startsWith('!');
    if (isBash) {
      const isExcluded = text.trimStart().startsWith('!!');
      const command = isExcluded ? text.trimStart().slice(2).trim() : text.trimStart().slice(1).trim();

      if (command) {
        // A `!sudo ...` command cannot run unattended: sudo needs a password on a
        // tty/stdin that neither the server executor nor the extension's plain
        // spawn provides, so it would otherwise hang or fail. For BOTH session
        // types, defer it: ask the web client for the password (masked, one-shot)
        // via bash_sudo_prompt, then finish in submitSudoPassword once the reply
        // arrives (server runs it locally; CLI forwards it to the extension).
        // Everything else about the `!command` UX is unchanged.
        if (this.isSudoCommand(command)) {
          const promptId = randomUUID();
          const now = Date.now();
          for (const [id, p] of this.pendingSudo) {
            if (now - p.armedAt > SessionPool.SUDO_PROMPT_TTL_MS) this.pendingSudo.delete(id);
          }
          this.pendingSudo.set(promptId, {
            sessionFileOrId: tracked.sessionFile,
            command,
            excludeFromContext: isExcluded,
            armedAt: now,
          });
          if (this.onEvent) {
            this.onEvent(tracked.sessionFile, {
              type: 'bash_sudo_prompt',
              promptId,
              command,
            } as any);
          }
          return;
        }

        if (tracked.type === 'server') {
          await this.runServerBash(tracked, command, isExcluded);
        } else if (tracked.type === 'cli') {
          tracked.cliWs.send(JSON.stringify({
            type: 'cli_bash',
            command,
            excludeFromContext: isExcluded,
          }));
        }
      }
      return;
    }

    if (tracked.type === 'server') {
      // Arm (or disarm) the conversation-mode hint for the turn this message
      // starts. Set for EVERY message so the latest one always wins, and consumed
      // by the before_agent_start handler so it applies to one turn only.
      tracked.conversationSignal.arm(conversationMode);
      // Slash-prefixed input (/skill:<name> ..., /template ..., extension
      // commands) must be expanded before it reaches the model. sendUserMessage()
      // internally calls prompt() with expandPromptTemplates:false, so it would
      // forward "/skill:foo" to the LLM verbatim instead of inlining the skill
      // body. Route "/"-prefixed messages through prompt() with expansion enabled
      // so browser/server sessions behave exactly like the pi CLI: all three
      // expansions are start-of-message anchored, and any trailing text after
      // "/skill:<name> " is preserved and appended after the skill block. Plain
      // text keeps the sendUserMessage() path (extension "input"-event source).
      if (text.startsWith('/')) {
        await tracked.agentSession.prompt(text, {
          expandPromptTemplates: true,
          streamingBehavior,
          source: 'interactive',
        });
      } else {
        await tracked.agentSession.sendUserMessage(text, { deliverAs: streamingBehavior });
      }
    } else if (tracked.type === 'cli') {
      // Relay the signal to the bridged pi (omitted when off, so the payload is
      // unchanged for a non-conversation message and older extensions are fine).
      tracked.cliWs.send(JSON.stringify({
        type: 'cli_message',
        message: text,
        streamingBehavior,
        ...(conversationMode ? { conversationMode: true } : {}),
      }));
    }
  }

  // True when a `!command` invokes sudo as its leading program. We only special-
  // case the leading token so ordinary commands that merely mention "sudo"
  // somewhere (e.g. `grep sudo /var/log/auth.log`) are unaffected.
  private isSudoCommand(command: string): boolean {
    return /^sudo(\s|$)/.test(command.trimStart());
  }

  // Run a server-side bash command, streaming output and recording history
  // exactly like a plain `!command`. `operations` lets the sudo path inject a
  // custom executor that feeds the password over stdin; when omitted the agent
  // uses its default local shell backend.
  private async runServerBash(
    tracked: ServerTrackedSession,
    command: string,
    excludeFromContext: boolean,
    operations?: BashOperations,
  ): Promise<void> {
    if (this.onEvent) {
      this.onEvent(tracked.sessionFile, {
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command },
        forceCommand: true,
      } as any);
    }

    try {
      const result = await tracked.agentSession.executeBash(command, (chunk) => {
        if (this.onEvent) {
          this.onEvent(tracked.sessionFile, {
            type: 'tool_execution_update',
            toolName: 'bash',
            delta: chunk,
          } as any);
        }
      }, { excludeFromContext, operations });

      if (this.onEvent) {
        this.onEvent(tracked.sessionFile, {
          type: 'tool_execution_end',
          toolName: 'bash',
          result: result.output,
          isError: result.exitCode !== 0,
          forceCommand: true,
        } as any);
      }
    } catch (err) {
      if (this.onEvent) {
        this.onEvent(tracked.sessionFile, {
          type: 'tool_execution_end',
          toolName: 'bash',
          result: (err as Error).message,
          isError: true,
          forceCommand: true,
        } as any);
      }
    }
  }

  // Build BashOperations that run a leading-`sudo` command non-interactively by
  // passing the supplied password on the child's stdin. Uses `sudo -S` (read the
  // password from stdin), `-k` (ignore any cached credential so it always asks),
  // and `-p ''` (suppress the prompt text so it does not leak into output). The
  // password is written once and stdin is closed; it is never logged, streamed,
  // or persisted. The recorded/displayed command remains the password-free
  // string passed to executeBash.
  private buildSudoOperations(password: string): BashOperations {
    return {
      exec: async (command, cwd, { onData, signal, env }) => {
        if (signal?.aborted) throw new Error('aborted');

        // executeBash hands us the display command (possibly with a settings
        // command-prefix prepended). Rewrite the leading `sudo` so it reads the
        // password from stdin. We run the whole thing through a shell so any
        // arguments/pipes after sudo behave as the user typed them.
        const rewritten = command.replace(/(^|\n)(\s*)sudo(\s|$)/, `$1$2sudo -S -k -p '' $3`);

        const child = spawn('bash', ['-c', rewritten], {
          cwd,
          env: env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        // Feed the password first, then close stdin so sudo (and the command)
        // see EOF and do not hang waiting for more input.
        child.stdin?.on('error', () => {});
        child.stdin?.write(password + '\n');
        child.stdin?.end();

        const onAbort = () => {
          try { child.kill('SIGKILL'); } catch {}
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }

        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        try {
          const exitCode: number | null = await new Promise((resolve) => {
            child.on('error', () => resolve(null));
            child.on('close', (code) => resolve(code));
          });
          if (signal?.aborted) throw new Error('aborted');
          return { exitCode };
        } finally {
          if (signal) signal.removeEventListener('abort', onAbort);
        }
      },
    };
  }

  // Resolve a pending sudo prompt with the password the client supplied and run
  // the deferred command. Returns false if the promptId is unknown (already
  // consumed, cancelled, or the session went away) so the caller can ignore it.
  async submitSudoPassword(promptId: string, password: string): Promise<boolean> {
    const pending = this.pendingSudo.get(promptId);
    if (!pending) return false;
    this.pendingSudo.delete(promptId);

    const tracked = this.getSession(pending.sessionFileOrId);
    if (!tracked) return false;

    tracked.lastActivity = Date.now();
    this.cancelIdleCheck(tracked.sessionFile);

    if (tracked.type === 'server') {
      await this.runServerBash(
        tracked,
        pending.command,
        pending.excludeFromContext,
        this.buildSudoOperations(password),
      );
    } else if (tracked.type === 'cli') {
      // The command runs in the extension process, so hand it the password to
      // feed sudo's stdin. The password crosses the socket once and is not
      // stored server-side beyond this send.
      tracked.cliWs.send(JSON.stringify({
        type: 'cli_bash_sudo',
        command: pending.command,
        password,
        excludeFromContext: pending.excludeFromContext,
      }));
    }
    return true;
  }

  // Drop a pending sudo prompt without running anything (user dismissed it).
  cancelSudoPrompt(promptId: string): void {
    this.pendingSudo.delete(promptId);
  }

  async abortSession(sessionFileOrId: string): Promise<void> {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return;
    if (tracked.type === 'server') {
      await tracked.agentSession.abort();
    } else if (tracked.type === 'cli') {
      tracked.cliWs.send(JSON.stringify({ type: 'cli_abort' }));
    }
  }

  // Cancel the queued mid-stream steer (and follow-up) messages WITHOUT aborting
  // the in-flight turn. pi's AgentSession.clearQueue() drops the WHOLE pending
  // queue at once (it has no per-message dequeue) and emits a fresh queue_update
  // (so the web's pending-steer set clears itself). Only server-type sessions
  // have this API; CLI-bridge sessions only expose abort, so this is a no-op for
  // them and they never surface a cancel affordance.
  /**
   * Snapshot of pi's CURRENT pending steer queue, for a client that is
   * attaching (a fresh load, a reload, or a reconnect resync). `queue_update`
   * is otherwise a live-only event, emitted at the moment the queue changes, so
   * a client that was not connected then would show nothing queued while pi
   * still holds the message and injects it at the next step. The queued text is
   * NOT in the session file yet (pi appends it on injection), so this snapshot
   * is the only way an attaching client can learn about it.
   *
   * Returns null when the session has no readable queue -- not resident, or a
   * CLI-bridge session (those never report a queue at all, so a null keeps the
   * client's state untouched rather than asserting an empty queue).
   */
  getSteeringQueue(sessionFileOrId: string): string[] | null {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked || tracked.type !== 'server') return null;
    return [...tracked.agentSession.getSteeringMessages()];
  }

  async cancelSteerQueue(sessionFileOrId: string): Promise<void> {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return;
    if (tracked.type === 'server') {
      tracked.agentSession.clearQueue();
    }
  }

  async changeModel(sessionFileOrId: string, modelStr: string): Promise<{ error?: string }> {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return { error: 'Session not found' };

    if (tracked.type === 'server') {
      const parsed = this.parseModelStr(modelStr);
      if (!parsed) return { error: `Invalid model format: ${modelStr}` };
      const model = this.modelRegistry.find(parsed.provider, parsed.id);
      if (!model) return { error: `Model not found: ${modelStr}` };

      try {
        await tracked.agentSession.setModel(model);
        tracked.model = modelStr;
        return {};
      } catch (err) {
        return { error: (err as Error).message };
      }
    } else {
      tracked.cliWs.send(JSON.stringify({ type: 'cli_model_change', model: modelStr }));
      tracked.model = modelStr;
      return {};
    }
  }

  isStreaming(sessionFileOrId: string): boolean {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return false;
    return tracked.type === 'server' ? tracked.agentSession.isStreaming : tracked.isStreaming;
  }

  /**
   * Skill commands available for a session's composer autocomplete. Mirrors the
   * pi CLI: each discovered skill becomes a `skill:<name>` command whose
   * expansion is handled at send time by prompt() (see sendUserMessage). Only
   * server-type sessions run an in-process agent with a resource loader; CLI
   * bridges resolve their own skills, so we return [] for them (the bridged CLI
   * still expands on its side). Returns [] on any error so autocomplete simply
   * offers nothing rather than breaking the session.
   */
  getSkills(sessionFileOrId: string): SkillCommand[] {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked || tracked.type !== 'server') return [];
    try {
      return tracked.agentSession.resourceLoader
        .getSkills()
        .skills.map((s) => ({ name: `skill:${s.name}`, description: s.description }));
    } catch {
      return [];
    }
  }

  /**
   * Context-window usage for a session, for the "11.3% / 1.0M" UI indicator.
   * Server sessions compute it from the live agent; CLI-bridge sessions return
   * the latest snapshot the bridge reported (the server does not run their
   * agent). Returns undefined when unknown (no model / no usage yet).
   */
  getContextUsage(sessionFileOrId: string): ContextUsageInfo | null | undefined {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return undefined;
    if (tracked.type === 'server') {
      const usage = tracked.agentSession.getContextUsage();
      if (!usage) return undefined;
      return { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
    }
    return tracked.contextUsage;
  }

  /** Record a context-usage snapshot reported by a CLI bridge for its session. */
  setCliContextUsage(sessionFileOrId: string, usage: ContextUsageInfo | null): void {
    const tracked = this.getSession(sessionFileOrId);
    if (tracked && tracked.type === 'cli') {
      tracked.contextUsage = usage;
    }
  }

  scheduleIdleCheck(sessionFileOrId: string): void {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return;
    this.cancelIdleCheck(tracked.sessionFile);

    if (tracked.clients.size === 0 && tracked.isIdle) {
      tracked.idleTimer = setTimeout(() => {
        this.destroySession(tracked.sessionFile, 'idle timeout');
      }, this.idleTimeoutMs);
    }
  }

  cancelIdleCheck(sessionFileOrId: string): void {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked || !tracked.idleTimer) return;
    clearTimeout(tracked.idleTimer);
    tracked.idleTimer = null;
  }

  destroySession(sessionFileOrId: string, reason: string): void {
    const tracked = this.getSession(sessionFileOrId);
    if (!tracked) return;
    this.cancelIdleCheck(tracked.sessionFile);
    if (tracked.type === 'server') {
      tracked.eventUnsubscribe();
      tracked.agentSession.dispose();
    } else {
      try {
        tracked.cliWs.close();
      } catch (err) {}
    }
    this.sessions.delete(tracked.sessionFile);
    // A prompt whose session is gone can never be answered: drop it here so an
    // abandoned prompt is bounded by the session's own lifetime (idle eviction)
    // rather than waiting for someone to type the next `!sudo`.
    for (const [id, p] of this.pendingSudo) {
      if (p.sessionFileOrId === tracked.sessionFile) this.pendingSudo.delete(id);
    }
  }

  async registerCliSession(rawSessionFile: string, cwd: string, modelStr: string, cliWs: WebSocket, isStreaming = false): Promise<{ tracked: TrackedSession; error?: string; interruptedTurn?: boolean; interruptedToolCall?: boolean }> {
    // Canonicalize the CLI-reported path so it keys the same entry the server
    // would compute itself (see normalizeSessionFile). Without this, a CLI on a
    // different pi version can register a second, parallel session for the same
    // work under a cosmetically different path string.
    const sessionFile = normalizeSessionFile(rawSessionFile);
    const existing = this.sessions.get(sessionFile);
    let clients = new Set<string>();
    // A CLI registering for a session that already had a LIVE server-side agent
    // seizes control: we dispose that agent below. Disposing MID-TURN discards
    // the whole in-flight turn WITHOUT persisting it (persistence only happens
    // on message_end, which never fires here), so the web viewer who was
    // watching the turn loses it silently. Two flavours, both worth warning:
    //   - a TOOL CALL was executing (inFlightToolCount > 0): its result is never
    //     produced;
    //   - only assistant TEXT was streaming: the partial reply is discarded.
    // We report `interruptedTurn` (either flavour) and `interruptedToolCall`
    // (the tool-call flavour specifically) so the caller can warn accurately.
    let interruptedTurn = false;
    let interruptedToolCall = false;
    if (existing) {
      clients = existing.clients;
      this.cancelIdleCheck(sessionFile);
      if (existing.type === 'server') {
        interruptedToolCall = existing.inFlightToolCount > 0;
        interruptedTurn = interruptedToolCall || existing.agentSession.isStreaming;
        try {
          existing.eventUnsubscribe();
          existing.agentSession.dispose();
        } catch (err) {}
      }
    }

    let sessionId = existing?.sessionId;
    if (!sessionId) {
      // The session id IS the header's `id`, so read ONLY the header (one 8 KB
      // read). `SessionManager.open()` loads and parses the ENTIRE transcript
      // twice for this single field, on every CLI bridge register -- on a large
      // session that is hundreds of MB of transient allocation for 36 bytes.
      // It stays as the fallback for the cases the header read cannot answer
      // (file not written yet, no header), so behaviour is unchanged there.
      const header = await readSessionHeader(sessionFile);
      sessionId = header?.id || undefined;
      if (!sessionId) {
        try {
          sessionId = SessionManager.open(sessionFile).getSessionId();
        } catch (err) {
          // Fallback: extract from filename (e.g. some_path/TIMESTAMP_UUID.jsonl)
          const baseName = path.basename(sessionFile);
          const match = baseName.match(/_(.+)\.jsonl$/);
          if (match) {
            sessionId = match[1];
          } else {
            return { tracked: null as any, error: `Could not determine a persistent session ID from file path: ${sessionFile}` };
          }
        }
      }
    }

    const normalizedCwd = normalizePath(cwd);

    const tracked: CliTrackedSession = {
      type: 'cli',
      sessionId,
      sessionFile,
      cwd: normalizedCwd,
      model: modelStr || '',
      clients,
      isIdle: true,
      idleTimer: null,
      createdAt: existing?.createdAt || Date.now(),
      lastActivity: Date.now(),
      cliWs,
      // Honor the CLI's CURRENT streaming state at register time. The CLI only
      // forwards agent_start/agent_end going forward, so a turn already in flight
      // when the bridge (re)connects would otherwise be invisible: a viewer
      // joining a mid-tool-call CLI session would see Abort disabled + an enabled
      // composer while the CLI is still working. isStreaming carries that state.
      isStreaming,
    };
    // A session registered mid-turn is not idle; keep it from being idle-reaped.
    if (isStreaming) {
      tracked.isIdle = false;
      this.cancelIdleCheck(sessionFile);
    }

    this.sessions.set(sessionFile, tracked);
    return { tracked, interruptedTurn, interruptedToolCall };
  }

  async unregisterCliSession(rawSessionFile: string): Promise<void> {
    const sessionFile = normalizeSessionFile(rawSessionFile);
    const tracked = this.sessions.get(sessionFile);
    if (!tracked || tracked.type !== 'cli') return;

    this.cancelIdleCheck(sessionFile);
    this.sessions.delete(sessionFile);

    if (tracked.clients.size > 0) {
      console.log(`CLI Bridge disconnected for ${sessionFile}. Restarting server-side agent session...`);
      const result = await this.loadSession(sessionFile, tracked.cwd, tracked.model);
      if (!result.error && result.tracked) {
        result.tracked.clients = tracked.clients;
        if (this.onEvent) {
          if (tracked.isStreaming) {
            this.onEvent(sessionFile, {
              type: 'session_error' as any,
              error: 'CLI terminal disconnected. Active execution was aborted.'
            } as any);
          }
          this.onEvent(sessionFile, { type: 'agent_end' } as any);
        }
      }
    }
  }

  handleCliEvent(rawSessionFile: string, event: AgentSessionEvent): void {
    const sessionFile = normalizeSessionFile(rawSessionFile);
    const tracked = this.sessions.get(sessionFile);
    if (!tracked || tracked.type !== 'cli') return;

    tracked.lastActivity = Date.now();

    if (event.type === 'agent_start') {
      tracked.isIdle = false;
      tracked.isStreaming = true;
      this.cancelIdleCheck(sessionFile);
    } else if (event.type === 'agent_end') {
      tracked.isIdle = true;
      tracked.isStreaming = false;
      this.scheduleIdleCheck(sessionFile);
    } else if (event.type === 'model_select' as any) {
      const modelStr = (event as any).model;
      if (modelStr) {
        tracked.model = modelStr;
      }
    } else if ((event.type as any) === 'context_usage') {
      // The CLI bridge reports its agent's context usage (the server cannot
      // compute it for CLI sessions). Cache it so getContextUsage() can serve it
      // on join, and let it flow through onEvent for live broadcast.
      tracked.contextUsage = (event as any).contextUsage ?? null;
    }

    if (this.onEvent) {
      this.onEvent(sessionFile, event);
    }
  }

  async disposeAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    for (const id of sessionIds) {
      this.destroySession(id, 'server shutdown');
    }
  }

  private setupEventListeners(sessionFile: string, agentSession: AgentSession): () => void {
    return agentSession.subscribe((event) => {
      const tracked = this.sessions.get(sessionFile);
      if (!tracked) return;

      if (this.onEvent) {
        this.onEvent(sessionFile, event);
      }

      switch (event.type) {
        case 'agent_start':
          tracked.isIdle = false;
          tracked.lastActivity = Date.now();
          this.cancelIdleCheck(sessionFile);
          break;

        case 'agent_end':
          tracked.isIdle = true;
          tracked.lastActivity = Date.now();
          // A turn ended: nothing is in flight anymore. Reset defensively in case
          // a start/end pair was ever missed, so the count cannot drift positive.
          if (tracked.type === 'server') tracked.inFlightToolCount = 0;
          this.scheduleIdleCheck(sessionFile);
          break;

        case 'tool_execution_start':
          if (tracked.type === 'server') tracked.inFlightToolCount++;
          tracked.lastActivity = Date.now();
          break;

        case 'tool_execution_end':
          // Clamp at 0: an unmatched end must never make the count negative.
          if (tracked.type === 'server')
            tracked.inFlightToolCount = Math.max(0, tracked.inFlightToolCount - 1);
          tracked.lastActivity = Date.now();
          break;

        case 'message_update':
        case 'message_end':
          tracked.lastActivity = Date.now();
          break;

        case 'model_select' as any: {
          const evt = event as any;
          const modelStr = evt.model ? `${evt.model.provider}:${evt.model.id}` : '';
          if (modelStr) {
            tracked.model = modelStr;
          }
          break;
        }
      }
    });
  }

  private parseModelStr(modelStr: string): { provider: string; id: string } | null {
    const colonIdx = modelStr.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      provider: modelStr.slice(0, colonIdx),
      id: modelStr.slice(colonIdx + 1),
    };
  }
}
