import { HistoryMessage, ContextUsageInfo, ToolImage, SkillCommand } from './session-types.js';
export type { ContextUsageInfo, ToolImage, SkillCommand } from './session-types.js';
// Type-only, so declaring the restore frames here does not pull the registry's
// node:child_process/node:fs surface into anything that merely parses protocol.
import type { RestoreJobKind, RestoreJobSnapshot, RestoreRejectionReason } from './restore-jobs.js';
export type {
  RestoreJobKind,
  RestoreJobSnapshot,
  RestoreJobState,
  RestoreProgress,
  RestoreFailure,
  RestoreFailureCause,
  RestoreRejectionReason,
} from './restore-jobs.js';

// Initial number of (most recent) history messages sent when a session is
// loaded/joined. Older messages are fetched lazily via `history_load_more`.
export const INITIAL_HISTORY_LIMIT = 60;
// Number of older messages returned per `history_load_more` request.
export const HISTORY_PAGE_SIZE = 60;

export type ClientMessage =
  | { type: 'connect' }
  // `conversationMode` is the per-turn CONVERSATION-MODE SIGNAL: the web client
  // stamps it true when its conversation-mode AND speak-replies knobs are both
  // active, so the agent learns a spoken conversation is on and adds a short `say`
  // reply. A FIELD on this existing payload (no new message type, no new chat
  // role); absent means false, so older clients are unaffected. See
  // server/src/conversation-mode-hint.ts.
  | { type: 'message'; message: string; sessionId: string; conversationMode?: boolean }
  | { type: 'abort'; sessionId: string }
  // Client -> server: cancel the queued mid-stream STEER messages for this
  // session (the ones injected at the next step boundary that have not yet been
  // delivered). Retracts a steer the user regrets WITHOUT aborting the whole
  // in-flight turn. Only server-type sessions can dequeue a single steer; CLI
  // bridges never emit queue_update, so no cancel affordance shows for them.
  | { type: 'cancel_steer'; sessionId: string }
  | { type: 'ping' }
  | { type: 'session_load'; sessionFile: string; cwd?: string; model?: string }
  | { type: 'history_load_more'; sessionId: string; beforeOffset: number }
  // Client -> server: start a NEW conversation in `cwd`.
  //
  // The two remote intents are distinct and mutually exclusive: `createRemote`
  // PROVISIONS a new repository for a new folder, while `cloneRemote` clones the
  // EXISTING one the probe found (what the dashboard's clone-or-create dialog
  // offers). The clone runs as a path-keyed RESTORE JOB before the session is
  // created, so the answer to a `cloneRemote` create begins with
  // `restore_started` and its progress frames; `session_created` follows only
  // when the job is done, and a failed or cancelled job answers `session_error`
  // with the mapped cause and creates nothing. See CONTEXT.md and
  // `docs/adr/0009` -- there is ONE clone implementation, shared with the
  // restore panel.
  | { type: 'session_new'; cwd: string; model?: string; gitInit?: boolean; createRemote?: boolean; repoVisibility?: 'private' | 'public'; cloneRemote?: boolean }
  // Client -> server: fork the given session at a specific user-message entry,
  // mirroring pi's `/fork` (position 'before'). The server creates a new
  // branched session file (root -> the entry before `entryId`) that records
  // `parentSession` = the source, and replies with `session_forked` carrying
  // the new file path + the chosen message's text to pre-fill the composer.
  // The client then loads the new session via the normal `session_load` flow.
  | { type: 'session_fork'; sessionId: string; entryId: string }
  | { type: 'session_leave'; sessionId: string }
  // Client -> server: ask for the skill commands available in this session so
  // the composer can offer `/skill:<name>` autocomplete. The server replies with
  // a `skills_list`. Sent as soon as the session's agent is live (on
  // session_created for an already-live session, or on session_ready for a cold
  // load that was still building); safe to re-request.
  | { type: 'skills_request'; sessionId: string }
  // Client -> server: the user clicked "Continue anyway" on the folder-conflict
  // warning banner. The server lifts this client's read-only flag so it can send
  // into its session even though another session in the same folder is active.
  // It does NOT abort or take over the other session; both run concurrently.
  | { type: 'folder_conflict_continue'; sessionId: string }
  // Client -> server: RESTORE the working folder at `targetPath` -- materialise
  // it by CLONING `url` (SSH, or a `file://` fixture) or by CREATING the folder.
  // Answered to THIS client with `restore_started` (carrying whether the request
  // started a job or JOINED one already running for that path, and the url that
  // job is really cloning) or with `restore_rejected` when it is refused before
  // anything is spawned. Progress and the outcome then arrive as broadcasts, to
  // every client matching the path -- including this one.
  //
  // NOTE the vocabulary (CONTEXT.md): `restore` here means materialising a
  // MISSING WORKING FOLDER, never the unrelated re-materialising of queued
  // steers/drafts after a reload. Every frame in this family is `restore_*`.
  | { type: 'restore_start'; targetPath: string; action: RestoreJobKind; url?: string; gitInit?: boolean }
  // Client -> server: cancel the restore job running at `targetPath`. The job is
  // server-owned and path-keyed, so ANY client looking at that folder can cancel
  // it -- including one that did not start it (the phone that started the clone
  // may be the one that is gone). A directory the job created is removed with it.
  | { type: 'restore_cancel'; targetPath: string }
  | { type: 'model_change'; model: string }
  | { type: 'file_upload'; uploadId: string; sessionId: string; filename: string; data: string }
  | { type: 'cli_register'; sessionFile: string; cwd: string; model?: string; isStreaming?: boolean }
  | { type: 'cli_event'; sessionFile: string; event: any }
  // Server -> CLI bridge relay of a web user message. `conversationMode` carries
  // the same per-turn signal as the `message` payload above, so a bridged terminal
  // session driven from the web gets the same injection (the extension's own
  // before_agent_start handler applies it).
  | { type: 'cli_message'; message: string; streamingBehavior?: 'steer' | 'followUp'; conversationMode?: boolean }
  | { type: 'cli_abort' }
  | { type: 'cli_bash'; command: string; excludeFromContext?: boolean }
  | { type: 'cli_model_change'; model: string }
  // Client -> server: the user supplied the sudo password for a pending sudo
  // bash prompt (identified by promptId). The password is used once to feed the
  // sudo child's stdin and is never persisted or logged.
  | { type: 'bash_sudo_password'; sessionId: string; promptId: string; password: string }
  // Client -> server: the user dismissed the sudo password prompt without
  // supplying a password. The pending command is dropped, nothing runs.
  | { type: 'bash_sudo_cancel'; sessionId: string; promptId: string };

