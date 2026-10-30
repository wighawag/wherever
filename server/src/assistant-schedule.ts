import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  atToInstant,
  isValidTimeZone,
  nextCronRun,
  parseAtString,
  parseCron,
  prevCronRun,
  systemTimeZone,
  type CronSpec,
  type ParsedAt,
} from './assistant-cron.js';

/**
 * The assistant's SCHEDULE (spec `assistant-session-and-channels`, ADR 0015):
 * the job format and its validation, the pure next-run planner, the store that
 * reads and writes `<assistantFolder>/schedule.json`, the append-only run log
 * `<stateDir>/assistant-runs.jsonl`, and the user's timezone state
 * `<stateDir>/assistant-timezone.json`. The firing loop is
 * `assistant-scheduler.ts`.
 *
 * Intent vs run state (ADR 0015): `schedule.json` holds only what the user (or
 * an agent) asked for, so it can be read, hand-edited and versioned with the
 * rest of the assistant's memory. The server never writes run bookkeeping into
 * it; last / next run are DERIVED from the run log.
 *
 * File shape (decision): `{ "jobs": [ <job>, ... ] }`. A missing file is an empty
 * schedule. Any other top-level shape makes the whole file unreadable: nothing
 * fires, `list()` reports the file error, and writes REFUSE (rather than replace
 * a file the user is in the middle of editing). Unknown keys, at the top level
 * and inside a job, are kept untouched by writes and ignored by the scheduler,
 * so a later format addition never invalidates an older server's view.
 */

export const SCHEDULE_FILE = 'schedule.json';
export const RUN_LOG_FILE = 'assistant-runs.jsonl';
export const TIMEZONE_FILE = 'assistant-timezone.json';

/** Default restart grace window: a missed run is caught up only if it is this recent. */
export const DEFAULT_GRACE_MS = 60 * 60 * 1000;

export type JobMode = 'inline' | 'isolated';

/** One job, as written in `schedule.json` (intent only). */
export interface ScheduleJob {
  id: string;
  name: string;
  /** 5-field cron (recurring). Exactly one of `cron` / `at`. */
  cron?: string;
  /** ISO 8601 date-time, or `"now"` (one-shot). An `at` without a UTC offset is read in the job's effective timezone. */
  at?: string;
  /** Pinned IANA timezone. Unset = follows the user's CURRENT timezone. */
  tz?: string;
  mode: JobMode;
  prompt: string;
  enabled: boolean;
  /** The session that scheduled it (context, not the execution location). */
  originSessionId?: string;
  originCwd?: string;
}

/** A job that passed validation, with its parsed time spec. */
export interface ValidJob {
  job: ScheduleJob;
  index: number;
  cron?: CronSpec;
  at?: ParsedAt | 'now';
}

/** A malformed entry: listed as invalid, never fired, never stops the valid ones. */
export interface InvalidJob {
  index: number;
  id: string | null;
  name: string | null;
  errors: string[];
  raw: unknown;
}

