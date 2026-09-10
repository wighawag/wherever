/**
 * A slash-command candidate the composer's autocomplete can offer. Currently
 * only skills are surfaced (`name` is the full invocation, e.g. `skill:setup`,
 * so the composer inserts `/skill:setup `). Prompt templates could be added
 * here later with the same shape.
 */
export interface SkillCommand {
  /** Full command name WITHOUT the leading slash, e.g. "skill:setup". */
  name: string;
  /** One-line description from the skill's frontmatter, if any. */
  description?: string;
}

/** Context-window usage snapshot surfaced in the UI (e.g. "11.3% / 1.0M"). */
export interface ContextUsageInfo {
  /** Estimated context tokens, or null if unknown (e.g. right after compaction). */
  tokens: number | null;
  /** The model's context window size in tokens. */
  contextWindow: number;
  /** tokens / contextWindow as a percentage, or null if tokens is unknown. */
  percent: number | null;
}

export interface SessionInfo {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  model?: string;
  clientCount: number;
  isIdle: boolean;
  createdAt: number;
  lastActivity: number;
}

export interface FolderSessionInfo {
  path: string;
  id: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  /**
   * A SHORT, whitespace-collapsed PREVIEW of the first user message (capped
   * server-side), not the full text. The sidebar only shows a snippet and
   * filters on it; shipping the full first message of every session is what
   * bloated the /sessions payload.
   */
  firstMessage: string;
  isActive: boolean;
  clientCount: number;
  /**
   * Absolute path of the parent session this one was forked from (from the
   * session header's `parentSession`), or undefined for a root session. Lets
   * the client build the fork hierarchy tree, mirroring pi's session selector.
   */
  parentSessionPath?: string;
}

export interface FolderWithSessions {
  path: string;
  name: string;
  sessions: FolderSessionInfo[];
  /** True when this folder's cwd matched a sessions.readOnly glob. */
  readOnly?: boolean;
  /**
   * True when this folder does NOT exist on this machine (the listing view of
   * the folder-missing session state: transcripts sync across machines, the
   * clones they name do not). ORTHOGONAL to `readOnly`: a folder can be either,
   * both or neither, and the two must never be rendered as one thing.
   *
   * Named `missing` rather than `folderMissing` (the session-level flag on
   * `session_created`) because the subject here IS a folder -- exactly as
   * `readOnly` drops the prefix on this same object. It is the SAME concept as
   * the pinned `folder missing` state, not a second one.
   */
  missing?: boolean;
}

export interface SessionsResponse {
  folders: FolderWithSessions[];
  activeSessions: SessionInfo[];
}

/**
 * An image block extracted from a tool result (e.g. `read` on an image file).
 * `data` is base64 (no data-URI prefix); `mimeType` is the source media type.
 * Carried alongside the textual tool output so the web frontend can render the
 * image inline, mirroring the CLI's inline image display.
 */
export interface ToolImage {
  mimeType: string;
  data: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result';
  content: string;
  timestamp: number;
  toolName?: string;
  isError?: boolean;
  /**
   * The source session-tree entry id this message was mapped from. Set on
   * `user` messages so the client can offer a "Fork from here" affordance that
   * forks the session BEFORE this entry (pi's `position: 'before'` semantics),
   * pre-filling the composer with this message's text to edit and resend.
   */
  entryId?: string;
  /**
   * The tool-call id. Set on `tool_call` (the id the assistant issued) and on
   * `tool_result` (the toolCallId it satisfies). Lets the client pair a result
   * to its exact call, instead of the ambiguous tool-name FIFO fallback, so
   * interleaved same-named calls (some dangling) map correctly.
   */
  toolCallId?: string;
  /** Image attachments extracted from a tool_result (base64), if any. */
  images?: ToolImage[];
  /**
   * True on a `tool_call` that came from a user `!command` / `!!command` (a
   * "force command", persisted as a `bashExecution` entry), as opposed to a tool
   * call the agent issued. The web UI uses this to auto-expand force-command bash
   * output. Set only on the bash tool_call; agent tool calls leave it unset.
   */
  forceCommand?: boolean;
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  label: string;
  isDefault?: boolean;
}
