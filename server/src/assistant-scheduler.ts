import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_GRACE_MS,
  RunLog,
  ScheduleStore,
  UserTimezone,
  effectiveTimeZone,
  planJob,
  type InvalidJob,
  type JobPlan,
  type RunEntry,
  type ScheduleJob,
  type ScheduleStoreOptions,
  type ValidJob,
  type ValidatedSchedule,
} from './assistant-schedule.js';

/**
 * The assistant SCHEDULER (spec `assistant-session-and-channels`, ADRs 0014 and
 * 0015): the firing loop inside the wherever server. It reads the intent in
 * `<assistantFolder>/schedule.json` (re-read on every tick, so hand edits are
 * picked up), derives what is due from the run log in the state dir, and fires:
 *
 * - **inline** jobs into the CURRENT assistant session, through the controller's
 *   `send(text, origin)`, only once that session is SETTLED with nothing queued
 *   (`agent_settled`, not `agent_end`: pi chains follow-ups and retries after
 *   `agent_end`). A CLI-bridge session whose extension lacks the `agent_settled`
 *   capability falls back to `agent_end`. One inline job at a time: the next
 *   waits for the settle of the previous one, so a job never merges into a
 *   running exchange.
 * - **isolated** jobs immediately, in parallel, each in a fresh (`forceNew`)
 *   session in `<assistantFolder>/jobs/`; the job-to-session mapping is the run
 *   log entry (read back by `jobForSession`, for `assistant_notify`).
 *
 * Every send carries the origin `schedule:<jobId>` (ADR 0014), so the pool
 * attributes the reply to the job and no channel hears it: neither mode
 * notifies on its own. A prompt starting with `!` / `!!` is refused (a failed
 * run with outcome `refused`) and never reaches the pool's shell path.
 *
 * Exists only while the assistant is ACTIVE (configured AND the folder lock is
 * held): `server/src/index.ts` builds it beside the controller. Nothing is
 * written (no run log, no timezone state) and no timer is armed before
 * `start()`.
 *
 * Seams: the pure planner `planJob` (assistant-schedule.ts), the
 * `ScheduleStore`, and this loop with an injected clock (`SchedulerClock`),
 * pool port and controller port.
 */

/** The slice of `SessionPool` the scheduler drives (faked in tests). */
export interface SchedulerPoolPort {
  createNewSession(
    cwd: string,
    modelStr?: string,
    gitInit?: boolean,
    createRemote?: boolean,
    repoVisibility?: 'private' | 'public',
    forceNew?: boolean,
  ): Promise<{ tracked: { sessionFile: string; sessionId: string; cwd: string }; error?: string }>;
  sendUserMessage(
    sessionFile: string,
    text: string,
    streamingBehavior?: 'steer' | 'followUp',
    conversationMode?: boolean,
    origin?: string,
  ): Promise<void>;
  getSession(sessionFile: string): { type: 'server' | 'cli' } | null;
  isStreaming(sessionFile: string): boolean;
  getCliCapabilities(sessionFile: string): readonly string[] | null;
  /** pi's queued steer + followUp count; null when not readable (not resident, CLI). */
  getQueuedMessageCount(sessionFile: string): number | null;
  subscribeEvents(listener: (sessionFile: string, event: { type: string; [k: string]: unknown }, destination: string | null) => void): () => void;
}

/** The slice of `AssistantController` the scheduler drives (faked in tests). */
export interface SchedulerControllerPort {
  ensureCurrent(): Promise<{ sessionFile: string }>;
  send(text: string, origin: string, streamingBehavior?: 'steer' | 'followUp'): Promise<void>;
  status(): { currentSessionFile: string | null };
  /** After an aborted settle: clear pi's leftover queue and record what was dropped. */
  clearAfterAbort(sessionFile: string): unknown;
}

