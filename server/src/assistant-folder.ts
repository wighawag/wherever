import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The assistant FOLDER: the home and memory of the long-lived, resettable
 * general-assistant session (spec `assistant-session-and-channels`, ADRs 0014 to
 * 0018). This module is the opt-in foundation only: resolving `assistantFolder`
 * from the config, seeding the folder once, taking the folder lock, and the
 * status payload the web reads from `GET /config`. Later tasks (pointer,
 * scheduler, tools, channels) gate on `AssistantStatus.active`.
 *
 * Opt-in: `assistantFolder` has NO default. Unset (or blank) means the feature is
 * entirely off: nothing is created, locked or written, and the status says
 * "not configured".
 *
 * Restart-only: the folder is resolved, seeded and locked ONCE, at server start
 * (`startAssistantFolder`), and the resulting status is a snapshot. Editing
 * `assistantFolder` in config.json takes effect on the next restart; nothing here
 * re-reads the config at runtime, so a running server never "moves" its
 * assistant (and its lock) under a live session.
 */

/** Minimal config slice this module reads (a subset of `WhereverConfig`). */
export interface AssistantFolderConfig {
  /** Folder the assistant lives in. No default; unset = feature off. Tilde (~) is expanded. */
  assistantFolder?: string;
}

/** Lock file name, inside the assistant folder (ADR 0018: NOT in the state dir). */
export const ASSISTANT_LOCK_FILE = '.assistant.lock';

export const ASSISTANT_AGENTS_MD = `# Assistant

You are a long-lived general assistant. This folder is your home and your memory.

## Memory

This session may be reset at any time, and a fresh session remembers nothing of this one. So save anything worth keeping into files here AS YOU GO, not at the end: \`memory/\` (one file per topic), \`profile.md\` (who the user is, their preferences), and whatever else helps. At the start of a fresh session, read them before answering.

## Time

Use the \`assistant_schedule_*\` tools for anything time-based (reminders, recurring briefings, "check X later"). Leave \`tz\` unset so the job follows the user wherever they are; set \`tz\` only for things pinned to a place ("6pm her time"). When the user tells you where they are, call \`assistant_set_timezone\`.

## Delegate

Do not block the conversation on long or slow work. DELEGATE it to an isolated job (\`at: "now"\`) that notifies the user when it is done. Anything possibly urgent must be an isolated job too, so it never waits behind a conversation.

## Talking to the user

The user hears from you ONLY through your replies and \`assistant_notify\`. A turn that starts with \`[schedule:...]\` is a scheduled job, not the user talking: if the user should hear about its outcome, call \`assistant_notify\`.

If a \`recall_search\` tool is available, use it to find what was said in earlier sessions rather than asking the user to repeat themselves.
`;

export const ASSISTANT_JOBS_AGENTS_MD = `# Assistant job

You are an isolated job run by the assistant. Do the task you were given. Save anything worth keeping under \`../memory/\`. If the user should know the result, call \`assistant_notify\`. Do not start conversations: nobody is reading this session.
`;

export const ASSISTANT_GITIGNORE = `# Runtime lock held by the wherever server using this folder.
${ASSISTANT_LOCK_FILE}
`;

/** The seed files, relative to the assistant folder. Each is written only if missing. */
const SEED_FILES: ReadonlyArray<[string, string]> = [
  ['AGENTS.md', ASSISTANT_AGENTS_MD],
  [path.join('jobs', 'AGENTS.md'), ASSISTANT_JOBS_AGENTS_MD],
  ['.gitignore', ASSISTANT_GITIGNORE],
];

/**
 * The configured assistant folder, tilde-expanded and absolute, or null when the
 * feature is off (unset, empty or whitespace).
 */
