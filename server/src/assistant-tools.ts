import path from 'node:path';
import { Type } from 'typebox';
import type { BeforeAgentStartEvent, ExtensionAPI, InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { isValidTimeZone } from './assistant-cron.js';
import { ScheduleFileError, ScheduleValidationError, type JobMode, type ScheduleJob } from './assistant-schedule.js';
import type { ListedJob, ScheduleListing } from './assistant-scheduler.js';
import type { ChannelNotification, NotifyOutcome } from './assistant-channels.js';
import {
  ASSISTANT_NOTIFY_TEXT,
  ASSISTANT_SCHEDULE_ADD_TEXT,
  ASSISTANT_SCHEDULE_LIST_TEXT,
  ASSISTANT_SCHEDULE_REMOVE_TEXT,
  ASSISTANT_SET_TIMEZONE_TEXT,
  timezoneLine,
  type AssistantToolText,
} from './assistant-tool-text.js';

/**
 * The assistant's SCHEDULE and TIMEZONE tools for server-built sessions (spec
 * `assistant-session-and-channels`, ADR 0015), plus the per-turn timezone line.
 *
 * - `assistant_schedule_add`, `assistant_schedule_list`, `assistant_schedule_remove`,
 *   `assistant_set_timezone`: registered in EVERY server session (not only the
 *   assistant's) while `assistantFolder` is CONFIGURED, so any session's agent can
 *   hand a job to the assistant. Every job belongs to and runs as the assistant;
 *   the calling session is stamped as `originSessionId` / `originCwd` (context,
 *   not the execution location). Self-contained in the `say` / `attach_file`
 *   style: each `execute` calls the scheduler directly (its write queue and its
 *   timezone setter), no bridge, no side channel.
 * - When configured but NOT active (another server holds the folder lock, or the
 *   lock could not be taken), the tools stay registered and answer a clear
 *   lock-state error (decision: same tool set whatever the lock says, so the
 *   agent learns WHY it cannot schedule instead of not seeing the tools).
 * - `assistant_notify` (channel-seam-notify-and-web-push, ADR 0014): the one way
 *   to reach the user proactively, delivered at once to every channel through
 *   the dispatcher (assistant-channels.ts). Registered ONLY while the assistant
 *   is ACTIVE (`hooks.notify` set), so a refused server's sessions do not see it.
 * - The timezone line (`User's current timezone: <tz>`) is an INLINE pi extension
 *   (ADR 0004's conversation-mode pattern): `before_agent_start` APPENDS it to
 *   the prompt the event carries, never replacing it. It is added only to a
 *   session whose cwd is `assistantFolder` itself or its `jobs/` (path.resolve
 *   equality, like the controller's pointer check), and appends nothing while no
 *   timezone is known (assistant not active).
 *
 * The ops (`scheduleAdd`, ...) are separate from the tool wrappers so
 * `cli-assistant-tool-twins` can answer its `cli_request` ops with the same
 * code. Text lives in `assistant-tool-text.ts` (shared with the CLI twins).
 */

/** The slice of `AssistantScheduler` the tools drive (faked or a temp scheduler in tests). */
export interface AssistantScheduleBackend {
  addJob(input: Omit<ScheduleJob, 'id'> & { id?: string }): Promise<ScheduleJob>;
  removeJob(id: string): Promise<boolean>;
  list(): ScheduleListing;
  getUserTimezone(): string;
  setUserTimezone(timezone: string, source: string): boolean;
}

/** Whether the tools can act now: the backend while active, else the lock-state error. */
export type AssistantAccess = { ok: true; backend: AssistantScheduleBackend } | { ok: false; error: string };

/** The session calling a tool (resolved server-side, never from tool arguments). */
export interface AssistantToolCaller {
  sessionId: string | null;
  cwd: string;
  /** The caller's session file (`assistant_notify` maps an isolated job session to its job). */
  sessionFile?: string | null;
}

/** A job's origin, as recorded in `schedule.json` (context: who scheduled it). */
export interface JobOrigin {
  originSessionId?: string;
  originCwd?: string;
}

/** What `assistant_notify` drives: the channel dispatcher plus the scheduler's job mapping. */
export interface AssistantNotifyBackend {
  notify(notification: ChannelNotification): Promise<NotifyOutcome>;
  /** The origin of the job `jobId` (null when there is no such job). */
  jobOrigin(jobId: string): JobOrigin | null;
  /** The job an isolated job session was started for (the scheduler's job mapping), or null. */
  jobForSession(sessionFile: string): string | null;
}

export type AssistantNotifyAccess = { ok: true; backend: AssistantNotifyBackend } | { ok: false; error: string };

/**
 * What the pool needs to give a server session its assistant tools and, in the
 * assistant folder, its timezone line. Set on the pool only while
 * `assistantFolder` is configured (`SessionPool.setAssistantSessionHooks`).
 */
export interface AssistantSessionHooks {
  /** The configured (resolved) assistant folder. */
  folder: string;
  /** Read at every tool call: the scheduler while active, else the lock-state error. */
  access(): AssistantAccess;
  /**
   * `assistant_notify`'s backend, read at every call. Set ONLY while the
   * assistant is ACTIVE (configured AND this server holds the folder lock):
   * without it the tool is not registered at all (decision, per the task's
   * acceptance criteria: unlike the schedule tools, a refused server's sessions
   * do not see `assistant_notify`, since no channel could run there).
   */
  notify?: () => AssistantNotifyAccess;
}

export type OpResult = { ok: true; text: string; details: unknown } | { ok: false; error: string };

/** The `source` recorded in the timezone history for a change made by `assistant_set_timezone`. */
export const SET_TIMEZONE_SOURCE = 'assistant_set_timezone';
/** The `source` recorded for a change reported by a web client on connect. */
export const WEB_TIMEZONE_SOURCE = 'web';

/** The lock-state error a tool answers when the assistant is configured but not active here. */
export function assistantNotActiveError(lock: { state: string; message?: string } | null): string {
  const why = lock && lock.state !== 'held' && lock.message ? lock.message : 'the assistant is not active on this server';
  return `The wherever assistant is configured but NOT active on this server (folder lock ${lock?.state ?? 'missing'}): ${why}`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function errorOf(err: unknown): string {
  if (err instanceof ScheduleValidationError || err instanceof ScheduleFileError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Ops

/**
 * Add a job through the scheduler's write queue, stamping the caller as origin.
 * Always `enabled: true` (decision: a disabled job is a hand edit, not a tool
 * call). Refuses (nothing written) on any invalid field, and on a prompt
 * starting with `!` (the scheduler would refuse it at run time anyway).
 */
export async function scheduleAdd(backend: AssistantScheduleBackend, caller: AssistantToolCaller, args: unknown): Promise<OpResult> {
  const a = (args ?? {}) as Record<string, unknown>;
  const prompt = str(a.prompt);
  if (prompt !== undefined && prompt.trimStart().startsWith('!')) {
    return { ok: false, error: 'a scheduled prompt must not start with "!" (shell commands are never run from a schedule)' };
  }
  const input: Omit<ScheduleJob, 'id'> = {
    name: a.name as string,
    ...(a.cron !== undefined ? { cron: a.cron as string } : {}),
    ...(a.at !== undefined ? { at: a.at as string } : {}),
    ...(a.tz !== undefined && a.tz !== '' ? { tz: a.tz as string } : {}),
    mode: a.mode as JobMode,
    prompt: a.prompt as string,
    enabled: true,
    ...(caller.sessionId ? { originSessionId: caller.sessionId } : {}),
    originCwd: caller.cwd,
  };
  let job: ScheduleJob;
  try {
    job = await backend.addJob(input);
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
  const listed = safeList(backend)?.jobs.find((j) => j.job.id === job.id);
  const when = listed ? describeNext(listed) : '';
  return {
    ok: true,
    text: `Scheduled "${job.name}" (id ${job.id}): ${describeTiming(job, listed?.timezone)}, ${job.mode}${when}. It runs as the assistant.`,
    details: { job, next: listed?.next ?? null, timezone: listed?.timezone ?? null },
  };
}

/** List every job, marking the caller's, with done and invalid entries. */
export function scheduleList(backend: AssistantScheduleBackend, caller: AssistantToolCaller): OpResult {
  let listing: ScheduleListing;
  try {
    listing = backend.list();
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
  const mine = (j: ListedJob) => !!caller.sessionId && j.job.originSessionId === caller.sessionId;
  const lines: string[] = [`User's current timezone: ${listing.timezone}`];
  if (listing.fileError) lines.push(`schedule.json cannot be read, so nothing fires until it is fixed by hand: ${listing.fileError}`);
  lines.push(`Jobs (${listing.jobs.length}):`);
  if (listing.jobs.length === 0) lines.push('- (none)');
  for (const j of listing.jobs) {
    const last = j.last ? `, last ${j.last.outcome} ${j.last.time}` : '';
    lines.push(
      `- ${mine(j) ? '[yours] ' : ''}${j.job.id} "${j.job.name}": ${describeTiming(j.job, j.timezone)}, ${j.job.mode}, ` +
        `${j.job.enabled ? '' : 'disabled, '}${j.state}${j.next ? `, next ${j.next}` : ''}${last}` +
        `${j.job.originCwd ? ` (from ${j.job.originCwd})` : ''}`,
    );
  }
  if (listing.invalid.length > 0) {
    lines.push(`Invalid entries, never run (${listing.invalid.length}):`);
    for (const inv of listing.invalid) {
      lines.push(`- entry #${inv.index}${inv.id ? ` ${inv.id}` : ''}${inv.name ? ` "${inv.name}"` : ''}: ${inv.errors.join('; ')}`);
    }
  }
  return {
    ok: true,
    text: lines.join('\n'),
    details: {
      timezone: listing.timezone,
      fileError: listing.fileError,
      jobs: listing.jobs.map((j) => ({ ...j, mine: mine(j) })),
      invalid: listing.invalid.map(({ raw: _raw, ...rest }) => rest),
    },
  };
}

export async function scheduleRemove(backend: AssistantScheduleBackend, args: unknown): Promise<OpResult> {
  const id = str((args as Record<string, unknown> | null)?.id)?.trim();
  if (!id) return { ok: false, error: 'an "id" is required (see assistant_schedule_list)' };
  let removed: boolean;
  try {
    removed = await backend.removeJob(id);
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
  if (!removed) return { ok: false, error: `no job with id "${id}" (see assistant_schedule_list)` };
  return { ok: true, text: `Removed job ${id}.`, details: { id, removed: true } };
}

export function setTimezone(backend: AssistantScheduleBackend, args: unknown, source: string = SET_TIMEZONE_SOURCE): OpResult {
  const tz = str((args as Record<string, unknown> | null)?.timezone)?.trim();
  if (!tz || !isValidTimeZone(tz)) {
    return { ok: false, error: `not a known IANA timezone: ${JSON.stringify(tz ?? null)} (e.g. Europe/Paris, America/New_York)` };
  }
  let changed: boolean;
  try {
    changed = backend.setUserTimezone(tz, source);
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
  return {
    ok: true,
    text: changed
      ? `The user's timezone is now ${tz}; every job without its own tz follows it.`
      : `The user's timezone was already ${tz}; nothing changed.`,
    details: { timezone: tz, changed },
  };
}

/** How the tap target was chosen (the precedence of `resolveNotifyTarget`). */
export type NotifyTargetVia = 'navigateSessionId' | 'job' | 'caller';

export interface NotifyTarget {
  /** The session the notification opens (null only for a caller without a session id). */
  sessionId: string | null;
  via: NotifyTargetVia;
  /** The job the notification is about (given, or the caller's own isolated job), or null. */
  jobId: string | null;
  /** That job's origin, when the job exists. */
  job: JobOrigin | null;
}

/**
 * The tap target precedence of `assistant_notify` (pure): `navigateSessionId`
 * when given; else, when a `jobId` is given or the caller is an isolated job
 * session (the scheduler's job mapping), the job's ORIGIN session; else the
 * calling session. A job that is unknown (removed) or has no origin session
 * falls through to the calling session (decision: a notification is never
 * refused over its tap target).
 */
export function resolveNotifyTarget(input: {
  navigateSessionId?: string;
  jobId?: string;
  callerSessionId: string | null;
  callerJobId: string | null;
  jobOrigin: (jobId: string) => JobOrigin | null;
}): NotifyTarget {
  const jobId = input.jobId || input.callerJobId || null;
  const job = jobId ? input.jobOrigin(jobId) : null;
  if (input.navigateSessionId) return { sessionId: input.navigateSessionId, via: 'navigateSessionId', jobId, job };
  if (job?.originSessionId) return { sessionId: job.originSessionId, via: 'job', jobId, job };
  return { sessionId: input.callerSessionId, via: 'caller', jobId, job };
}

/**
 * The notification's `source` (WHO notified): the origin FOLDER's name. For a
 * job (given or the caller's own), the folder it was scheduled from; otherwise
 * the calling session's folder. Decision: folder names, not session names
 * (sessions are mostly unnamed, and the folder is what the sidebar groups by).
 */
export function notifySource(callerCwd: string, job: JobOrigin | null): string {
  const cwd = job?.originCwd || callerCwd;
  return path.basename(path.resolve(cwd)) || cwd;
}

/** `assistant_notify`: deliver to every channel at once, with the tap target per `resolveNotifyTarget`. */
export async function notifyOp(backend: AssistantNotifyBackend, caller: AssistantToolCaller, args: unknown): Promise<OpResult> {
  const a = (args ?? {}) as Record<string, unknown>;
  const title = str(a.title)?.trim();
  const body = str(a.body)?.trim() ?? '';
  if (!title) return { ok: false, error: 'a non-empty "title" is required' };
  const navigateSessionId = str(a.navigateSessionId)?.trim() || undefined;
  const jobId = str(a.jobId)?.trim() || undefined;
  let callerJobId: string | null = null;
  try {
    callerJobId = caller.sessionFile ? backend.jobForSession(caller.sessionFile) : null;
  } catch {
    callerJobId = null;
  }
  const target = resolveNotifyTarget({
    navigateSessionId,
    jobId,
    callerSessionId: caller.sessionId,
    callerJobId,
    jobOrigin: (id) => {
      try {
        return backend.jobOrigin(id);
      } catch {
        return null;
      }
    },
  });
  if (!target.sessionId) return { ok: false, error: 'this session has no id yet, so there is nothing to open; pass navigateSessionId' };
  const source = notifySource(caller.cwd, target.job);
  const outcome = await backend.notify({ title, body, source, navigate: target.sessionId });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const reached = outcome.deliveries
    .filter((d) => d.result.ok)
    .map((d) => `${d.channel}${d.result.ok && d.result.detail ? ` (${d.result.detail})` : ''}`);
  const failed = outcome.deliveries.filter((d) => !d.result.ok).map((d) => `${d.channel}: ${d.result.ok ? '' : d.result.error}`);
  const unknownJob = jobId && !target.job ? ` (no job "${jobId}" was found, so it opens this session)` : '';
  return {
    ok: true,
    text:
      `Notified the user via ${reached.join(', ')}; tapping it opens session ${target.sessionId}${unknownJob}.` +
      (failed.length > 0 ? ` Not delivered on: ${failed.join('; ')}.` : ''),
    details: { target, source, deliveries: outcome.deliveries },
  };
}

function safeList(backend: AssistantScheduleBackend): ScheduleListing | null {
  try {
    return backend.list();
  } catch {
    return null;
  }
}

function describeTiming(job: ScheduleJob, effectiveTz: string | undefined): string {
  const when = job.cron !== undefined ? `cron "${job.cron}"` : `at "${job.at}"`;
  const tz = job.tz ? `pinned to ${job.tz}` : `follows the user${effectiveTz ? `: ${effectiveTz}` : ''}`;
  return `${when} (${tz})`;
}

function describeNext(j: ListedJob): string {
  return j.next ? `, next run ${j.next}` : `, ${j.state}`;
}

// ---------------------------------------------------------------------------
// Tools

type ToolResult = { content: Array<{ type: 'text'; text: string }>; details: unknown; isError?: boolean };

function toResult(name: string, r: OpResult): ToolResult {
  if (r.ok) return { content: [{ type: 'text', text: r.text }], details: r.details };
  return { content: [{ type: 'text', text: `${name}: ${r.error}` }], details: undefined, isError: true };
}

function tool(
  text: AssistantToolText,
  parameters: unknown,
  hooks: AssistantSessionHooks,
  run: (backend: AssistantScheduleBackend, params: unknown) => OpResult | Promise<OpResult>,
): ToolDefinition {
  return {
    name: text.name,
    label: text.label,
    description: text.description,
    promptSnippet: text.promptSnippet,
    promptGuidelines: [...text.promptGuidelines],
    parameters,
    async execute(_toolCallId: string, params: unknown) {
      const access = hooks.access();
      if (!access.ok) return toResult(text.name, { ok: false, error: access.error });
      return toResult(text.name, await run(access.backend, params));
    },
  } as unknown as ToolDefinition;
}

/**
 * The tools for one server session: the four schedule / timezone tools, plus
 * `assistant_notify` while active (`hooks.notify`). `caller` is read at call
 * time (a session's id is stable).
 */
export function createAssistantTools(hooks: AssistantSessionHooks, caller: () => AssistantToolCaller): ToolDefinition[] {
  return [
    tool(
      ASSISTANT_SCHEDULE_ADD_TEXT,
      Type.Object({
        name: Type.String({ description: 'Short human name for the job (shown in listings and in the scheduled turn).' }),
        prompt: Type.String({
          description:
            'What the assistant should do when the job fires, written to make sense on its own. A prompt starting with "/" runs that command or skill.',
        }),
        mode: Type.Union([Type.Literal('inline'), Type.Literal('isolated')], {
          description: '"inline": into the current assistant conversation once it is idle. "isolated": at once, in a fresh side session.',
        }),
        cron: Type.Optional(Type.String({ description: '5-field cron for a recurring job, e.g. "0 8 * * *" (every day at 08:00). Exactly one of cron / at.' })),
        at: Type.Optional(
          Type.String({ description: 'One-shot time: ISO 8601 date-time (e.g. "2026-11-06T17:30"), or "now". Exactly one of cron / at.' }),
        ),
        tz: Type.Optional(
          Type.String({ description: "IANA timezone to PIN the job to. Omit to follow the user's current timezone (the usual case)." }),
        ),
      }),
      hooks,
      (backend, params) => scheduleAdd(backend, caller(), params),
    ),
    tool(ASSISTANT_SCHEDULE_LIST_TEXT, Type.Object({}), hooks, (backend) => scheduleList(backend, caller())),
    tool(
      ASSISTANT_SCHEDULE_REMOVE_TEXT,
      Type.Object({ id: Type.String({ description: 'The id of the job to remove (from assistant_schedule_list).' }) }),
      hooks,
      (backend, params) => scheduleRemove(backend, params),
    ),
    tool(
      ASSISTANT_SET_TIMEZONE_TEXT,
      Type.Object({ timezone: Type.String({ description: 'IANA timezone name, e.g. "Europe/Paris" or "America/New_York".' }) }),
      hooks,
      (backend, params) => setTimezone(backend, params),
    ),
    ...(hooks.notify ? [createNotifyTool(hooks.notify, caller)] : []),
  ];
}

/** `assistant_notify` for one server session (only while active, see `AssistantSessionHooks.notify`). */
export function createNotifyTool(access: () => AssistantNotifyAccess, caller: () => AssistantToolCaller): ToolDefinition {
  const text = ASSISTANT_NOTIFY_TEXT;
  return {
    name: text.name,
    label: text.label,
    description: text.description,
    promptSnippet: text.promptSnippet,
    promptGuidelines: [...text.promptGuidelines],
    parameters: Type.Object({
      title: Type.String({ description: 'Short headline, e.g. "Deploy finished" or "CI is red".' }),
      body: Type.String({ description: 'The message itself: one or two sentences the user can act on.' }),
      navigateSessionId: Type.Optional(Type.String({ description: 'The session id a tap should open (default: see the description).' })),
      jobId: Type.Optional(Type.String({ description: 'The scheduled job this is about; a tap then opens the session that scheduled it.' })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const a = access();
      if (!a.ok) return toResult(text.name, { ok: false, error: a.error });
      return toResult(text.name, await notifyOp(a.backend, caller(), params));
    },
  } as unknown as ToolDefinition;
}

// ---------------------------------------------------------------------------
// The timezone line

/** True when `cwd` is the assistant folder itself or its `jobs/` (where the timezone line applies). */
export function isAssistantFolderCwd(cwd: string, folder: string): boolean {
  const c = path.resolve(cwd);
  const f = path.resolve(folder);
  return c === f || c === path.join(f, 'jobs');
}

/** Append the timezone line to the prompt the event carries (never replacing it). */
export function appendTimezoneLine(systemPrompt: string, timezone: string): string {
  return `${systemPrompt}\n\n${timezoneLine(timezone)}`;
}

/**
 * The inline extension that appends the timezone line on EVERY turn. The zone is
 * read at `before_agent_start`, so a change made mid-session shows on the next
 * turn; null (not active) appends nothing.
 */
export function createTimezoneLineExtension(getTimezone: () => string | null): InlineExtension {
  const factory = (pi: ExtensionAPI) => {
    pi.on('before_agent_start', (event: BeforeAgentStartEvent) => {
      let tz: string | null = null;
      try {
        tz = getTimezone();
      } catch {
        tz = null;
      }
      if (!tz) return;
      return { systemPrompt: appendTimezoneLine(event.systemPrompt, tz) };
    });
  };
  return { name: 'wherever-assistant-timezone', factory };
}

/** The current timezone through `hooks`, or null while not active. */
export function hooksTimezone(hooks: AssistantSessionHooks): string | null {
  const access = hooks.access();
  if (!access.ok) return null;
  return access.backend.getUserTimezone();
}

/**
 * What a server session in `cwd` gets from the assistant: the four schedule
 * tools (always, while configured), `assistant_notify` (only while active) and, only in the assistant folder or `jobs/`, the timezone
 * line extension. Empty with `hooks` undefined (assistant not configured), so
 * the session's tools and extensions are exactly as without the feature.
 */
export function assistantSessionParts(
  hooks: AssistantSessionHooks | undefined,
  cwd: string,
  caller: () => AssistantToolCaller,
): { customTools: ToolDefinition[]; extensionFactories: InlineExtension[] } {
  if (!hooks) return { customTools: [], extensionFactories: [] };
  return {
    customTools: createAssistantTools(hooks, caller),
    extensionFactories: isAssistantFolderCwd(cwd, hooks.folder) ? [createTimezoneLineExtension(() => hooksTimezone(hooks))] : [],
  };
}