/** Injected time: the scheduler never reads `Date.now()` or arms a real timer directly. */
export interface SchedulerClock {
  now(): number;
  /** Arm a one-shot timer; returns its cancel. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};

/** Longest gap between two ticks (each re-reads `schedule.json`, picking up hand edits). */
export const MAX_TICK_MS = 30_000;
const MIN_TICK_MS = 500;
/**
 * A CLI-bridge send that never produced an `agent_start` (an extension command
 * handled it in the terminal, which the server cannot see, ADR 0014) stops
 * blocking inline jobs after this long.
 */
export const CLI_START_TIMEOUT_MS = 60_000;

export interface AssistantSchedulerOptions {
  /** The ACTIVE assistant folder (absolute). */
  folder: string;
  /** The wherever state dir. */
  stateDir: string;
  pool: SchedulerPoolPort;
  controller: SchedulerControllerPort;
  clock?: SchedulerClock;
  /** Restart grace window (default 1 h, config `assistantScheduleGraceMinutes`). */
  graceMs?: number;
  /** The timezone the user state is initialised to on first start (default: the system's). */
  systemTimezone?: string;
  /** Called after the user's timezone changed (the tools task pushes `assistant_info_changed`). */
  onTimezoneChange?: (timezone: string) => void;
  store?: ScheduleStoreOptions;
}

/** One job as listed (for the schedule tools). */
export interface ListedJob {
  job: ScheduleJob;
  /** The timezone its times are evaluated in right now. */
  timezone: string;
  state: JobPlan['state'] | 'pending';
  /** Next run (ISO), null when none. */
  next: string | null;
  last: RunEntry | null;
}

export interface ScheduleListing {
  timezone: string;
  fileError: string | null;
  jobs: ListedJob[];
  invalid: InvalidJob[];
}

interface SeenJob {
  firstSeen: number;
  enabled: boolean;
  fingerprint: string;
  /** When this process last saw the job re-enabled or its time spec edited. */
  changedAt?: number;
}

interface RunMark {
  at: number;
  /** An `agent_start` was seen (the run is real, so only a settle ends it). */
  started: boolean;
}

export class AssistantScheduler {
  readonly store: ScheduleStore;
  private readonly folder: string;
  private readonly stateDir: string;
  private readonly pool: SchedulerPoolPort;
  private readonly controller: SchedulerControllerPort;
  private readonly clock: SchedulerClock;
  private readonly graceMs: number;
  private readonly systemTimezone?: string;
  private readonly onTimezoneChange?: (timezone: string) => void;

  private runLog: RunLog | null = null;
  private timezone: UserTimezone | null = null;
  private started = false;
  private stopped = false;
  private cancelTimer: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private ticking: Promise<void> = Promise.resolve();
  private work = new Set<Promise<unknown>>();
  private lastRead: ValidatedSchedule = { valid: [], invalid: [], fileError: null };
  private lastInvalidKey = '';
  private seen = new Map<string, SeenJob>();
  /** Due inline jobs waiting for the assistant session to settle, oldest first. */
  private pendingInline: Array<{ jobId: string; scheduledFor: number }> = [];
  /** Isolated jobs being started (their run entry not written yet). */
  private startingIsolated = new Set<string>();
  /** Sessions with a run in progress, as seen from events and our own sends. */
  private runs = new Map<string, RunMark>();
  private draining = false;
  private jobSessions = new Map<string, string>();

  constructor(opts: AssistantSchedulerOptions) {
    this.folder = path.resolve(opts.folder);
    this.stateDir = opts.stateDir;
    this.pool = opts.pool;
    this.controller = opts.controller;
    this.clock = opts.clock ?? realClock;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.systemTimezone = opts.systemTimezone;
    this.onTimezoneChange = opts.onTimezoneChange;
    this.store = new ScheduleStore(this.folder, opts.store);
  }