export function resolveAssistantFolder(config: AssistantFolderConfig): string | null {
  const raw = typeof config.assistantFolder === 'string' ? config.assistantFolder.trim() : '';
  if (!raw) return null;
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

/**
 * Create the folder if missing and drop each seed file that does not exist yet.
 * NEVER overwrites: the folder is the user's (and the agent's) to edit. Throws on
 * a real I/O failure (e.g. an unwritable parent); callers decide how loud to be.
 * Returns the seed files it actually wrote.
 */
export function seedAssistantFolder(folder: string): string[] {
  fs.mkdirSync(folder, { recursive: true });
  const written: string[] = [];
  for (const [rel, content] of SEED_FILES) {
    const full = path.join(folder, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    try {
      // 'wx' = create-only, so a file appearing between a check and the write is
      // never clobbered.
      fs.writeFileSync(full, content, { encoding: 'utf8', flag: 'wx' });
      written.push(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  return written;
}

/**
 * The `createNewSession` hook, beside `maybeSeedSearchWorkspace`: if `resolvedCwd`
 * IS the assistant folder, re-seed any missing file (self-healing when the user
 * deleted one). `assistantFolder` is the server's START-TIME assistant folder,
 * and only when this server holds the lock (undefined otherwise), so session
 * creation is unchanged with the feature off and a refused server never writes
 * into a folder another server owns. Best-effort: never throws.
 */
export function maybeSeedAssistantSession(resolvedCwd: string, assistantFolder: string | undefined): void {
  if (!assistantFolder) return;
  if (path.resolve(resolvedCwd) !== path.resolve(assistantFolder)) return;
  try {
    const written = seedAssistantFolder(assistantFolder);
    if (written.length > 0) console.log(`[wherever] assistant: seeded ${written.join(', ')} in ${assistantFolder}`);
  } catch (err) {
    console.error(`[wherever] assistant: failed to seed ${assistantFolder}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Folder lock
// ---------------------------------------------------------------------------

/**
 * Who a process is, precisely enough to tell a live lock from a stale one.
 * `bootId` and `startTime` are null where the platform cannot tell us (anything
 * but Linux and darwin); the decision then degrades to pid-only.
 */
export interface ProcessIdentity {
  pid: number;
  host: string;
  /** Linux: /proc/sys/kernel/random/boot_id. darwin: `sysctl kern.boottime`. */
  bootId: string | null;
  /** Linux: /proc/<pid>/stat starttime (ticks since boot). darwin: `ps -o lstart=`. */
  startTime: string | null;
}

/** On-disk shape of `<assistantFolder>/.assistant.lock`. */
export type AssistantLockRecord = ProcessIdentity & { acquiredAt?: string };

/** What the probes found about the pid named in an existing lock. */
export interface PidProbe {
  alive: boolean;
  /** Start time of whatever process holds that pid NOW (null if dead or unknown). */
  startTime: string | null;
}

export type LockDecision =
  | { action: 'take'; reason: 'free' | 'own' }
  | { action: 'takeover'; reason: 'dead-pid' | 'pid-reused' | 'other-boot' | 'corrupt' }
  | { action: 'refuse'; reason: 'live-lock' | 'foreign-host' };

/**
 * The PURE lock decision. `existing` is the parsed lock (null = no lock file,
 * 'corrupt' = present but unparseable). `probe` describes `existing.pid` as seen
 * from THIS host (ignored for a foreign host).
 *
 * - Another HOST: never taken over. We cannot see its processes, and a shared
 *   (synced / network) folder is exactly where two servers collide; the human
 *   removes the file by hand.
 * - Same host, stale when ANY of: the boot id differs (both known), the pid is
 *   dead, or the pid is alive but its start time differs (both known: the pid was
 *   reused by an unrelated process). Otherwise it is live and refused.
 * - A corrupt file is taken over: a crash mid-write is the likeliest cause, and
 *   refusing would wedge the assistant behind a file nobody can attribute.
 */
export function decideAssistantLock(
  existing: AssistantLockRecord | null | 'corrupt',
  self: ProcessIdentity,
  probe: PidProbe,
): LockDecision {
  if (existing === null) return { action: 'take', reason: 'free' };
  if (existing === 'corrupt') return { action: 'takeover', reason: 'corrupt' };
  if (existing.host !== self.host) return { action: 'refuse', reason: 'foreign-host' };
  if (existing.bootId && self.bootId && existing.bootId !== self.bootId) {
    return { action: 'takeover', reason: 'other-boot' };
  }
  if (!probe.alive) return { action: 'takeover', reason: 'dead-pid' };
  if (existing.startTime && probe.startTime && existing.startTime !== probe.startTime) {
    return { action: 'takeover', reason: 'pid-reused' };
  }
  if (existing.pid === self.pid) return { action: 'take', reason: 'own' };
  return { action: 'refuse', reason: 'live-lock' };
}

// --- thin platform probes --------------------------------------------------

/** The current boot's id, or null where unsupported. Never throws. */
export function readBootId(): string | null {
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    }
    if (process.platform === 'darwin') {
      // "{ sec = 1714000000, usec = 123456 } Wed Apr 24 ..." -> "1714000000.123456"
      const out = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000 });
      const m = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/.exec(out);
      return m ? `${m[1]}.${m[2]}` : out.trim() || null;
    }
  } catch {}
  return null;
}

/** Start time of `pid`, or null if it is not running or the platform cannot say. Never throws. */
export function readProcessStartTime(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The comm field (2) is parenthesised and may contain spaces or ')'; split
      // after the LAST ')'. What follows starts at field 3, so starttime (22) is
      // index 19.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] || null;
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
      return out.trim() || null;
    }
  } catch {}
  return null;
}

/** Whether `pid` exists (EPERM means it does, owned by someone else). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function currentProcessIdentity(): ProcessIdentity {
  return { pid: process.pid, host: os.hostname(), bootId: readBootId(), startTime: readProcessStartTime(process.pid) };
}

function readLockFile(lockPath: string): AssistantLockRecord | null | 'corrupt' {
  let text: string;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const rec = JSON.parse(text);
    if (!rec || typeof rec.pid !== 'number' || typeof rec.host !== 'string') return 'corrupt';
    return {
      pid: rec.pid,
      host: rec.host,
      bootId: typeof rec.bootId === 'string' ? rec.bootId : null,
      startTime: typeof rec.startTime === 'string' ? rec.startTime : null,
    };
  } catch {
    return 'corrupt';
  }
}

export type AssistantLockState =
  | { state: 'held' }
  | {
      state: 'refused';
      reason: 'live-lock' | 'foreign-host';
      holder: { pid: number; host: string };
      message: string;
    }
  | { state: 'error'; message: string };

/**
 * Take `<folder>/.assistant.lock` for this process, or report why not. The
 * folder must exist. Creation is exclusive (`wx`), so two servers starting at
 * the same instant cannot both win; a stale lock is unlinked and the exclusive
 * create retried (a bounded loop, in case a third process slips in between).
 * Logs a clear line for every refusal and takeover. Never throws.
 */
export function acquireAssistantLock(folder: string): AssistantLockState {
  const lockPath = path.join(folder, ASSISTANT_LOCK_FILE);
  try {
    const self = currentProcessIdentity();
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = readLockFile(lockPath);
      const probe: PidProbe =
        existing && existing !== 'corrupt' && existing.host === self.host
          ? { alive: isPidAlive(existing.pid), startTime: readProcessStartTime(existing.pid) }
          : { alive: false, startTime: null };
      const decision = decideAssistantLock(existing, self, probe);

      if (decision.action === 'refuse') {
        const holder = existing as AssistantLockRecord;
        const message =
          decision.reason === 'foreign-host'
            ? `assistant folder ${folder} is locked by a wherever server on another host ` +
              `(${holder.host}, pid ${holder.pid}). A lock from another host is never taken over: ` +
              `if no server there uses this folder any more, remove ${lockPath} by hand and restart.`
            : `assistant folder ${folder} is in use by another wherever server on this host ` +
              `(pid ${holder.pid}). Two servers must not share one assistant folder: give this one ` +
              `a different assistantFolder, or stop the other server and restart.`;
        console.error(`[wherever] assistant DISABLED: ${message}`);
        return { state: 'refused', reason: decision.reason, holder: { pid: holder.pid, host: holder.host }, message };
      }

      if (decision.action === 'take' && decision.reason === 'own') return { state: 'held' };

      if (decision.action === 'takeover') {
        const who = existing && existing !== 'corrupt' ? ` (pid ${existing.pid})` : '';
        console.warn(`[wherever] assistant: taking over stale lock ${lockPath}${who}: ${decision.reason}`);
        try {
          fs.unlinkSync(lockPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }

      const record: AssistantLockRecord = { ...self, acquiredAt: new Date().toISOString() };
      try {
        fs.writeFileSync(lockPath, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        return { state: 'held' };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Someone created it between our read and our write: decide again.
      }
    }
    throw new Error('lock kept changing while acquiring it');
  } catch (err) {
    const message = `could not lock assistant folder ${folder}: ${(err as Error).message}`;
    console.error(`[wherever] assistant DISABLED: ${message}`);
    return { state: 'error', message };
  }
}

/**
 * Remove the lock iff it is still THIS process's (same pid and start time).
 * Synchronous so it is safe from a `process.on('exit')` handler. Never throws.
 */
export function releaseAssistantLock(folder: string): void {
  const lockPath = path.join(folder, ASSISTANT_LOCK_FILE);
  try {
    const existing = readLockFile(lockPath);
    if (!existing || existing === 'corrupt') return;
    if (existing.pid !== process.pid || existing.host !== os.hostname()) return;
    const mine = readProcessStartTime(process.pid);
    if (existing.startTime && mine && existing.startTime !== mine) return;
    fs.unlinkSync(lockPath);
  } catch {}
}

// ---------------------------------------------------------------------------
// Server start + status
// ---------------------------------------------------------------------------

/**
 * The assistant status exposed to the web in `GET /config` (`assistant`), beside
 * `searchFolder`. Later tasks ADD fields (current session id, Web Push, Telegram,
 * timezone); keep these stable.
 *
 * - `configured`: `assistantFolder` is set.
 * - `folder`: the resolved folder, or null.
 * - `active`: configured AND this server holds the lock. Everything the
 *   assistant does (pointer, scheduler, channels, tools) gates on this.
 * - `lock`: null when not configured.
 */
export interface AssistantStatus {
  configured: boolean;
  folder: string | null;
  active: boolean;
  lock: AssistantLockState | null;
}

export interface AssistantFolderHandle {
  status: AssistantStatus;
  /** Release the folder lock if held. Idempotent, synchronous. */
  release(): void;
}

/**
 * Server-start entry point: resolve, create, lock, seed. Order matters: the
 * folder is created first (the lock lives in it), then locked, and ONLY a server
 * that holds the lock seeds it, so a refused server writes nothing beyond the
 * mkdir of a folder that already had a lock in it.
 */
export function startAssistantFolder(config: AssistantFolderConfig): AssistantFolderHandle {
  const folder = resolveAssistantFolder(config);
  if (!folder) {
    return { status: { configured: false, folder: null, active: false, lock: null }, release() {} };
  }
  let lock: AssistantLockState;
  try {
    fs.mkdirSync(folder, { recursive: true });
    lock = acquireAssistantLock(folder);
  } catch (err) {
    const message = `could not create assistant folder ${folder}: ${(err as Error).message}`;
    console.error(`[wherever] assistant DISABLED: ${message}`);
    lock = { state: 'error', message };
  }
  if (lock.state === 'held') {
    try {
      const written = seedAssistantFolder(folder);
      if (written.length > 0) console.log(`[wherever] assistant: seeded ${written.join(', ')} in ${folder}`);
    } catch (err) {
      // Seeding is a convenience, not a precondition: keep the lock and the feature.
      console.error(`[wherever] assistant: failed to seed ${folder}:`, err);
    }
    console.log(`[wherever] assistant folder: ${folder}`);
  }
  let released = false;
  return {
    status: { configured: true, folder, active: lock.state === 'held', lock },
    release() {
      if (released || lock.state !== 'held') return;
      released = true;
      releaseAssistantLock(folder);
    },
  };
}