export interface ValidatedSchedule {
  valid: ValidJob[];
  invalid: InvalidJob[];
  /** Set when the FILE itself is unreadable (bad JSON, wrong shape); then `valid` is empty. */
  fileError: string | null;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Validate one raw entry. Returns the job or the list of problems. */
export function validateJob(raw: unknown): { ok: true; job: ScheduleJob; cron?: CronSpec; at?: ParsedAt | 'now' } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['entry is not an object'] };
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.id)) errors.push('"id" must be a non-empty string');
  if (!isNonEmptyString(r.name)) errors.push('"name" must be a non-empty string');
  if (r.mode !== 'inline' && r.mode !== 'isolated') errors.push('"mode" must be "inline" or "isolated"');
  if (!isNonEmptyString(r.prompt)) errors.push('"prompt" must be a non-empty string');
  if (typeof r.enabled !== 'boolean') errors.push('"enabled" must be true or false');
  if (r.tz !== undefined && !isValidTimeZone(r.tz)) errors.push(`"tz" is not a known IANA timezone: ${JSON.stringify(r.tz)}`);
  for (const k of ['originSessionId', 'originCwd'] as const) {
    if (r[k] !== undefined && typeof r[k] !== 'string') errors.push(`"${k}" must be a string`);
  }
  let cron: CronSpec | undefined;
  let at: ParsedAt | 'now' | undefined;
  const hasCron = r.cron !== undefined;
  const hasAt = r.at !== undefined;
  if (hasCron === hasAt) {
    errors.push('exactly one of "cron" (recurring) or "at" (one-shot) is required');
  } else if (hasCron) {
    if (typeof r.cron !== 'string') errors.push('"cron" must be a string');
    else {
      try {
        cron = parseCron(r.cron);
      } catch (err) {
        errors.push(`"cron" is invalid: ${(err as Error).message}`);
      }
    }
  } else if (typeof r.at !== 'string') {
    errors.push('"at" must be a string');
  } else if (r.at.trim().toLowerCase() === 'now') {
    at = 'now';
  } else {
    const parsed = parseAtString(r.at);
    if (!parsed) errors.push(`"at" is not an ISO 8601 date-time (or "now"): ${JSON.stringify(r.at)}`);
    else at = parsed;
  }
  if (errors.length > 0) return { ok: false, errors };
  const job: ScheduleJob = {
    id: r.id as string,
    name: r.name as string,
    ...(hasCron ? { cron: r.cron as string } : { at: r.at as string }),
    ...(r.tz !== undefined ? { tz: r.tz as string } : {}),
    mode: r.mode as JobMode,
    prompt: r.prompt as string,
    enabled: r.enabled as boolean,
    ...(r.originSessionId !== undefined ? { originSessionId: r.originSessionId as string } : {}),
    ...(r.originCwd !== undefined ? { originCwd: r.originCwd as string } : {}),
  };
  return { ok: true, job, cron, at };
}

/** Parse + validate a whole `schedule.json` text (null = the file does not exist). */
export function validateSchedule(text: string | null): ValidatedSchedule {
  if (text === null) return { valid: [], invalid: [], fileError: null };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { valid: [], invalid: [], fileError: `not valid JSON: ${(err as Error).message}` };
  }
  const shapeError = docShapeError(doc);
  if (shapeError) return { valid: [], invalid: [], fileError: shapeError };
  const jobs = (doc as { jobs: unknown[] }).jobs;
  const valid: ValidJob[] = [];
  const invalid: InvalidJob[] = [];
  const seen = new Set<string>();
  jobs.forEach((raw, index) => {
    const r = raw as Record<string, unknown> | null;
    const id = r && typeof r === 'object' && typeof r.id === 'string' ? r.id : null;
    const name = r && typeof r === 'object' && typeof r.name === 'string' ? r.name : null;
    const v = validateJob(raw);
    if (!v.ok) {
      invalid.push({ index, id, name, errors: v.errors, raw });
      return;
    }
    if (seen.has(v.job.id)) {
      invalid.push({ index, id, name, errors: [`duplicate id "${v.job.id}" (the first one wins)`], raw });
      return;
    }
    seen.add(v.job.id);
    valid.push({ job: v.job, index, cron: v.cron, at: v.at });
  });
  return { valid, invalid, fileError: null };
}

function docShapeError(doc: unknown): string | null {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'the top level must be an object { "jobs": [...] }';
  if (!Array.isArray((doc as Record<string, unknown>).jobs)) return '"jobs" must be an array';
  return null;
}

// ---------------------------------------------------------------------------
// Run log

export type RunOutcome = 'fired' | 'failed' | 'refused' | 'skipped';

/** One line of `assistant-runs.jsonl`. Append-only; never rewritten. */
export interface RunEntry {
  jobId: string;
  /** When the entry was written (ISO). */
  time: string;
  /** The occurrence this run accounts for (ISO). For a skip: the latest missed occurrence. */
  scheduledFor: string;
  mode: JobMode;
  outcome: RunOutcome;
  /** The session the run was delivered to (inline: the assistant session; isolated: its job session). */
  sessionFile?: string | null;
  error?: string;
}