  /** Load the run log and timezone state, subscribe to the pool, and run the first tick (restart catch-up). */
  start(): Promise<void> {
    if (this.started) return this.ticking;
    this.started = true;
    this.runLog = new RunLog(this.stateDir);
    this.timezone = new UserTimezone(this.stateDir, this.systemTimezone);
    for (const e of this.runLog.all()) {
      if (e.mode === 'isolated' && e.sessionFile) this.jobSessions.set(e.sessionFile, e.jobId);
    }
    this.unsubscribe = this.pool.subscribeEvents((file, event) => this.handleEvent(file, event));
    return this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves once the current tick and every send it started have settled (tests, shutdown). */
  async idle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await this.ticking;
      if (this.work.size === 0) return;
      await Promise.allSettled([...this.work]);
    }
  }

  /** The user's current timezone (what a job without `tz` follows). */
  getUserTimezone(): string {
    return this.requireTimezone().get();
  }

  /**
   * Change the user's timezone (validated IANA name; recorded). Re-plans at
   * once, since every follows-the-user job moves with it. Resolves false when
   * it was already that zone.
   */
  setUserTimezone(timezone: string, source: string): boolean {
    const changed = this.requireTimezone().set(timezone, source);
    if (changed) {
      console.log(`[wherever] assistant: the user's timezone is now ${timezone} (${source})`);
      try {
        this.onTimezoneChange?.(timezone);
      } catch (err) {
        console.error(`[wherever] assistant scheduler: onTimezoneChange failed: ${errMessage(err)}`);
      }
      void this.tick();
    }
    return changed;
  }

  /** Add a job through the store's write queue, then tick (an `at: "now"` job fires at once). */
  async addJob(input: Omit<ScheduleJob, 'id'> & { id?: string }): Promise<ScheduleJob> {
    const job = await this.store.addJob(input);
    void this.tick();
    return job;
  }

  async removeJob(id: string): Promise<boolean> {
    const removed = await this.store.removeJob(id);
    this.pendingInline = this.pendingInline.filter((p) => p.jobId !== id);
    void this.tick();
    return removed;
  }

  /** The job an isolated job session was started for, or null. */
  jobForSession(sessionFile: string): string | null {
    return this.jobSessions.get(sessionFile) ?? null;
  }

  /** Every job with its state and last / next run, plus the invalid entries. Re-reads the file. */
  list(): ScheduleListing {
    const read = this.store.read();
    const now = this.clock.now();
    const userTz = this.getUserTimezone();
    const runLog = this.requireRunLog();
    const jobs = read.valid.map((v): ListedJob => {
      const tz = effectiveTimeZone(v.job, userTz);
      const runs = runLog.forJob(v.job.id);
      const plan = planJob(v, tz, runs, now, { graceMs: this.graceMs, since: this.sinceFor(v, runs.length > 0, now) });
      const pending = this.pendingInline.some((p) => p.jobId === v.job.id);
      return {
        job: v.job,
        timezone: tz,
        state: pending ? 'pending' : plan.state,
        next: plan.next === null ? null : new Date(plan.next).toISOString(),
        last: runs.at(-1) ?? null,
      };
    });
    return { timezone: userTz, fileError: read.fileError, jobs, invalid: read.invalid };
  }

  /**
   * One pass: re-read and validate `schedule.json`, plan every job, record
   * skips, fire what is due, try to deliver pending inline jobs, re-arm the
   * timer. Serialised; safe to call at any time (it is also the test seam).
   */
  tick(): Promise<void> {
    const run = this.ticking.then(() => this.tickNow());
    this.ticking = run.catch((err) => {
      console.error(`[wherever] assistant scheduler: tick failed: ${errMessage(err)}`);
    });
    return this.ticking;
  }

  // -------------------------------------------------------------------------

