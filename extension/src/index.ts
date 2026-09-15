/**
 * CLI Bridge Extension for Wherever
 *
 * Connects the local pi CLI session as a client to the Standalone Wherever Server.
 * Streams all terminal activity to the server in real-time, and receives remote
 * commands to execute in the local agent loop.
 *
 * Features exponential backoff reconnection to automatically pair whenever the
 * Standalone Server starts or stops.
 *
 * Usage:
 *   pi --extension ./extension/dist/index.js --remote-port 31415 --remote-token YOUR_TOKEN
 */

import WebSocket from "ws";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { WhereverClient } from "@wherever-dev/client";
import { createConversationModeSignal } from "./conversation-mode-hint.js";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

// Minimal shapes for tool-call/tool-result detection. The coding-agent package
// does not re-export AgentMessage/ToolCall, so we narrow structurally instead of
// importing them. Only the fields we read are described here.
type ToolCallContent = { type: "toolCall"; id: string; name: string };
type AssistantLikeMessage = {
  role: "assistant";
  content?: Array<{ type?: string; id?: string; name?: string }>;
};
type ToolResultLikeMessage = { role: "toolResult"; toolCallId?: string };

/** A tool call that was issued by the assistant but has no matching toolResult. */
interface DanglingToolCall {
  id: string;
  name: string;
}

/**
 * Walk the ACTIVE branch (leaf -> root, like buildSessionContext) of the loaded
 * session and return tool calls from the last assistant turn(s) that have no
 * matching toolResult. A non-empty result means the transcript was persisted
 * mid-tool-call: typically another process (the web frontend / standalone
 * server) is still running that tool, or the run was interrupted. pi cannot
 * auto-continue from a trailing unsatisfied tool call (the agent loop requires
 * the last context message to be a user/toolResult), so on resume the CLI sits
 * idle as if the turn were done. Detecting this lets us surface it instead.
 */
function findDanglingToolCalls(ctx: ExtensionContext): DanglingToolCall[] {
  let entries: SessionEntry[];
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return [];
  }
  if (!entries || entries.length === 0) return [];

  // Index by id and walk the active branch from the leaf to the root, mirroring
  // buildSessionContext() so we only consider messages actually in context.
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  let leafId: string | null | undefined;
  try {
    leafId = ctx.sessionManager.getLeafId();
  } catch {
    leafId = undefined;
  }

  let leaf: SessionEntry | undefined;
  if (leafId === null) return []; // navigated before first entry: no context
  if (leafId) leaf = byId.get(leafId);
  if (!leaf) leaf = entries[entries.length - 1];
  if (!leaf) return [];

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  // Only the TRAILING run matters. pi can auto-continue unless the LAST context
  // message is an unsatisfied tool call, so a dangling tool call from an EARLIER
  // turn (before the most recent user message) is already superseded and does
  // not block anything. Reporting those would over-count (e.g. "4 tool calls"
  // when 3 are from previous, resolved-by-a-human-turn segments). So restrict
  // the scan to entries AFTER the last user message on the active branch.
  let lastUserIdx = -1;
  for (let i = 0; i < path.length; i++) {
    const entry = path[i];
    if (entry.type !== "message") continue;
    const role = ((entry as SessionMessageEntry).message as { role?: string })?.role;
    if (role === "user") lastUserIdx = i;
  }
  const trailing = path.slice(lastUserIdx + 1);

  // Within the trailing segment, collect satisfied tool-call ids (those with a
  // matching toolResult) and the tool calls issued.
  const satisfied = new Set<string>();
  const issued: DanglingToolCall[] = [];
  for (const entry of trailing) {
    if (entry.type !== "message") continue;
    const message = (entry as SessionMessageEntry).message as unknown;
    const role = (message as { role?: string })?.role;
    if (role === "toolResult") {
      const tcId = (message as ToolResultLikeMessage).toolCallId;
      if (tcId) satisfied.add(tcId);
    } else if (role === "assistant") {
      const content = (message as AssistantLikeMessage).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && part.type === "toolCall" && typeof part.id === "string") {
          const tc = part as ToolCallContent;
          issued.push({ id: tc.id, name: tc.name || "tool" });
        }
      }
    }
  }

  return issued.filter((tc) => !satisfied.has(tc.id));
}

