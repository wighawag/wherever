/**
 * The CLI-bridge TWINS of the wherever assistant's five `assistant_*` tools, and
 * the CLI timezone line (ADR 0016, spec `assistant-session-and-channels`).
 *
 * - Every twin is registered with `defaultActive: false`, so a terminal pi
 *   session whose wherever has no active assistant (or that never reaches a
 *   wherever server at all) has exactly the tools and system prompt it had
 *   before: pi only declares ACTIVE tools to the model and only adds their
 *   snippets and guidelines to the prompt. The extension activates them with
 *   `setActiveTools` once the cached `assistant_info` (./bridge-requests.ts)
 *   says configured, and deactivates them on any other state (see
 *   `syncTwinActivation` for why "any other").
 * - Each twin's `execute` CALLS the server (`cli_request`, op in
 *   `ASSISTANT_TWIN_OPS`) and returns its result. The server runs the same op
 *   code as its own tools (server/src/assistant-tools.ts) and stamps the calling
 *   session from the bridge registration, so nothing about the caller is sent.
 * - The text (name, label, description, `promptSnippet`, `promptGuidelines`) and
 *   the parameter schemas are COPIES of the server's (server/src/assistant-tool-text.ts,
 *   server/src/assistant-tools.ts): this package is published on its own and
 *   cannot import the server. `server/test/assistant-tool-twins.test.ts` fails
 *   on any drift.
 *
 * Kept free of pi runtime and `ws` imports (types only), so it is testable with
 * a fake request function and importable by that server drift test.
 */

import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantInfo, BridgeRequestResult } from "./bridge-requests.js";