  private tickNow(): void {
    if (this.stopped || !this.started) return;
    const now = this.clock.now();
    const read = this.store.read();
    this.lastRead = read;
    this.reportInvalid(read);
    const userTz = this.getUserTimezone();
    const runLog = this.requireRunLog();
    const ids = new Set<string>();
    let soonest: number | null = null;
    for (const v of read.valid) {
      ids.add(v.job.id);
      this.track(v, now);
      if (this.isInFlight(v.job.id)) continue;
      const runs = runLog.forJob(v.job.id);
      const plan = planJob(v, effectiveTimeZone(v.job, userTz), runs, now, {
        graceMs: this.graceMs,
        since: this.sinceFor(v, runs.length > 0, now),
      });
      if (plan.state === 'waiting') {
        if (soonest === null || plan.next < soonest) soonest = plan.next;
      } else if (plan.state === 'missed') {
        console.log(
          `[wherever] assistant scheduler: job "${v.job.id}" missed its run of ${new Date(plan.scheduledFor).toISOString()} (outside the grace window); skipped`,
        );
        this.record(v.job, plan.scheduledFor, 'skipped');
        if (v.cron) {
          // Its next occurrence still needs a timer.
          const after = planJob(v, effectiveTimeZone(v.job, userTz), runLog.forJob(v.job.id), now, {
            graceMs: this.graceMs,
            since: this.sinceFor(v, true, now),
          });
          if (after.state === 'waiting' && (soonest === null || after.next < soonest)) soonest = after.next;
        }
      } else if (plan.state === 'due') {
        this.fire(v, plan.scheduledFor);
      }
    }
    for (const id of [...this.seen.keys()]) if (!ids.has(id)) this.seen.delete(id);
    this.pendingInline = this.pendingInline.filter((p) => ids.has(p.jobId));
    void this.drainInline();
    this.arm(soonest, now);
  }

  private isInFlight(jobId: string): boolean {
    return this.startingIsolated.has(jobId) || this.pendingInline.some((p) => p.jobId === jobId);
  }

  /** Remember when a job was first seen, re-enabled, or had its time spec edited. */
  private track(v: ValidJob, now: number): void {
    const fingerprint = JSON.stringify([v.job.cron ?? null, v.job.at ?? null, v.job.tz ?? null]);
    const prev = this.seen.get(v.job.id);
    if (!prev) {
      this.seen.set(v.job.id, { firstSeen: now, enabled: v.job.enabled, fingerprint });
      return;
    }
    if ((!prev.enabled && v.job.enabled) || prev.fingerprint !== fingerprint) prev.changedAt = now;
    prev.enabled = v.job.enabled;
    prev.fingerprint = fingerprint;
  }

  /**
   * The planner's `since`: occurrences before it are not "missed". A job with
   * no run yet counts from when this process first saw it (so a job added, or
   * hand-written, while the server was down does not catch up on a run from
   * before it existed); a job re-enabled or edited counts from then. A job WITH
   * runs and no change counts from its last run, which is what lets a restart
   * catch up on a run missed while the server was down.
   */
  private sinceFor(v: ValidJob, hasRuns: boolean, now: number): number | undefined {
    const s = this.seen.get(v.job.id);
    if (s?.changedAt !== undefined) return s.changedAt;
    if (hasRuns) return undefined;
    return s?.firstSeen ?? now;
  }

  private fire(v: ValidJob, scheduledFor: number): void {
    const job = v.job;
    if (job.prompt.trimStart().startsWith('!')) {
      console.warn(`[wherever] assistant scheduler: job "${job.id}" refused: a scheduled prompt cannot run a shell command ("!")`);
      this.record(job, scheduledFor, 'refused', null, 'prompts starting with "!" are refused (no shell commands from the scheduler)');
      return;
    }
    if (job.mode === 'inline') {
      this.pendingInline.push({ jobId: job.id, scheduledFor });
      return;
    }
    this.startIsolated(job, scheduledFor);
  }