export default async function (pi: ExtensionAPI) {
  // Register flags to specify Standalone Server settings.
  //
  // NO `default:` on the settings that are also configurable, deliberately. A
  // registered default is indistinguishable from the user typing that same
  // value, so `getFlag` would always return something truthy and the config
  // file could never win. The defaults are applied at the point of use instead
  // (see connect()), which is what makes the documented precedence -- explicit
  // flag > config > built-in default -- actually hold. They stay in the help
  // text so `--help` still tells you what you get.
  pi.registerFlag("remote-port", {
    description: "Port of the remote standalone server (default 31415, or `remote.port` in config.json)",
    type: "string",
  });

  pi.registerFlag("remote-host", {
    description: "Host of the remote standalone server (default 127.0.0.1, or `remote.host` in config.json)",
    type: "string",
  });

  pi.registerFlag("remote-token", {
    description: "Authentication token for the remote standalone server (or `remote.token` in config.json)",
    type: "string",
  });

  pi.registerFlag("remote-bridge", {
    description: "Whether to connect to the remote standalone server as a bridge",
    type: "boolean",
    default: true,
  });

  pi.registerFlag("remote-secure", {
    description: "Whether to connect to the remote standalone server using SSL (WSS)",
    type: "boolean",
    default: true,
  });

  // Explicit opt-out for a plain-ws server. `remote-secure` defaults to true
  // and pi boolean flags cannot be forced false on the command line, so a
  // server started with `--no-ssl` (e.g. bound to loopback behind a reverse
  // proxy that terminates TLS) was unreachable from the bridge. Passing
  // `--remote-insecure` forces a plain `ws://` connection.
  //
  // `remote.insecure` in config.json does the same thing persistently, which is
  // what a reverse-proxied deployment actually wants: the flag alone meant every
  // `pi` invocation had to remember it, and a human who forgot got a bridge that
  // failed the TLS handshake with nothing explaining why. Because a pi boolean
  // cannot be passed as false, the config value can only be undone by editing
  // the config, not by a flag; that asymmetry is inherent to the flag system and
  // is documented on the config field rather than worked around with a second
  // negating flag.
  pi.registerFlag("remote-insecure", {
    description:
      "Connect to the standalone server over plain ws:// (no TLS). Use when the " +
      "server runs with --no-ssl, e.g. bound to localhost behind a reverse proxy " +
      "(Caddy/nginx) that terminates HTTPS. Overrides --remote-secure. Can also be " +
      "set persistently as `remote.insecure` in config.json.",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("remote-beep", {
    description:
      "Play an inviting sound when the agent finishes and is waiting for your next message. " +
      "Sets the DEFAULT for new sessions (can also be enabled via `beep.enabled` in " +
      "~/.wherever/config.json); toggle it per-session with /remote-beep.",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("remote-beep-command", {
    description:
      "Shell command to run for the waiting-for-human sound instead of the terminal bell. " +
      "Overrides `beep.command` in ~/.wherever/config.json and the auto-detected player. " +
      "Useful when the terminal bell is silent (e.g. WezTerm on Linux). " +
      "Example: 'pw-play /usr/share/sounds/freedesktop/stereo/complete.oga'.",
    type: "string",
  });

  pi.registerCommand("remote-reconnect", {
    description: "Manually reconnect to the standalone remote server",
    handler: async (args: string, ctx: any) => {
      if (client && client.getIsConnected()) {
        ctx.ui.notify("[Wherever] Already connected to standalone server", "info");
        return;
      }
      ctx.ui.notify("[Wherever] Initiating manual reconnect...", "info");
      connect();
    },
  });

  // Per-session override for the waiting-for-human beep. Undefined means "follow
  // the configured default"; true/false is an explicit per-session choice made
  // via /remote-beep. Reset on each session start so a new session begins from
  // the configured default again.
  let beepOverride: boolean | undefined = undefined;

  // The default beep behaviour for new sessions is enabled when EITHER the
  // --remote-beep flag is set OR `beep.enabled` is true in ~/.wherever/config.json.
  // The flag can only force-on (its own default is false), so the config file is
  // the way to enable-by-default across every session without passing the flag.
  function beepDefault(): boolean {
    if (pi.getFlag("remote-beep") === true) return true;
    return readBeepConfig()?.enabled === true;
  }

  function beepEnabled(): boolean {
    return beepOverride === undefined ? beepDefault() : beepOverride;
  }

  // Read the shared wherever config once and cache it. Best-effort: a missing,
  // unreadable or invalid file yields `{}` so every caller can just read the
  // section it wants. The extension is a separate package from the server, so it
  // reads the shared file directly rather than importing the server's loader.
  //
  // WHEREVER_CONFIG_DIR is honoured for the same reason the server honours it
  // (see getWhereverConfigDir in server/src/session-pool.ts): without it an
  // isolated harness relocates the server's config but the extension keeps
  // reading the developer's real ~/.wherever/config.json, which is exactly the
  // cross-talk that variable exists to prevent. The fallback is unchanged, so
  // an ordinary install reads the same path it always did.
  let cachedConfig: Record<string, unknown> | undefined = undefined;
  function readWhereverConfig(): Record<string, unknown> {
    if (cachedConfig !== undefined) return cachedConfig;
    cachedConfig = {};
    try {
      const override = process.env.WHEREVER_CONFIG_DIR;
      const configDir =
        override && override.trim() ? path.resolve(override.trim()) : path.join(os.homedir(), ".wherever");
      const raw = fs.readFileSync(path.join(configDir, "config.json"), "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cachedConfig = parsed as Record<string, unknown>;
    } catch (err) {
      // No config / unreadable / invalid JSON: built-in defaults apply.
    }
    return cachedConfig;
  }

  function readConfigSection<T>(name: string): T | undefined {
    const section = readWhereverConfig()[name];
    if (section && typeof section === "object") return section as T;
    return undefined;
  }

  function readBeepConfig(): { enabled?: boolean; command?: string } | undefined {
    return readConfigSection<{ enabled?: boolean; command?: string }>("beep");
  }

  // Connection settings for this bridge, so a deployment that is not on the
  // defaults does not have to repeat flags on every `pi` invocation. See the
  // `remote` section of WhereverConfig for the full rationale.
  function readRemoteConfig():
    | { host?: string; port?: number | string; token?: string; insecure?: boolean; bridge?: boolean }
    | undefined {
    return readConfigSection("remote");
  }

  // Auto-detected sound command, computed once. `undefined` means "not computed
  // yet"; `null` means "computed, nothing available" (so we do not re-probe).
  let autoDetectedBeepCommand: string | null | undefined = undefined;

  // Best guess at a "play this sound file" command available on the system, used
  // when neither the flag nor config sets one. Picks the first available player
  // and a pleasant freedesktop chime. Returns null when nothing suitable exists
  // (then we fall back to the terminal bell).
  function detectBeepCommand(): string | null {
    if (autoDetectedBeepCommand !== undefined) return autoDetectedBeepCommand;

    const has = (bin: string): boolean => {
      try {
        const probe = process.platform === "win32"
          ? spawnSync("where", [bin], { stdio: "ignore" })
          : spawnSync("command", ["-v", bin], { stdio: "ignore", shell: "bash" });
        return probe.status === 0;
      } catch {
        return false;
      }
    };
    const fileExists = (p: string): boolean => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    };

    // macOS: afplay + a built-in system sound.
    if (process.platform === "darwin" && has("afplay")) {
      const sound = "/System/Library/Sounds/Glass.aiff";
      autoDetectedBeepCommand = fileExists(sound) ? `afplay ${sound}` : "afplay /System/Library/Sounds/Ping.aiff";
      return autoDetectedBeepCommand;
    }

    // Linux/BSD: a freedesktop chime through whichever player is present.
    const soundCandidates = [
      "/usr/share/sounds/freedesktop/stereo/complete.oga",
      "/usr/share/sounds/freedesktop/stereo/bell.oga",
      "/usr/share/sounds/freedesktop/stereo/message.oga",
    ];
    const sound = soundCandidates.find(fileExists);
    if (sound) {
      // Prefer PipeWire, then PulseAudio, then canberra, then ffplay.
      if (has("pw-play")) { autoDetectedBeepCommand = `pw-play ${sound}`; return autoDetectedBeepCommand; }
      if (has("paplay")) { autoDetectedBeepCommand = `paplay ${sound}`; return autoDetectedBeepCommand; }
      if (has("canberra-gtk-play")) { autoDetectedBeepCommand = `canberra-gtk-play -f ${sound}`; return autoDetectedBeepCommand; }
      if (has("ffplay")) { autoDetectedBeepCommand = `ffplay -nodisp -autoexit -loglevel quiet ${sound}`; return autoDetectedBeepCommand; }
    }

    autoDetectedBeepCommand = null;
    return autoDetectedBeepCommand;
  }

  // Resolve the sound command to run, highest precedence first:
  //   1. --remote-beep-command flag
  //   2. `beep.command` in ~/.wherever/config.json
  //   3. an auto-detected player + system chime
  // Returns undefined when none apply (then the terminal bell is used).
  function resolveBeepCommand(): string | undefined {
    const flag = (pi.getFlag("remote-beep-command") as string | undefined)?.trim();
    if (flag) return flag;
    const configured = readBeepConfig()?.command?.trim();
    if (configured) return configured;
    const detected = detectBeepCommand();
    return detected || undefined;
  }

  // Emit an inviting waiting-for-human sound. Best-effort: never throw into the
  // agent loop.
  //
  // Two delivery paths:
  //   1. A sound COMMAND (flag / config / auto-detected): run it to play a real
  //      audio file (e.g. `pw-play .../complete.oga`). This is the reliable path
  //      when the terminal bell is silent (WezTerm on Linux defaults to
  //      SystemBeep, which is often a no-op without a PC speaker).
  //   2. Fallback terminal BEL (\x07), written to the controlling terminal
  //      (/dev/tty) rather than process.stdout, because pi's TUI owns stdout and
  //      its render loop can swallow an out-of-band byte. Falls back to
  //      process.stdout when /dev/tty is unavailable (e.g. no controlling tty).
  function playBeep() {
    const command = resolveBeepCommand();
    if (command) {
      try {
        const shell = process.platform === "win32" ? "cmd.exe" : "bash";
        const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];
        const child = spawn(shell, shellArgs, { stdio: "ignore", detached: false });
        // Never let a failing sound command surface as an unhandled error.
        child.on("error", () => {});
        return;
      } catch (err) {
        // Fall through to the terminal bell on spawn failure.
      }
    }

    // Terminal bell. Prefer /dev/tty so the TUI renderer does not absorb it.
    try {
      const fd = fs.openSync("/dev/tty", "w");
      try {
        fs.writeSync(fd, "\x07");
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (err) {
      // No controlling tty (or platform without /dev/tty): fall back to stdout.
    }
    try {
      process.stdout.write("\x07");
    } catch (err) {
      // Quiet fail: a closed/redirected stdout must not break the session.
    }
  }

  pi.registerCommand("remote-beep", {
    description:
      "Toggle the waiting-for-human beep for THIS session (on/off). Run with no argument to toggle, " +
      "or pass on/off. The --remote-beep flag sets the default for new sessions.",
    handler: async (args: string, ctx: any) => {
      const arg = (args || "").trim().toLowerCase();
      let next: boolean;
      if (arg === "on" || arg === "true" || arg === "1" || arg === "enable") {
        next = true;
      } else if (arg === "off" || arg === "false" || arg === "0" || arg === "disable") {
        next = false;
      } else {
        // No/unknown arg: toggle from the current effective state.
        next = !beepEnabled();
      }
      beepOverride = next;
      if (next) {
        // Sample the chosen sound so the user hears what to expect.
        playBeep();
        ctx.ui.notify("[Wherever] Waiting-for-human beep ENABLED for this session 🔔", "info");
      } else {
        ctx.ui.notify("[Wherever] Waiting-for-human beep DISABLED for this session", "info");
      }
    },
  });

  let client: WhereverClient | null = null;
  let sessionFile: string | null = null;
  let ctxVal: ExtensionContext | null = null;
  // True while this session's resume showed the dangling-tool-call warning (from
  // the persisted transcript). Lets the server-driven cli_takeover_interrupted
  // notice avoid double-warning for the tool-call case (which the CLI's own
  // heuristic already covers, with tool names); the server notice is still the
  // ONLY signal for the streaming-text case.
  let resumeDanglingShown = false;

  function updateCliWidget(status: 'disconnected' | 'connecting' | 'connected') {
    if (!ctxVal) return;

    try {
      if (status === 'connecting') {
        ctxVal.ui.setWidget("wherever-status", (_tui, theme) => {
          const line = theme.fg("muted", "🔌 [Wherever] Connecting to standalone remote server...");
          return {
            render: () => [line],
            invalidate: () => {},
          };
        });
      } else if (status === 'disconnected') {
        ctxVal.ui.setWidget("wherever-status", (_tui, theme) => {
          const line = theme.fg("error", "⚠️ [Wherever] Disconnected from standalone remote server");
          return {
            render: () => [line],
            invalidate: () => {},
          };
        });
      } else {
        ctxVal.ui.setWidget("wherever-status", undefined);
      }
    } catch (err) {
      // Quiet fail if context is stale or disposed
    }
  }

  function sendCliEvent(event: any) {
    if (!client || !client.getIsConnected() || !sessionFile) return;
    try {
      client.send({
        type: "cli_event",
        sessionFile,
        event,
      });
    } catch (err) {
      // Quiet fail if connection dropped suddenly during a send
    }
  }

  // Let the agent attach a file it produced (a generated PDF, an export, a note)
  // to the remote conversation so a phone/browser client can download it with a
  // tap. This is a SELF-CONTAINED tool (like `read`): it just validates the path
  // and returns a normal tool result carrying that path. It does NOT depend on
  // the bridge, does NOT read the file bytes, and emits no side-channel marker.
  // The download affordance is driven entirely by the tool CALL: every client
  // (web frontend included) already receives tool_start/tool_end for this call,
  // and the web UI recognizes the `attach_file` tool name and renders a download
  // button from its `path` argument, hitting GET /session/download. This is why
  // it works identically in a CLI-bridge session and a pure server-side session.
  pi.registerTool({
    name: "attach_file",
    label: "Attach File",
    description:
      "Attach a file to the conversation so the person on the other end (e.g. a " +
      "phone/browser) can download it with one tap. The user is remote and CANNOT " +
      "reach the local filesystem, so a file path in your reply is NOT enough: they " +
      "can only obtain a file if you attach it with this tool. Pass the path to a " +
      "real, existing file inside the working directory (or an absolute path the " +
      "server is allowed to serve). Use this both right after generating a " +
      "deliverable (a PDF, an export, a report) AND whenever the user asks for a " +
      "file by name or type, including one created earlier in the conversation, " +
      "e.g. 'give me the gpx', 'send me the pdf', 'download the report', 'can I " +
      "have that file'. Resolve which file they mean from the conversation and " +
      "attach it; if truly ambiguous, ask which file, otherwise attach the most " +
      "likely match rather than only printing its path.",
    promptSnippet: "Attach a file to the conversation so the remote user can download it",
    promptGuidelines: [
      "Use attach_file whenever the user asks you to give/send/download/share a file, or asks for a file by name or type (e.g. 'give me the gpx', 'send the pdf'), including files created earlier in the conversation: the user is remote and can only download a file you attach, so never answer such a request with just a file path.",
      "Use attach_file right after generating a downloadable deliverable (PDF, export, archive) so the remote user can retrieve it without asking.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "Path to the file to attach. Relative paths resolve against the working directory.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rawPath = String((params as { path?: string }).path || "").trim();
      if (!rawPath) {
        return {
          content: [{ type: "text", text: "attach_file: no path provided." }],
          details: undefined,
          isError: true,
        };
      }

      const cwd = ctx.cwd || process.cwd();
      let resolved = rawPath;
      if (resolved.startsWith("~")) {
        resolved = path.join(os.homedir(), resolved.slice(1));
      } else if (!path.isAbsolute(resolved)) {
        resolved = path.resolve(cwd, resolved);
      } else {
        resolved = path.resolve(resolved);
      }

      let size: number | null = null;
      try {
        const st = fs.statSync(resolved);
        if (!st.isFile()) {
          return {
            content: [
              { type: "text", text: `attach_file: not a regular file: ${resolved}` },
            ],
            details: undefined,
            isError: true,
          };
        }
        size = st.size;
      } catch {
        return {
          content: [
            { type: "text", text: `attach_file: file not found: ${resolved}` },
          ],
          details: undefined,
          isError: true,
        };
      }

      const filename = path.basename(resolved);
      // Success. The download button is driven by the tool CALL (the web UI reads
      // the `path` arg), so we just confirm and echo the resolved path back to
      // the model. No bridge, no marker: works in any session type.
      return {
        content: [
          {
            type: "text",
            text:
              `Attached "${filename}" (${size} bytes) to the conversation. ` +
              `A download button is now shown to the user for: ${resolved}`,
          },
        ],
        details: { path: resolved, filename, size },
      };
    },
  });

  // Whether the turn started by the NEXT relayed user message should carry the
  // conversation-mode hint (see ./conversation-mode-hint.ts, kept in lockstep with
  // the server's twin). Armed from every `cli_message`, consumed by the
  // before_agent_start handler below (which also opens the spoken turn the
  // `context` handler adds its tail reminder to), and closed on agent_end.
  const conversationSignal = createConversationModeSignal();

  // Let the agent emit a SHORT spoken-form reply the web UI can speak aloud and
  // surface. Like `attach_file`, this is a SELF-CONTAINED tool: it just validates
  // its `text` argument and returns a
  // normal tool result carrying that text in `details`. It reads NO files,
  // depends on NO bridge, and emits no side-channel marker. The spoken-reply
  // affordance is driven entirely by the tool CALL: every client (web frontend
  // included) already receives tool_start/tool_end for this call, and the web UI
  // recognizes the `say` tool name, surfaces the spoken text, and speaks it via
  // the browser SpeechSynthesis API. This is why it works identically in a
  // CLI-bridge session and a pure server-side session, with NO new WS message
  // type and NO new chat role.
  //
  // The TEXT below owns HOW to use `say`; the per-turn conversation-mode hint
  // (./conversation-mode-hint.ts, ADR 0004) owns WHETHER, so there is no standing
  // "a spoken conversation is active" condition for the agent to judge for itself.
  // KEEP IN LOCKSTEP with the server twin, `server/src/say-tool.ts`;
  // `server/test/say-tool.test.ts` parses this block and fails on drift.
  pi.registerTool({
    name: "say",
    label: "Say",
    description:
      "Emit a SHORT spoken-form reply that the web UI speaks aloud and surfaces. " +
      "WHETHER to speak is never your own judgement: call `say` ONLY when the " +
      "instructions for THIS turn explicitly state that a spoken conversation is " +
      "active. That explicit instruction is the only signal there is; do not infer " +
      "a spoken conversation from the phrasing of the message, from how chatty the " +
      "exchange feels, or from an earlier turn. Absent that explicit per-turn " +
      "instruction, never call `say` at all. When you ARE told to speak, use `say` " +
      "only IN ADDITION to your normal written answer, never instead of it: the " +
      "full detail stays in the written message, and `say` is just the concise " +
      "version the human hears and can sanity-check against the full reply. Keep " +
      "it to one or two sentences of natural, plain spoken language (no code, no " +
      "markdown, no lists).",
    promptSnippet:
      "Emit a short spoken-form reply the web UI speaks aloud, in addition to your written answer, ONLY when the instructions for this turn explicitly say a spoken conversation is active",
    promptGuidelines: [
      "Only call say when the instructions for THIS turn explicitly state that a spoken conversation is active; that instruction is the only trigger there is.",
      "Absent that explicit per-turn instruction, never call say: do not infer a spoken conversation from the phrasing of the message, from how chatty the exchange feels, or from an earlier turn.",
      "When you are told to speak, use say as an ADDITIVE short spoken layer on top of your normal written answer, never as a replacement: the full detail stays in the written message.",
      "Keep say to one or two sentences of plain spoken language (no code, no markdown, no lists), a concise version of your answer the human can hear and sanity-check.",
    ],
    parameters: Type.Object({
      text: Type.String({
        description:
          "The short spoken-form reply (one or two sentences of plain language) to speak aloud, in addition to your written answer.",
      }),
    }),
    async execute(_toolCallId, params) {
      const text = String((params as { text?: string }).text || "").trim();
      if (!text) {
        return {
          content: [{ type: "text", text: "say: no text provided." }],
          details: undefined,
          isError: true,
        };
      }

      // Success. The spoken-reply surface is driven by the tool CALL (the web UI
      // reads the `text` from details), so we just confirm back to the model. No
      // filesystem, no bridge, no marker: works in any session type.
      return {
        content: [
          {
            type: "text",
            text: "Spoken reply delivered to the conversation.",
          },
        ],
        details: { text },
      };
    },
  });

  // Forward the agent's current context-window usage so the web UI can show the
  // "11.3% / 1.0M" indicator for CLI-bridged sessions (the server cannot compute
  // it for these). Best-effort: undefined usage (no model / no turn yet) is sent
  // as null so the client can clear a stale value.
  function sendContextUsage() {
    try {
      const usage = ctxVal?.getContextUsage?.();
      sendCliEvent({
        type: "context_usage",
        contextUsage: usage
          ? {
              tokens: usage.tokens,
              contextWindow: usage.contextWindow,
              percent: usage.percent,
            }
          : null,
      });
    } catch (err) {
      // Quiet fail.
    }
  }

  function connect() {
    if (client) {
      try {
        client.disconnect(true);
      } catch (err) {}
      client = null;
    }

    if (!ctxVal || !sessionFile) return;

    updateCliWidget('connecting');

    // Precedence throughout: explicit CLI flag > config.json > built-in default.
    // The flags carry no registered default (see registerFlag above), so an
    // absent flag really is absent here rather than silently masking the config.
    const remoteCfg = readRemoteConfig();

    const host = (pi.getFlag("remote-host") as string | undefined) || remoteCfg?.host || "127.0.0.1";
    const port = String(
      (pi.getFlag("remote-port") as string | undefined) || remoteCfg?.port || "31415",
    );
    const token = (pi.getFlag("remote-token") as string | undefined) || remoteCfg?.token;
    // Insecure if --remote-insecure is set, OR `remote.insecure` is true in the
    // config, OR --remote-secure is explicitly false (kept for back-compat).
    // Otherwise default to secure WSS. The flag can only force insecure ON, so
    // the config value is undone by editing the config, not by a flag.
    const isSecure =
      pi.getFlag("remote-insecure") === true || remoteCfg?.insecure === true
        ? false
        : pi.getFlag("remote-secure") !== false;

    client = new WhereverClient({
      host,
      port,
      token,
      secure: isSecure,
      WebSocketCtor: WebSocket
    });

    client.stateStore.subscribe((s) => {
      if (s.connected) {
        updateCliWidget('connected');
      } else if (s.connecting) {
        updateCliWidget('connecting');
      } else {
        updateCliWidget('disconnected');
      }
    });

    client.onMessage((msg) => {
      try {
        switch (msg.type) {
          case "cli_message": {
            ctxVal?.ui.notify(`[Wherever] Received remote command: ${msg.message.slice(0, 40)}...`, "info");
            // Arm/disarm the conversation-mode hint for the turn this message
            // starts (absent flag = off), then let before_agent_start consume it.
            conversationSignal.arm(msg.conversationMode === true);
            pi.sendUserMessage(msg.message, {
              deliverAs: msg.streamingBehavior,
            });
            break;
          }
          case "cli_bash": {
            const { command, excludeFromContext } = msg;
            ctxVal?.ui.notify(`[Wherever] Executing remote bash command: ${command.slice(0, 40)}...`, "info");

            sendCliEvent({
              type: "tool_execution_start",
              toolName: "bash",
              args: { command },
              forceCommand: true,
            });

            const shell = process.platform === "win32" ? "cmd.exe" : "bash";
            const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];
            const child = spawn(shell, shellArgs, { cwd: ctxVal?.cwd });
            let output = "";

            child.stdout?.on("data", (data: any) => {
              const chunk = data.toString();
              output += chunk;
              sendCliEvent({
                type: "tool_execution_update",
                toolName: "bash",
                delta: chunk,
              });
            });

            child.stderr?.on("data", (data: any) => {
              const chunk = data.toString();
              output += chunk;
              sendCliEvent({
                type: "tool_execution_update",
                toolName: "bash",
                delta: chunk,
              });
            });

            child.on("close", (code: number) => {
              sendCliEvent({
                type: "tool_execution_end",
                toolName: "bash",
                result: output,
                isError: code !== 0,
                forceCommand: true,
              });

              // Record bash result locally
              const bashMessage = {
                role: "bashExecution",
                command,
                output,
                exitCode: code,
                timestamp: Date.now(),
                excludeFromContext,
              };

              try {
                if (ctxVal?.sessionManager) {
                  (ctxVal.sessionManager as any).appendMessage(bashMessage);
                }
              } catch (err) {
                console.error("[Wherever] Failed to append bash message locally:", err);
              }
            });

            child.on("error", (err: any) => {
              const errMsg = err.message || String(err);
              sendCliEvent({
                type: "tool_execution_end",
                toolName: "bash",
                result: errMsg,
                isError: true,
              });
            });
            break;
          }
          case "cli_bash_sudo": {
            // A `!sudo ...` command whose password the web user just supplied.
            // Runs exactly like cli_bash, except the leading `sudo` is rewritten
            // to read the password from stdin (`sudo -S`), we ignore any cached
            // credential (`-k`) so it always asks, and suppress the prompt text
            // (`-p ''`) so it does not leak into output. The password is written
            // once then stdin is closed; it is never recorded, streamed, or
            // logged (only the password-free `command` is recorded).
            const { command, password, excludeFromContext } = msg as any;
            ctxVal?.ui.notify(`[Wherever] Executing remote sudo command: ${command.slice(0, 40)}...`, "info");

            sendCliEvent({
              type: "tool_execution_start",
              toolName: "bash",
              args: { command },
              forceCommand: true,
            });

            const rewritten = (command as string).replace(/(^|\n)(\s*)sudo(\s|$)/, `$1$2sudo -S -k -p '' $3`);
            const child = spawn("bash", ["-c", rewritten], {
              cwd: ctxVal?.cwd,
              stdio: ["pipe", "pipe", "pipe"],
            });
            let output = "";

            // Feed the password first, then close stdin so sudo (and the command)
            // see EOF and do not hang waiting for more input.
            child.stdin?.on("error", () => {});
            child.stdin?.write(password + "\n");
            child.stdin?.end();

            child.stdout?.on("data", (data: any) => {
              const chunk = data.toString();
              output += chunk;
              sendCliEvent({
                type: "tool_execution_update",
                toolName: "bash",
                delta: chunk,
              });
            });

            child.stderr?.on("data", (data: any) => {
              const chunk = data.toString();
              output += chunk;
              sendCliEvent({
                type: "tool_execution_update",
                toolName: "bash",
                delta: chunk,
              });
            });

            child.on("close", (code: number) => {
              sendCliEvent({
                type: "tool_execution_end",
                toolName: "bash",
                result: output,
                isError: code !== 0,
                forceCommand: true,
              });

              // Record the password-free command locally, same as cli_bash.
              const bashMessage = {
                role: "bashExecution",
                command,
                output,
                exitCode: code,
                timestamp: Date.now(),
                excludeFromContext,
              };

              try {
                if (ctxVal?.sessionManager) {
                  (ctxVal.sessionManager as any).appendMessage(bashMessage);
                }
              } catch (err) {
                console.error("[Wherever] Failed to append bash message locally:", err);
              }
            });

            child.on("error", (err: any) => {
              const errMsg = err.message || String(err);
              sendCliEvent({
                type: "tool_execution_end",
                toolName: "bash",
                result: errMsg,
                isError: true,
              });
            });
            break;
          }
          case "cli_abort": {
            ctxVal?.ui.notify("[Wherever] Received abort command from remote client", "warning");
            ctxVal?.abort();
            break;
          }
          case "cli_takeover_interrupted": {
            // This CLI just resumed a session the standalone server was running
            // MID-TURN, so that in-flight turn was interrupted and discarded
            // (not persisted). The CLI's own dangling-tool-call heuristic cannot
            // see a still-streaming (unpersisted) turn, so the server tells us
            // explicitly. Surface it, symmetric with the web client's banner.
            //
            // Avoid double-warning: for the tool-call case, the resume check
            // already showed its own (more detailed, tool-named) warning from the
            // persisted transcript, so skip. The streaming-text case is the one
            // only the server can see, and is always surfaced here.
            if (msg.toolCall && resumeDanglingShown) {
              break;
            }
            // A single transient notify is enough: after the takeover this CLI
            // owns the session and is NOT stuck (unlike the dangling-tool-call
            // resume case, which pins a persistent widget because pi sits idle
            // waiting). So no persistent widget here, just the one-time message.
            const what = msg.toolCall
              ? 'a tool call was running (its result was lost)'
              : 'a reply was streaming (that partial reply was discarded)';
            ctxVal?.ui.notify(
              `[Wherever] You took over this session from the web frontend while ${what}. ` +
                `This CLI now controls the session; continue here.`,
              "warning",
            );
            break;
          }
          case "cli_model_change": {
            const { model: modelStr } = msg;
            if (modelStr && ctxVal) {
              const idx = modelStr.indexOf(':');
              if (idx !== -1) {
                const provider = modelStr.slice(0, idx);
                const id = modelStr.slice(idx + 1);
                const model = ctxVal.modelRegistry.find(provider, id);
                if (model) {
                  ctxVal.ui.notify(`[Wherever] Changing model to ${modelStr}...`, "info");
                  pi.setModel(model).catch((err) => {
                    ctxVal?.ui.notify(`[Wherever] Failed to set model: ${err.message || err}`, "error");
                  });
                } else {
                  ctxVal.ui.notify(`[Wherever] Model not found in registry: ${modelStr}`, "error");
                }
              }
            }
            break;
          }
        }
      } catch (err) {
        console.error("[Wherever] Error handling message from server:", err);
      }
    });

    let wasConnected = false;
    client.stateStore.subscribe((s) => {
      if (s.connected && !wasConnected) {
        wasConnected = true;
        // Report the agent's CURRENT streaming state at register time. pi only
        // emits agent_start/agent_end going forward, so a turn already in flight
        // when the bridge (re)connects (server restart, reconnect mid-tool-call)
        // would otherwise be invisible to the web frontend: a viewer joining the
        // session would see Abort disabled + an enabled composer while the CLI is
        // still working. isIdle() is false during a live turn.
        let streaming = false;
        try {
          streaming = ctxVal?.isIdle ? !ctxVal.isIdle() : false;
        } catch (err) {
          // Best-effort; a stale context just reports not-streaming.
        }
        client?.send({
          type: "cli_register",
          sessionFile,
          cwd: ctxVal?.cwd,
          model: ctxVal?.model ? `${ctxVal.model.provider}:${ctxVal.model.id}` : "",
          isStreaming: streaming,
        });
        // Push the current context-window usage right after registering. Usage
        // is otherwise only forwarded on agent_end / model_select, so an idle
        // CLI session (no new turn since the bridge connected) would leave the
        // web "11.3% / 1.0M" indicator blank until the next turn. Sending it on
        // (re)connect populates it immediately for a viewer joining an idle
        // session. Best-effort: undefined usage (no model / no turn yet) is
        // still sent as null, which is a no-op for the indicator.
        sendContextUsage();
      } else if (!s.connected) {
        wasConnected = false;
      }
    });

    client.connect();
  }

  // Clear the "resumed mid-tool-call" warning widget, if shown. Safe to call
  // unconditionally; it is a no-op when nothing was set.
  function clearResumeToolWarning() {
    resumeDanglingShown = false;
    if (!ctxVal) return;
    try {
      ctxVal.ui.setWidget("wherever-resume-warning", undefined);
    } catch (err) {
      // Quiet fail if context is stale or disposed.
    }
  }

  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    // `remote.bridge: false` in config.json is the only way to actually turn the
    // bridge off: the flag is registered with default true and a pi boolean
    // cannot be passed as false, so --remote-bridge could never disable it.
    const isBridgeEnabled =
      pi.getFlag("remote-bridge") !== false && readRemoteConfig()?.bridge !== false;
    if (!isBridgeEnabled) return;

    ctxVal = ctx;
    sessionFile = ctx.sessionManager.getSessionFile() || "";
    if (!sessionFile) return;

    // Each new/resumed session starts from the configured default beep behaviour;
    // any prior per-session /remote-beep override does not carry over.
    beepOverride = undefined;

    // On resume/reload, the loaded transcript may end mid-tool-call (the matching
    // toolResult was never persisted). This happens when another process (the web
    // frontend / standalone server) is still running that tool, or the previous
    // run was interrupted. pi cannot auto-continue from a trailing unsatisfied
    // tool call, so the CLI would silently sit idle as if the turn were done.
    // Surface it so the user understands why nothing is happening, rather than
    // mistaking it for a completed turn awaiting input.
    if (event.reason === "resume" || event.reason === "reload" || event.reason === "startup") {
      try {
        const dangling = findDanglingToolCalls(ctx);
        if (dangling.length > 0) {
          const names = dangling.map((d) => d.name).join(", ");
          const detail =
            dangling.length === 1
              ? `the "${names}" tool call`
              : `${dangling.length} tool calls (${names})`;
          // pi cannot auto-continue from a trailing unsatisfied tool call, so it
          // sits idle. A single PERSISTENT widget is the right surface: it is an
          // ongoing "you must act" state, not a one-off event, so no transient
          // notify (which would just duplicate it). This CLI already owns the
          // session now, so the guidance is to send a message to retry/continue
          // (NOT "take over" -- the takeover already happened).
          ctx.ui.setWidget("wherever-resume-warning", (_tui, theme) => {
            const line = theme.fg(
              "warning",
              `⏳ [Wherever] Resumed mid-run: ${detail} had no result and cannot auto-continue. ` +
                `Send a message to retry or continue.`,
            );
            return {
              render: () => [line],
              invalidate: () => {},
            };
          });
          resumeDanglingShown = true;
        } else {
          clearResumeToolWarning();
        }
      } catch (err) {
        // Detection is best-effort; never block session start on it.
      }
    } else {
      clearResumeToolWarning();
    }

    connect();
  });

  pi.on("session_shutdown", async () => {
    const oldCtx = ctxVal;
    ctxVal = null;
    sessionFile = null;

    if (client) {
      try {
        client.disconnect(true);
      } catch (err) {}
      client = null;
    }

    if (oldCtx) {
      try {
        oldCtx.ui.setWidget("wherever-status", undefined); // Clear widget
        oldCtx.ui.setWidget("wherever-resume-warning", undefined); // Clear resume warning
      } catch (err) {}
    }
  });

  // Per-turn conversation-mode injection for a bridged terminal session driven
  // from the web: APPEND the hint to the system prompt this event CARRIES (the SDK
  // chains extensions' results, so never append to a snapshot and never replace
  // the prompt), only for a turn whose relayed message carried the flag. Ephemeral
  // by construction: a system-prompt addition is not stored in the user message and
  // renders as no chat line on web or CLI: only the resulting `say` call shows.
  pi.on("before_agent_start", async (event: any) => {
    const systemPrompt = conversationSignal.applyToSystemPrompt(event.systemPrompt);
    if (systemPrompt === undefined) return;
    return { systemPrompt };
  });

  // The other half of the same signal: the TAIL reminder, added before EVERY LLM
  // call of a spoken turn (including the post-tool-result synthesis call, which is
  // exactly where a system-prompt-only hint gets ignored). The SDK hands us a
  // structuredClone and passes the result straight to convertToLlm, so this never
  // touches session state, the transcript or the TUI.
  pi.on("context", async (event: any) => {
    const messages = conversationSignal.applyToContext(event.messages);
    if (messages === undefined) return;
    // The structural ContextMessageLike[] this module works in IS the SDK's
    // AgentMessage[] at runtime (the same objects, with at most one cloned tail);
    // the cast is only to keep the shared twin free of SDK type imports.
    return { messages } as any;
  });

  // Subscribe and forward Agent Events to the Standalone Server
  pi.on("agent_start", async () => {
    // The agent is running again (the user took over / continued the session), so
    // the "resumed mid-tool-call" warning is no longer relevant.
    clearResumeToolWarning();
    sendCliEvent({ type: "agent_start" });
  });

  pi.on("message_update", async (event: any) => {
    sendCliEvent({
      type: "message_update",
      message: event.message,
      assistantMessageEvent: event.assistantMessageEvent,
    });
  });

  pi.on("message_end", async (event: any) => {
    sendCliEvent({
      type: "message_end",
      message: event.message,
    });
  });

  pi.on("agent_end", async (event: any) => {
    // The spoken turn is over: stop adding the tail reminder until the next
    // flagged message opens a new one.
    conversationSignal.endTurn();
    sendCliEvent({
      type: "agent_end",
      messages: event.messages,
    });
    // Context usage is freshest right after a turn completes.
    sendContextUsage();
  });

  // agent_settled fires once the run has fully settled: no automatic retry,
  // compaction, or queued continuation is pending, so the agent is genuinely
  // waiting for a human message. This is the right (single) moment to beep,
  // rather than agent_end which can fire between chained internal turns.
  pi.on("agent_settled", async () => {
    if (beepEnabled()) playBeep();
  });

  pi.on("tool_execution_start", async (event: any) => {
    sendCliEvent({
      type: "tool_execution_start",
      toolName: event.toolName,
      args: event.args,
    });
  });

  pi.on("tool_execution_end", async (event: any) => {
    sendCliEvent({
      type: "tool_execution_end",
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    });
  });

  pi.on("model_select", async (event: any) => {
    const modelStr = event.model ? `${event.model.provider}:${event.model.id}` : "";
    sendCliEvent({
      type: "model_select",
      model: modelStr,
    });
    // Context window can change with the model, so refresh the indicator.
    sendContextUsage();
  });
}
