/**
 * The SHARED TEXT of the `assistant_*` tools (spec `assistant-session-and-channels`,
 * ADRs 0015 and 0016): each tool's name, label, description, `promptSnippet` and
 * `promptGuidelines`, plus the per-turn timezone line.
 *
 * Owned by `assistant-schedule-tools-server` (which created it with the schedule
 * and timezone tools); `channel-seam-notify-and-web-push` added `assistant_notify`
 * here, and `cli-assistant-tool-twins` copies every entry (and `timezoneLine`) into the
 * extension's `pi.registerTool` twins (extension/src/assistant-tool-twins.ts)
 * under a drift test (server/test/assistant-tool-twins.test.ts, like
 * `say-tool.test.ts`): the extension is a separate published package that
 * cannot import from the server, so its copies must stay identical to these.
 * A change here must be made there too.
 *
 * Text only: no behaviour lives here, so a twin can copy it without dragging
 * server code along.
 */

export interface AssistantToolText {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

export const ASSISTANT_SCHEDULE_ADD_TEXT: AssistantToolText = {
  name: 'assistant_schedule_add',
  label: 'Assistant: Schedule',
  description:
    "Schedule a job for the wherever assistant. Every job belongs to the assistant and RUNS AS the assistant, " +
    'in its own folder, whichever session schedules it: this session is recorded only as the origin (context ' +
    'the job receives), never as where it runs. Give exactly one of `cron` (5-field, recurring: minute hour ' +
    'day-of-month month day-of-week) or `at` (one-shot: an ISO 8601 date-time, or "now"). Leave `tz` unset so ' +
    "the job follows the user's CURRENT timezone (it moves when they travel); set `tz` (an IANA name) only for " +
    'things pinned to a place, e.g. "6pm her time". An `at` without a UTC offset is read in that timezone. ' +
    '`mode` "inline" delivers the prompt into the current assistant conversation once it is idle; "isolated" ' +
    'runs it at once in a fresh side session (use it for long, slow or possibly urgent work). A scheduled job ' +
    'is silent: it reaches the user only if the job itself notifies them. The prompt must not start with "!".',
  promptSnippet:
    "Schedule a job (cron or one-shot `at`) that runs as the wherever assistant; jobs follow the user's timezone unless `tz` is set",
  promptGuidelines: [
    'Use assistant_schedule_add for anything time-based: reminders, recurring briefings, "check X in 30 minutes and tell me". The job runs as the assistant, not in this session, so write its prompt so it makes sense on its own.',
    'Leave tz unset on assistant_schedule_add unless the time is pinned to a place; an unset tz follows the user wherever they are.',
    'Use assistant_schedule_add with mode "isolated" (and at "now" to start immediately) for long, slow or possibly urgent work, so it never waits behind a conversation.',
  ],
};

export const ASSISTANT_SCHEDULE_LIST_TEXT: AssistantToolText = {
  name: 'assistant_schedule_list',
  label: 'Assistant: List Schedule',
  description:
    "List every job in the wherever assistant's schedule (whoever scheduled it), with its id, timing, timezone, " +
    "mode, state and last / next run. Jobs scheduled from THIS session are marked. Done one-shots and invalid " +
    "(malformed, never run) entries are listed too, as is the user's current timezone.",
  promptSnippet: "List the wherever assistant's scheduled jobs, marking the ones this session scheduled",
  promptGuidelines: [
    'Use assistant_schedule_list before changing or cancelling a job, and whenever the user asks what is scheduled.',
  ],
};

export const ASSISTANT_SCHEDULE_REMOVE_TEXT: AssistantToolText = {
  name: 'assistant_schedule_remove',
  label: 'Assistant: Remove Job',
  description:
    "Remove a job from the wherever assistant's schedule by its id (see assistant_schedule_list). To change a " +
    'job, remove it and add the new version.',
  promptSnippet: "Remove a job from the wherever assistant's schedule by id",
  promptGuidelines: [
    'Use assistant_schedule_remove to cancel a job; get its id from assistant_schedule_list first.',
  ],
};

export const ASSISTANT_SET_TIMEZONE_TEXT: AssistantToolText = {
  name: 'assistant_set_timezone',
  label: 'Assistant: Set Timezone',
  description:
    "Set the user's CURRENT timezone (an IANA name such as Europe/Paris or America/New_York). Every scheduled " +
    'job without its own `tz` follows it, so changing it moves those jobs to the new local time. Call it when ' +
    'the user says where they are or that they have travelled.',
  promptSnippet: "Set the user's current timezone (IANA name), which every job without its own tz follows",
  promptGuidelines: [
    'Use assistant_set_timezone when the user tells you where they are or that they moved to another timezone.',
  ],
};

export const ASSISTANT_NOTIFY_TEXT: AssistantToolText = {
  name: 'assistant_notify',
  label: 'Assistant: Notify',
  description:
    "Notify the user NOW through the wherever assistant's channels (a push notification on their subscribed " +
    'devices, and any other configured channel such as Telegram). It is delivered immediately, even while a ' +
    'conversation is running, and is the ONLY way to reach the user with something that is not a reply to ' +
    'their message: a scheduled job, or work in another session, is silent unless it calls this. Give a short ' +
    '`title` and a `body`. Tapping the notification opens `navigateSessionId` when given; otherwise, for a ' +
    'scheduled job (pass `jobId`, or call it from an isolated job session), the session that scheduled the ' +
    'job; otherwise this session. It fails with a clear error when no channel can deliver.',
  promptSnippet: "Notify the user immediately (push / Telegram); the only way to reach them with anything that is not a reply",
  promptGuidelines: [
    'Use assistant_notify only for things the user should know about now (a finished job, a result they asked to be told about, something urgent); never for routine chatter, and not to repeat what you are already replying.',
    'In a scheduled job, call assistant_notify with the result when the user should hear about it: a scheduled turn reaches the user ONLY through assistant_notify.',
  ],
};

/** The schedule and timezone tools' text (registered in every server session while configured). */
export const ASSISTANT_SCHEDULE_TOOL_TEXTS: readonly AssistantToolText[] = [
  ASSISTANT_SCHEDULE_ADD_TEXT,
  ASSISTANT_SCHEDULE_LIST_TEXT,
  ASSISTANT_SCHEDULE_REMOVE_TEXT,
  ASSISTANT_SET_TIMEZONE_TEXT,
];

/**
 * Every assistant tool's text, in registration order (the schedule tools, then
 * `assistant_notify`, which a server session gets only while the assistant is
 * ACTIVE: see assistant-tools.ts).
 */
export const ASSISTANT_TOOL_TEXTS: readonly AssistantToolText[] = [...ASSISTANT_SCHEDULE_TOOL_TEXTS, ASSISTANT_NOTIFY_TEXT];

/** The line appended to the system prompt of every turn in the assistant folder (and `jobs/`). */
export function timezoneLine(timezone: string): string {
  return `User's current timezone: ${timezone}`;
}