  private startIsolated(job: ScheduleJob, scheduledFor: number): void {
    this.startingIsolated.add(job.id);
    const jobsDir = path.join(this.folder, 'jobs');
    const task = (async () => {
      let sessionFile: string | null = null;
      try {
        fs.mkdirSync(jobsDir, { recursive: true });
        const created = await this.pool.createNewSession(jobsDir, undefined, undefined, undefined, undefined, true);
        if (created.error || !created.tracked) throw new Error(created.error || 'could not create the job session');
        sessionFile = created.tracked.sessionFile;
        this.jobSessions.set(sessionFile, job.id);
        this.record(job, scheduledFor, 'fired', sessionFile);
      } catch (err) {
        console.error(`[wherever] assistant scheduler: isolated job "${job.id}" could not start: ${errMessage(err)}`);
        this.record(job, scheduledFor, 'failed', sessionFile, errMessage(err));
        return;
      } finally {
        this.startingIsolated.delete(job.id);
      }
      console.log(`[wherever] assistant scheduler: isolated job "${job.id}" started in ${sessionFile}`);
      try {
        await this.pool.sendUserMessage(sessionFile, formatScheduledPrompt(job), undefined, false, scheduleOrigin(job.id));
      } catch (err) {
        console.error(`[wherever] assistant scheduler: isolated job "${job.id}" failed: ${errMessage(err)}`);
        this.record(job, scheduledFor, 'failed', sessionFile, errMessage(err));
      }
    })();
    this.track_(task);
  }

  /** Deliver the oldest pending inline job if the current assistant session is settled and empty. */
  private async drainInline(): Promise<void> {
    if (this.draining || this.stopped || this.pendingInline.length === 0) return;
    this.draining = true;
    try {
      while (this.pendingInline.length > 0 && !this.stopped) {
        const head = this.pendingInline[0];
        const v = this.lastRead.valid.find((x) => x.job.id === head.jobId);
        if (!v || !v.job.enabled) {
          // Removed or disabled while it waited.
          this.pendingInline.shift();
          continue;
        }
        const current = this.controller.status().currentSessionFile;
        if (current && !this.isIdle(current)) return;
        let sessionFile: string;
        try {
          sessionFile = (await this.controller.ensureCurrent()).sessionFile;
        } catch (err) {
          this.pendingInline.shift();
          this.record(v.job, head.scheduledFor, 'failed', null, errMessage(err));
          continue;
        }
        if (!this.isIdle(sessionFile)) return;
        this.pendingInline.shift();
        this.runs.set(sessionFile, { at: this.clock.now(), started: false });
        this.record(v.job, head.scheduledFor, 'fired', sessionFile);
        console.log(`[wherever] assistant scheduler: inline job "${v.job.id}" sent to ${sessionFile}`);
        const job = v.job;
        const send = this.controller.send(formatScheduledPrompt(job), scheduleOrigin(job.id)).then(
          () => {
            // A server send resolves when pi is done with it (or an extension
            // command handled it, with no run and so no settle): unblock.
            if (this.pool.getSession(sessionFile)?.type === 'server' && !this.pool.isStreaming(sessionFile)) {
              this.runs.delete(sessionFile);
              void this.drainInline();
            }
          },
          (err) => {
            console.error(`[wherever] assistant scheduler: inline job "${job.id}" failed: ${errMessage(err)}`);
            this.record(job, head.scheduledFor, 'failed', sessionFile, errMessage(err));
            this.runs.delete(sessionFile);
            void this.drainInline();
          },
        );
        this.track_(send);
        // One at a time: the next waits for this one's settle.
        return;
      }
    } finally {
      this.draining = false;
    }
  }

  /** Settled with nothing queued: no run in progress (pool or ours) and pi's queues empty. */
  private isIdle(sessionFile: string): boolean {
    const session = this.pool.getSession(sessionFile);
    if (!session) {
      // Not resident: nothing can be running there (the send reloads it).
      this.runs.delete(sessionFile);
      return true;
    }
    if (this.pool.isStreaming(sessionFile)) return false;
    const mark = this.runs.get(sessionFile);
    if (mark) {
      const stale = session.type === 'cli' && !mark.started && this.clock.now() - mark.at > CLI_START_TIMEOUT_MS;
      if (!stale) return false;
      this.runs.delete(sessionFile);
    }
    return (this.pool.getQueuedMessageCount(sessionFile) ?? 0) === 0;
  }