/**
 * The append-only run log. Loaded once and kept in memory (the server is its
 * only writer); every append goes to the file and the memory copy together. A
 * line that does not parse is skipped (a crash mid-append leaves at most one).
 */
export class RunLog {
  readonly filePath: string;
  private entries: RunEntry[] = [];
  private byJob = new Map<string, RunEntry[]>();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, RUN_LOG_FILE);
    let raw = '';
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {}
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as RunEntry;
        if (typeof e?.jobId === 'string' && typeof e.scheduledFor === 'string') this.remember(e);
      } catch {}
    }
  }

  append(entry: RunEntry): void {
    this.remember(entry);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      console.error(`[wherever] assistant scheduler: could not append to ${this.filePath}: ${(err as Error).message}`);
    }
  }

  forJob(jobId: string): readonly RunEntry[] {
    return this.byJob.get(jobId) ?? [];
  }

  all(): readonly RunEntry[] {
    return this.entries;
  }

  private remember(e: RunEntry): void {
    this.entries.push(e);
    let list = this.byJob.get(e.jobId);
    if (!list) {
      list = [];
      this.byJob.set(e.jobId, list);
    }
    list.push(e);
  }
}

// ---------------------------------------------------------------------------
// Pure planning

export type JobPlan =
  /** Disabled: never fires. */
  | { state: 'disabled'; next: null }
  /** A one-shot that already ran (or was skipped / refused): reported done. */
  | { state: 'done'; next: null }
  /** A cron with no occurrence within the search horizon (e.g. Feb 31). */
  | { state: 'never'; next: null }
  /** Next run in the future. */
  | { state: 'waiting'; next: number }
  /** Fire now, for the occurrence `scheduledFor` (the latest one at or before now). */
  | { state: 'due'; next: number; scheduledFor: number }
  /** Missed outside the grace window: record a skip for `scheduledFor`, do not fire. */
  | { state: 'missed'; next: number; scheduledFor: number };

export interface PlanOptions {
  /** Grace window in ms (a missed run older than this is skipped, not fired). */
  graceMs: number;
  /**
   * Occurrences at or before this instant are never "missed". The scheduler sets
   * it to when it first saw the job (a job with no run yet) or when it last saw
   * the job re-enabled or edited, so a job that never existed (or was off) for a
   * past occurrence does not catch up on it. Undefined with no run yet = now.
   */
  since?: number;
}

/**
 * Where a job stands at `now`: the pure next-run function (entry, timezone, run
 * log, now). `tz` is the job's EFFECTIVE timezone (its own `tz`, else the user's
 * current one), so a follows-the-user job moves with the user, and an `at`
 * without an offset is read in it.
 *
 * Recurring: the last accounted occurrence (the newest run entry's
 * `scheduledFor`, or `since`) is the base; if the first occurrence after it is
 * still in the future the job is waiting, otherwise runs were missed and the
 * LATEST missed one either fires once (inside the grace window) or is skipped.
 * One-shot: any run entry means done; `"now"` is due as soon as it is seen; a
 * past `at` fires inside the grace window, else is skipped (and then done).
 */
export function planJob(entry: ValidJob, tz: string, runs: readonly RunEntry[], now: number, opts: PlanOptions): JobPlan {
  if (!entry.job.enabled) return { state: 'disabled', next: null };
  if (entry.at !== undefined) {
    if (runs.length > 0) return { state: 'done', next: null };
    if (entry.at === 'now') return { state: 'due', next: now, scheduledFor: opts.since ?? now };
    const t = atToInstant(entry.at, tz);
    if (t > now) return { state: 'waiting', next: t };
    return t >= now - opts.graceMs ? { state: 'due', next: t, scheduledFor: t } : { state: 'missed', next: t, scheduledFor: t };
  }
  const spec = entry.cron!;
  let base: number | undefined;
  for (const r of runs) {
    const t = Date.parse(r.scheduledFor);
    if (Number.isFinite(t) && (base === undefined || t > base)) base = t;
  }
  if (opts.since !== undefined && (base === undefined || opts.since > base)) base = opts.since;
  if (base === undefined) base = now;
  const first = nextCronRun(spec, tz, base);
  if (first === null) return { state: 'never', next: null };
  if (first > now) return { state: 'waiting', next: first };
  const latest = prevCronRun(spec, tz, now) ?? first;
  return latest >= now - opts.graceMs
    ? { state: 'due', next: latest, scheduledFor: latest }
    : { state: 'missed', next: latest, scheduledFor: latest };
}