export type ServerMessage =
  // `serverVersion` is the running server package version (`wherever-dev`'s
  // package.json version), sent on connect so the UI can show which server it is
  // talking to next to its own build id. Optional so older servers still parse.
  | { type: 'connected'; clientId: string; serverVersion?: string }
| { type: 'agent_start'; sessionId: string }
 | { type: 'thinking_update'; sessionId: string; delta: string }
 | { type: 'message_update'; sessionId: string; delta: string }
  | { type: 'message_end'; sessionId: string; content: string; role?: 'user' | 'assistant' }
  // Server -> client: the server accepted an outbound user message and handed it
  // to the agent (as a normal turn OR as a mid-stream steer queued for the next
  // step). This is the DELIVERY acknowledgement: it fires immediately, whereas
  // the message_end (role:user) echo for a steer only comes at the next model
  // call and can arrive long after the client's confirmation window. `content`
  // lets the client match the ack to its optimistic pending echo.
  | { type: 'message_ack'; sessionId: string; content: string }
  // Server -> client: the set of mid-stream STEER messages currently queued for
  // this session (pi injects them at the next step boundary). Sent whenever the
  // queue changes (pi's queue_update), AND as a snapshot when a client attaches
  // (session_load, which is also the reload/resync path): a queued message is
  // only in the agent's memory, not the session file, so an attaching client
  // would otherwise see nothing queued while pi still holds (and will inject)
  // the text. `steering` is the full current queue, so the client replaces its
  // pending-steer set outright and re-materializes any queued message its
  // history does not contain. An empty array means nothing is queued (e.g. the
  // queued steers were just delivered or cancelled).
  // Only server-type sessions emit this; CLI bridges do not, so their steers are
  // not individually cancellable from the web (the button simply never appears).
  | { type: 'queue_update'; sessionId: string; steering: string[] }
  | { type: 'agent_end'; sessionId: string }
  | { type: 'tool_start'; sessionId: string; toolName: string; args: unknown; forceCommand?: boolean }
  | { type: 'tool_update'; sessionId: string; toolName: string; delta: string }
  | { type: 'tool_end'; sessionId: string; toolName: string; isError: boolean; result?: string; images?: ToolImage[]; forceCommand?: boolean }
  | { type: 'cli_bash'; command: string; excludeFromContext?: boolean }
  // Server -> CLI bridge: run a `!sudo ...` command whose password the web user
  // just supplied. Like cli_bash but the extension must feed `password` to the
  // sudo child's stdin (sudo -S). The password is used once by the extension and
  // is never persisted or logged; only the password-free `command` is recorded.
  | { type: 'cli_bash_sudo'; command: string; password: string; excludeFromContext?: boolean }
  // Server -> client: a `!sudo ...` bash command needs a password before it can
  // run. The client should prompt (masked) and reply with bash_sudo_password or
  // bash_sudo_cancel carrying the same promptId. `command` is the sudo command
  // line WITHOUT any password, safe to display.
  | { type: 'bash_sudo_prompt'; sessionId: string; promptId: string; command: string }
  | { type: 'session_created'; sessionId: string; sessionFile: string; cwd: string; model: string; isStreaming?: boolean; readOnly?: boolean; contextUsage?: ContextUsageInfo | null; pending?: boolean; folderConflict?: boolean; folderMissing?: boolean }
  // Sent after a `pending` session_created once the live agent has finished
  // building (createAgentSession). Until it arrives, the UI can render the
  // conversation (from message_history) but must keep the composer disabled:
  // reading is instant, sending needs the live agent. May carry a refreshed
  // model/isStreaming/contextUsage now that the real agent exists.
  | { type: 'session_ready'; sessionId: string; sessionFile: string; model?: string; isStreaming?: boolean; contextUsage?: ContextUsageInfo | null }
  | { type: 'context_usage'; sessionId: string; contextUsage: ContextUsageInfo | null }
  | { type: 'session_destroyed'; sessionId: string; reason: string }
  | { type: 'session_error'; sessionId?: string; error: string; detail?: string }
  // Server -> client: a `session_fork` succeeded. `sessionFile` is the new
  // forked session's file path; the client should load it (normal session_load)
  // and pre-fill the composer with `prefillText` (the forked-at user message,
  // ready to edit and resend). `sourceSessionId` echoes what was forked.
  | { type: 'session_forked'; sourceSessionId: string; sessionFile: string; cwd: string; prefillText: string }
  // Server -> client: whether ANOTHER active session exists in the same folder
  // as this client's current session. Sent as a live update (on top of the
  // initial `folderConflict` flag in session_created) so the warning banner can
  // appear/disappear as other clients open or leave sessions in the folder.
  // There is no take-over/read-only protection: this is purely a heads-up that
  // two sessions in one folder are (or are no longer) live simultaneously.
  // `readOnly` is the server's authoritative verdict for THIS client right after
  // re-evaluating the conflict, so a resolved conflict releases the composer and
  // a hard sessions.readOnly folder keeps it locked. Optional for back-compat
  // with clients that predate it.
  | { type: 'folder_conflict'; cwd: string; active: boolean; readOnly?: boolean }
  // Server -> client: this session's working folder does NOT exist on this
  // machine (the transcript synced, the clone did not). `cwd` is the ABSOLUTE
  // missing path, so the UI can name exactly what to restore. Sent on the load
  // that discovered it, right after message_history: the conversation still
  // paints (reading never needed the folder), but no live agent is built and the
  // client is read-only.
  //
  // FOLDER MISSING is the third read-only reason, and it is HARD: unlike a
  // folder conflict there is no "Continue anyway", and unlike a sessions.readOnly
  // rule it is curable -- by restoring the folder and RELOADING the session (a
  // live agent is a load-time decision). Detection is load-time only, so this
  // frame is only ever sent while missing; there is no "it came back" update.
  //
  // `job` carries any restore job the server is ALREADY running (or has just
  // finished) for this path, so a client arriving mid-clone -- a reconnect, a
  // second device, a phone waking up -- repaints the running progress instead of
  // being offered a second clone. Absent when no job exists for the folder.
  // Remote CANDIDATES deliberately do NOT ride on this frame: resolving them can
  // shell out to a provider CLI, and this frame is on the session-load path, so
  // the panel fetches them on demand from GET /remote-candidates.
  | { type: 'folder_missing'; sessionId: string; cwd: string; job?: RestoreJobSnapshot }
  // Server -> client: the answer to THIS client's `restore_start`. `outcome` is
  // 'joined' when a job was already running for the path and this request
  // coalesced onto it; `job.url` is then the url REALLY in flight, which the
  // panel must show when it differs from the one the user typed. Sent to the
  // requester only; everyone else learns about the job from the broadcasts below.
  //
  // It is ALSO the first answer to a `session_new` that chose to CLONE an
  // existing remote: same frame, same job, same progress -- what differs is the
  // ending. That client has no session yet, so it ADOPTS the job as its create's
  // first step (dropping its blocking overlay and its create watchdog) and the
  // server continues into creation itself once the job is done, instead of
  // offering the panel's Reload.
  | { type: 'restore_started'; targetPath: string; outcome: 'started' | 'joined'; job: RestoreJobSnapshot }
  // Server -> client: this client's `restore_start` was REFUSED before anything
  // was spawned or created (an unsafe target, a non-empty folder, a url outside
  // the SSH/file shape allowlist). No job exists, so there is nothing to cancel
  // and no completion is coming; the panel shows `message` and stays in its
  // offer-to-restore state. Sent to the requester only.
  | { type: 'restore_rejected'; targetPath: string; reason: RestoreRejectionReason; message: string }
  // Server -> client: live progress for the restore job at `targetPath`, carrying
  // the whole job snapshot so ONE frame is enough to repaint from scratch.
  //
  // Broadcast to every connected client whose current session cwd, or pending
  // load target, MATCHES the job path. That subscription is DERIVED from the
  // match on each frame, never registered per socket, so a dropped phone leaves
  // nothing behind and a reconnecting one is matched again for free.
  | { type: 'restore_progress'; targetPath: string; job: RestoreJobSnapshot }
  // Server -> client: the restore job at `targetPath` reached a TERMINAL state
  // (`done`, `failed` or `cancelled` -- read `job.state`, all three arrive here).
  // A failure carries `job.failure` with the mapped cause and git's raw stderr
  // underneath. Same derived broadcast as restore_progress. On success the panel
  // offers a RELOAD, because whether a session has a live agent is a load-time
  // decision and only a reload can make one.
  | { type: 'restore_complete'; targetPath: string; job: RestoreJobSnapshot }
  // Server -> client: this connection is being closed because a NEWER connection
  // arrived carrying the same `clientKey`, i.e. the server took it for this
  // viewer's own reconnect. A client that receives this is demonstrably alive, so
  // the key was shared by accident (a duplicated browser tab clones
  // sessionStorage): it must regenerate its key before reconnecting, otherwise
  // the two connections evict each other forever.
  | { type: 'connection_superseded' }
  | { type: 'session_interrupted'; sessionId: string; reason: string }
  // A non-fatal, dismissible notice about the active session that the UI should
  // surface as a banner (e.g. a CLI bridge took over a mid-run session and its
  // in-flight tool call/turn was interrupted). Unlike session_interrupted, the
  // client KEEPS the session attached; this is purely informational.
  | { type: 'session_notice'; sessionId: string; level: 'info' | 'warning'; message: string }
  // Sent to the CLI bridge (only) right after it registers a session that the
  // server was actively running MID-TURN. Registering disposes that server-side
  // agent, discarding the in-flight turn without persisting it, so the CLI's own
  // dangling-tool-call heuristic cannot see the streaming-text case. This tells
  // the CLI explicitly so it can surface the takeover, symmetric with the web
  // client's session_notice. `toolCall` is true when a tool call was in flight
  // (its result is lost), false when only assistant text was streaming.
  | { type: 'cli_takeover_interrupted'; sessionId: string; toolCall: boolean }
  | { type: 'message_history'; sessionId: string; messages: HistoryMessage[]; totalCount?: number; offset?: number }
  | { type: 'message_history_prepend'; sessionId: string; messages: HistoryMessage[]; offset: number }
  | { type: 'model_changed'; sessionId: string; model: string }
  | { type: 'file_uploaded'; uploadId: string; sessionId: string; filename: string; savedPath: string }
  | { type: 'file_upload_error'; uploadId: string; sessionId: string; error: string }
  | { type: 'sessions_updated' }
  // Server -> client: the skill commands available for `sessionId`, for the
  // composer's `/skill:<name>` autocomplete. Each entry's `name` is the full
  // invocation without the leading slash (e.g. "skill:setup"). Empty for CLI
  // bridges (they expand skills on their own side) or when none are discovered.
  | { type: 'skills_list'; sessionId: string; skills: SkillCommand[] }
  | { type: 'pong'; timestamp: number };