  private handleEvent(sessionFile: string, event: { type: string; [k: string]: unknown }): void {
    if (this.stopped || !this.started) return;
    if (event.type === 'agent_start') {
      this.runs.set(sessionFile, { at: this.clock.now(), started: true });
      return;
    }
    if (event.type === 'agent_settled') {
      if (event.aborted === true && sessionFile === this.controller.status().currentSessionFile) {
        // An abort leaves pi's queues populated (ADR 0014): without clearing
        // them, "settled with nothing queued" would never be reached again.
        try {
          this.controller.clearAfterAbort(sessionFile);
        } catch (err) {
          console.error(`[wherever] assistant scheduler: clearing after an abort failed: ${errMessage(err)}`);
        }
      }
      this.runs.delete(sessionFile);
      void this.drainInline();
      return;
    }
    if (event.type === 'agent_end') {
      // An older CLI extension never forwards `agent_settled`: settle on agent_end.
      const session = this.pool.getSession(sessionFile);
      if (session?.type !== 'cli') return;
      if ((this.pool.getCliCapabilities(sessionFile) ?? []).includes('agent_settled')) return;
      this.runs.delete(sessionFile);
      void this.drainInline();
    }
  }

  private record(job: ScheduleJob, scheduledFor: number, outcome: RunEntry['outcome'], sessionFile: string | null = null, error?: string): void {
    this.requireRunLog().append({
      jobId: job.id,
      time: new Date(this.clock.now()).toISOString(),
      scheduledFor: new Date(scheduledFor).toISOString(),
      mode: job.mode,
      outcome,
      ...(sessionFile ? { sessionFile } : {}),
      ...(error ? { error } : {}),
    });
  }

  private arm(soonest: number | null, now: number): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.stopped) return;
    const delay = soonest === null ? MAX_TICK_MS : Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, soonest - now));
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = null;
      void this.tick();
    }, delay);
  }

  private reportInvalid(read: ValidatedSchedule): void {
    const key = JSON.stringify([read.fileError, read.invalid.map((i) => [i.index, i.errors])]);
    if (key === this.lastInvalidKey) return;
    this.lastInvalidKey = key;
    if (read.fileError) console.warn(`[wherever] assistant scheduler: ${this.store.filePath} is unreadable, no job runs: ${read.fileError}`);
    for (const i of read.invalid) {
      console.warn(
        `[wherever] assistant scheduler: ${this.store.filePath} entry #${i.index}${i.id ? ` ("${i.id}")` : ''} is invalid and will not run: ${i.errors.join('; ')}`,
      );
    }
  }

  private track_(p: Promise<unknown>): void {
    const tracked = p.catch(() => {});
    this.work.add(tracked);
    void tracked.then(() => this.work.delete(tracked));
  }

  private requireRunLog(): RunLog {
    if (!this.runLog) throw new Error('the assistant scheduler is not started');
    return this.runLog;
  }

  private requireTimezone(): UserTimezone {
    if (!this.timezone) throw new Error('the assistant scheduler is not started');
    return this.timezone;
  }
}

/** The reply-routing origin of a scheduled send (ADR 0014). */
export function scheduleOrigin(jobId: string): string {
  return `schedule:${jobId}`;
}

/**
 * The text a scheduled job sends: `[schedule:<name>] (from <originCwd>, session
 * <originSessionId>) <prompt>`, so the agent knows it is a job and where it came
 * from. A prompt starting with `/` goes WITHOUT the prefix, so command, skill and
 * prompt-template expansion (start-of-message anchored) still work. Missing
 * origin parts are left out (no parenthesis at all when both are).
 */
export function formatScheduledPrompt(job: ScheduleJob): string {
  const trimmed = job.prompt.trimStart();
  if (trimmed.startsWith('/')) return trimmed;
  const context: string[] = [];
  if (job.originCwd) context.push(`from ${job.originCwd}`);
  if (job.originSessionId) context.push(`session ${job.originSessionId}`);
  return `[schedule:${job.name}]${context.length > 0 ? ` (${context.join(', ')})` : ''} ${job.prompt}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