/** The effective timezone of a job: its pinned `tz`, else the user's current one. */
export function effectiveTimeZone(job: ScheduleJob, userTz: string): string {
  return job.tz ?? userTz;
}

// ---------------------------------------------------------------------------
// The store (the ONE in-process writer of schedule.json)

/** The schedule file could not be read as a schedule; a write would clobber it. */
export class ScheduleFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleFileError';
  }
}

/** A job given to `addJob` is not valid; nothing was written. */
export class ScheduleValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`invalid job: ${errors.join('; ')}`);
    this.name = 'ScheduleValidationError';
  }
}

export interface ScheduleStoreOptions {
  /** Test seam: called after the new content is staged, before the conflict check. */
  beforeCommit?: (attempt: number) => void;
  /** How many times a write re-reads and retries when the file changed under it. Default 5. */
  maxAttempts?: number;
}

/**
 * Reads and writes `schedule.json`. Every write goes through ONE serial queue,
 * re-reads the file, applies the change to what is on disk NOW, stages it in a
 * temp file, then checks the file did not change since it was read before the
 * atomic rename; if it did (a hand edit landed meanwhile), the whole
 * read-modify-write is retried on the new content, so the edit is never
 * clobbered (ADR 0015).
 */
export class ScheduleStore {
  readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly beforeCommit?: (attempt: number) => void;
  private readonly maxAttempts: number;

  constructor(folder: string, opts: ScheduleStoreOptions = {}) {
    this.filePath = path.join(folder, SCHEDULE_FILE);
    this.beforeCommit = opts.beforeCommit;
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  /** The raw file text, or null when it does not exist. */
  readRaw(): string | null {
    try {
      return fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Read + validate (on every read, ADR 0015). An I/O error reads as a file error. */
  read(): ValidatedSchedule {
    let text: string | null;
    try {
      text = this.readRaw();
    } catch (err) {
      return { valid: [], invalid: [], fileError: `could not read: ${(err as Error).message}` };
    }
    return validateSchedule(text);
  }

  /**
   * Apply `mutate` to the raw job list (unknown keys kept) through the write
   * queue. `mutate` may throw to abort (nothing is written).
   */
  update<T>(mutate: (jobs: unknown[]) => T): Promise<T> {
    const run = this.queue.then(
      () => this.updateNow(mutate),
      () => this.updateNow(mutate),
    );
    this.queue = run.catch(() => {});
    return run;
  }

  /** Validate and append a job. The id is generated when missing; a duplicate id is refused. */
  addJob(input: Omit<ScheduleJob, 'id'> & { id?: string }): Promise<ScheduleJob> {
    const candidate = { ...input, id: input.id ?? `job-${randomUUID().slice(0, 8)}` };
    const v = validateJob(candidate);
    if (!v.ok) return Promise.reject(new ScheduleValidationError(v.errors));
    const job = v.job;
    return this.update((jobs) => {
      if (jobs.some((j) => (j as Record<string, unknown> | null)?.id === job.id)) {
        throw new ScheduleValidationError([`a job with id "${job.id}" already exists`]);
      }
      jobs.push(job);
      return job;
    });
  }

  /** Remove a job by id. Resolves false when there was none. */
  removeJob(id: string): Promise<boolean> {
    return this.update((jobs) => {
      const before = jobs.length;
      for (let i = jobs.length - 1; i >= 0; i--) {
        if ((jobs[i] as Record<string, unknown> | null)?.id === id) jobs.splice(i, 1);
      }
      return jobs.length !== before;
    });
  }

  private async updateNow<T>(mutate: (jobs: unknown[]) => T): Promise<T> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const before = this.readRaw();
      let doc: Record<string, unknown>;
      if (before === null) doc = { jobs: [] };
      else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(before);
        } catch (err) {
          throw new ScheduleFileError(`${this.filePath} is not valid JSON (${(err as Error).message}); fix it by hand first`);
        }
        const shapeError = docShapeError(parsed);
        if (shapeError) throw new ScheduleFileError(`${this.filePath}: ${shapeError}; fix it by hand first`);
        doc = parsed as Record<string, unknown>;
      }
      const result = mutate(doc.jobs as unknown[]);
      const out = JSON.stringify(doc, null, 2) + '\n';
      const tmp = path.join(path.dirname(this.filePath), `.${SCHEDULE_FILE}.${process.pid}.${attempt}.tmp`);
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, out, 'utf8');
      try {
        this.beforeCommit?.(attempt);
        if (this.readRaw() !== before) {
          // Changed on disk since we read it: redo the change on the new content.
          fs.rmSync(tmp, { force: true });
          continue;
        }
        fs.renameSync(tmp, this.filePath);
        return result;
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    }
    throw new ScheduleFileError(`${this.filePath} kept changing while being written; try again`);
  }
}