export interface AssistantToolText {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

// KEEP IN LOCKSTEP with server/src/assistant-tool-text.ts (drift test above).

export const ASSISTANT_SCHEDULE_ADD_TEXT: AssistantToolText = {
  name: "assistant_schedule_add",
  label: "Assistant: Schedule",
  description:
    "Schedule a job for the wherever assistant. Every job belongs to the assistant and RUNS AS the assistant, " +
    "in its own folder, whichever session schedules it: this session is recorded only as the origin (context " +
    "the job receives), never as where it runs. Give exactly one of `cron` (5-field, recurring: minute hour " +
    'day-of-month month day-of-week) or `at` (one-shot: an ISO 8601 date-time, or "now"). Leave `tz` unset so ' +
    "the job follows the user's CURRENT timezone (it moves when they travel); set `tz` (an IANA name) only for " +
    'things pinned to a place, e.g. "6pm her time". An `at` without a UTC offset is read in that timezone. ' +
    '`mode` "inline" delivers the prompt into the current assistant conversation once it is idle; "isolated" ' +
    "runs it at once in a fresh side session (use it for long, slow or possibly urgent work). A scheduled job " +
    'is silent: it reaches the user only if the job itself notifies them. The prompt must not start with "!".',
  promptSnippet:
    "Schedule a job (cron or one-shot `at`) that runs as the wherever assistant; jobs follow the user's timezone unless `tz` is set",
  promptGuidelines: [
    'Use assistant_schedule_add for anything time-based: reminders, recurring briefings, "check X in 30 minutes and tell me". The job runs as the assistant, not in this session, so write its prompt so it makes sense on its own.',
    "Leave tz unset on assistant_schedule_add unless the time is pinned to a place; an unset tz follows the user wherever they are.",
    'Use assistant_schedule_add with mode "isolated" (and at "now" to start immediately) for long, slow or possibly urgent work, so it never waits behind a conversation.',
  ],
};

export const ASSISTANT_SCHEDULE_LIST_TEXT: AssistantToolText = {
  name: "assistant_schedule_list",
  label: "Assistant: List Schedule",
  description:
    "List every job in the wherever assistant's schedule (whoever scheduled it), with its id, timing, timezone, " +
    "mode, state and last / next run. Jobs scheduled from THIS session are marked. Done one-shots and invalid " +
    "(malformed, never run) entries are listed too, as is the user's current timezone.",
  promptSnippet: "List the wherever assistant's scheduled jobs, marking the ones this session scheduled",
  promptGuidelines: [
    "Use assistant_schedule_list before changing or cancelling a job, and whenever the user asks what is scheduled.",
  ],
};

export const ASSISTANT_SCHEDULE_REMOVE_TEXT: AssistantToolText = {
  name: "assistant_schedule_remove",
  label: "Assistant: Remove Job",
  description:
    "Remove a job from the wherever assistant's schedule by its id (see assistant_schedule_list). To change a " +
    "job, remove it and add the new version.",
  promptSnippet: "Remove a job from the wherever assistant's schedule by id",
  promptGuidelines: ["Use assistant_schedule_remove to cancel a job; get its id from assistant_schedule_list first."],
};

export const ASSISTANT_SET_TIMEZONE_TEXT: AssistantToolText = {
  name: "assistant_set_timezone",
  label: "Assistant: Set Timezone",
  description:
    "Set the user's CURRENT timezone (an IANA name such as Europe/Paris or America/New_York). Every scheduled " +
    "job without its own `tz` follows it, so changing it moves those jobs to the new local time. Call it when " +
    "the user says where they are or that they have travelled.",
  promptSnippet: "Set the user's current timezone (IANA name), which every job without its own tz follows",
  promptGuidelines: [
    "Use assistant_set_timezone when the user tells you where they are or that they moved to another timezone.",
  ],
};

export const ASSISTANT_NOTIFY_TEXT: AssistantToolText = {
  name: "assistant_notify",
  label: "Assistant: Notify",
  description:
    "Notify the user NOW through the wherever assistant's channels (a push notification on their subscribed " +
    "devices, and any other configured channel such as Telegram). It is delivered immediately, even while a " +
    "conversation is running, and is the ONLY way to reach the user with something that is not a reply to " +
    "their message: a scheduled job, or work in another session, is silent unless it calls this. Give a short " +
    "`title` and a `body`. Tapping the notification opens `navigateSessionId` when given; otherwise, for a " +
    "scheduled job (pass `jobId`, or call it from an isolated job session), the session that scheduled the " +
    "job; otherwise this session. It fails with a clear error when no channel can deliver.",
  promptSnippet: "Notify the user immediately (push / Telegram); the only way to reach them with anything that is not a reply",
  promptGuidelines: [
    "Use assistant_notify only for things the user should know about now (a finished job, a result they asked to be told about, something urgent); never for routine chatter, and not to repeat what you are already replying.",
    "In a scheduled job, call assistant_notify with the result when the user should hear about it: a scheduled turn reaches the user ONLY through assistant_notify.",
  ],
};

/** Every twin's text, in the server's registration order. */
export const ASSISTANT_TOOL_TWIN_TEXTS: readonly AssistantToolText[] = [
  ASSISTANT_SCHEDULE_ADD_TEXT,
  ASSISTANT_SCHEDULE_LIST_TEXT,
  ASSISTANT_SCHEDULE_REMOVE_TEXT,
  ASSISTANT_SET_TIMEZONE_TEXT,
  ASSISTANT_NOTIFY_TEXT,
];

/** The names of the five twins (the set `syncTwinActivation` adds or removes). */
export const ASSISTANT_TOOL_TWIN_NAMES: readonly string[] = ASSISTANT_TOOL_TWIN_TEXTS.map((t) => t.name);

/** The `cli_request` op each twin calls (server/src/cli-requests.ts registers the same names). */
export const ASSISTANT_TWIN_OPS: Readonly<Record<string, string>> = {
  assistant_schedule_add: "schedule_add",
  assistant_schedule_list: "schedule_list",
  assistant_schedule_remove: "schedule_remove",
  assistant_set_timezone: "set_timezone",
  assistant_notify: "notify",
};

/**
 * The parameter schemas, KEPT IN LOCKSTEP with `createAssistantTools` /
 * `createNotifyTool` in server/src/assistant-tools.ts (the drift test compares them).
 */
export const ASSISTANT_TWIN_PARAMETERS = {
  assistant_schedule_add: Type.Object({
    name: Type.String({ description: "Short human name for the job (shown in listings and in the scheduled turn)." }),
    prompt: Type.String({
      description:
        'What the assistant should do when the job fires, written to make sense on its own. A prompt starting with "/" runs that command or skill.',
    }),
    mode: Type.Union([Type.Literal("inline"), Type.Literal("isolated")], {
      description: '"inline": into the current assistant conversation once it is idle. "isolated": at once, in a fresh side session.',
    }),
    cron: Type.Optional(
      Type.String({ description: '5-field cron for a recurring job, e.g. "0 8 * * *" (every day at 08:00). Exactly one of cron / at.' }),
    ),
    at: Type.Optional(
      Type.String({ description: 'One-shot time: ISO 8601 date-time (e.g. "2026-11-06T17:30"), or "now". Exactly one of cron / at.' }),
    ),
    tz: Type.Optional(
      Type.String({ description: "IANA timezone to PIN the job to. Omit to follow the user's current timezone (the usual case)." }),
    ),
  }),
  assistant_schedule_list: Type.Object({}),
  assistant_schedule_remove: Type.Object({
    id: Type.String({ description: "The id of the job to remove (from assistant_schedule_list)." }),
  }),
  assistant_set_timezone: Type.Object({
    timezone: Type.String({ description: 'IANA timezone name, e.g. "Europe/Paris" or "America/New_York".' }),
  }),
  assistant_notify: Type.Object({
    title: Type.String({ description: 'Short headline, e.g. "Deploy finished" or "CI is red".' }),
    body: Type.String({ description: "The message itself: one or two sentences the user can act on." }),
    navigateSessionId: Type.Optional(Type.String({ description: "The session id a tap should open (default: see the description)." })),
    jobId: Type.Optional(Type.String({ description: "The scheduled job this is about; a tap then opens the session that scheduled it." })),
  }),
} as const;

/**
 * Per-request timeout for the twins' ops. Longer than the 10 s default
 * (`assistant_info`), because these do real work on the server: a
 * `schedule.json` write behind the scheduler's queue, or `assistant_notify`'s
 * delivery to every push service. Unref'd like every bridge timer. Decision
 * recorded in work/notes/observations/cli-assistant-tool-twins-decisions.md.
 */
export const ASSISTANT_TWIN_REQUEST_TIMEOUT_MS = 30_000;

/** How a twin reaches the server (the request client's `request`, faked in tests). */
export type TwinRequest = (op: string, args: unknown, opts?: { timeoutMs?: number }) => Promise<BridgeRequestResult>;

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean };

/** The successful `cli_response` result of a twin op (server/src/cli-requests.ts). */
interface TwinOpWire {
  text?: unknown;
  details?: unknown;
}

/** Turn a bridge answer into the tool result, mirroring the server tools' `toResult` shape. */
export function twinResult(name: string, res: BridgeRequestResult): ToolResult {
  if (res.ok) {
    const w = (res.result ?? {}) as TwinOpWire;
    const text = typeof w.text === "string" ? w.text : "Done.";
    return { content: [{ type: "text", text }], details: w.details };
  }
  const why =
    res.reason === "disconnected"
      ? `${res.error} The wherever assistant is reached through the wherever server, so this cannot run until the bridge reconnects.`
      : res.error;
  return { content: [{ type: "text", text: `${name}: ${why}` }], details: undefined, isError: true };
}

/** The five twins, every one registered INACTIVE (`defaultActive: false`, ADR 0016). */
export function createAssistantToolTwins(request: TwinRequest): ToolDefinition[] {
  return ASSISTANT_TOOL_TWIN_TEXTS.map((text) => {
    const op = ASSISTANT_TWIN_OPS[text.name]!;
    return {
      name: text.name,
      label: text.label,
      description: text.description,
      promptSnippet: text.promptSnippet,
      promptGuidelines: [...text.promptGuidelines],
      parameters: ASSISTANT_TWIN_PARAMETERS[text.name as keyof typeof ASSISTANT_TWIN_PARAMETERS],
      defaultActive: false,
      async execute(_toolCallId: string, params: unknown) {
        let res: BridgeRequestResult;
        try {
          res = await request(op, params ?? {}, { timeoutMs: ASSISTANT_TWIN_REQUEST_TIMEOUT_MS });
        } catch (err) {
          res = { ok: false, reason: "disconnected", error: err instanceof Error ? err.message : String(err) };
        }
        return twinResult(text.name, res);
      },
    } as unknown as ToolDefinition;
  });
}

/** The slice of pi's API the activation needs. */
export type ActiveToolsApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

/**
 * Make the twins' activation match `info`: active exactly while it is
 * `configured`. Any other state DEACTIVATES them, not only a "not configured"
 * push: pi restores a resumed session's recorded tool loadout from its
 * transcript, so twins activated in an earlier run would otherwise come back
 * active in a run whose server says no (or that has no server at all), which
 * breaks "a disabled assistant leaves the session exactly as today". The cache
 * keeps the last server answer across a disconnect, so a live session does not
 * lose its twins on a socket drop (they fail at call time instead).
 *
 * Calls `setActiveTools` only when something changes, and never throws (an
 * unbound or stale pi API is ignored). Returns whether it changed the set.
 */
export function syncTwinActivation(pi: Partial<ActiveToolsApi>, info: AssistantInfo): boolean {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return false;
  try {
    const current = pi.getActiveTools();
    const want = info.state === "configured";
    const twins = new Set(ASSISTANT_TOOL_TWIN_NAMES);
    if (want) {
      const missing = ASSISTANT_TOOL_TWIN_NAMES.filter((n) => !current.includes(n));
      if (missing.length === 0) return false;
      pi.setActiveTools([...current, ...missing]);
      return true;
    }
    if (!current.some((n) => twins.has(n))) return false;
    pi.setActiveTools(current.filter((n) => !twins.has(n)));
    return true;
  } catch {
    return false;
  }
}

/** True when `cwd` is the assistant folder itself or its `jobs/` (path.resolve equality, like the server). */
export function isAssistantFolderCwd(cwd: string, folder: string): boolean {
  const c = path.resolve(cwd);
  const f = path.resolve(folder);
  return c === f || c === path.join(f, "jobs");
}

/** KEEP IN LOCKSTEP with `timezoneLine` in server/src/assistant-tool-text.ts. */
export function timezoneLine(timezone: string): string {
  return `User's current timezone: ${timezone}`;
}

/**
 * The CLI timezone line for a turn in `cwd`, from the CACHED `assistant_info`
 * only (never the network): null unless the assistant is configured with a
 * known timezone AND `cwd` is the assistant folder or its `jobs/`.
 */
export function cliTimezoneLine(info: AssistantInfo, cwd: string | undefined): string | null {
  if (info.state !== "configured" || !info.timezone || !cwd) return null;
  if (!isAssistantFolderCwd(cwd, info.assistantFolder)) return null;
  return timezoneLine(info.timezone);
}

/** Append the line to the prompt the event carries (never replacing it), as the server's inline extension does. */
export function appendTimezoneLine(systemPrompt: string, line: string): string {
  return `${systemPrompt}\n\n${line}`;
}