// ---------------------------------------------------------------------------
// The user's timezone (server state)

export interface TimezoneChange {
  timezone: string;
  at: string;
  /** Who set it: `system` (initialised), `web`, `assistant`, ... */
  source: string;
}

interface TimezoneFile {
  timezone: string;
  updatedAt: string;
  /** Every change, oldest first (bounded). */
  history: TimezoneChange[];
}

const TIMEZONE_HISTORY_KEEP = 200;

/**
 * The user's CURRENT timezone: what a job without `tz` follows (ADR 0015). Server
 * state in the state dir, initialised to the system timezone, changed through
 * `set` (later tasks: the web's report and `assistant_set_timezone`). Every
 * change is recorded in the file's `history`.
 */
export class UserTimezone {
  readonly filePath: string;
  private state: TimezoneFile;

  constructor(stateDir: string, systemTz: string = systemTimeZone()) {
    this.filePath = path.join(stateDir, TIMEZONE_FILE);
    const loaded = this.load();
    if (loaded) this.state = loaded;
    else {
      const now = new Date().toISOString();
      const tz = isValidTimeZone(systemTz) ? systemTz : 'UTC';
      this.state = { timezone: tz, updatedAt: now, history: [{ timezone: tz, at: now, source: 'system' }] };
      this.write();
    }
  }

  get(): string {
    return this.state.timezone;
  }

  history(): readonly TimezoneChange[] {
    return this.state.history;
  }

  /** Change it. Throws on an unknown zone; resolves false (nothing written) when unchanged. */
  set(timezone: string, source: string): boolean {
    if (!isValidTimeZone(timezone)) throw new Error(`not a known IANA timezone: ${JSON.stringify(timezone)}`);
    if (timezone === this.state.timezone) return false;
    const at = new Date().toISOString();
    const history = [...this.state.history, { timezone, at, source }].slice(-TIMEZONE_HISTORY_KEEP);
    this.state = { timezone, updatedAt: at, history };
    this.write();
    return true;
  }

  private load(): TimezoneFile | null {
    try {
      const rec = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<TimezoneFile>;
      if (!isValidTimeZone(rec.timezone)) return null;
      return {
        timezone: rec.timezone,
        updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString(),
        history: Array.isArray(rec.history) ? rec.history.filter((h) => isValidTimeZone(h?.timezone)) : [],
      };
    } catch {
      return null;
    }
  }

  private write(): void {
    const dir = path.dirname(this.filePath);
    const tmp = path.join(dir, `.${TIMEZONE_FILE}.${process.pid}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(`[wherever] assistant scheduler: could not write ${this.filePath}: ${(err as Error).message}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
  }
}
