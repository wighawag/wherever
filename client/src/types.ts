export interface ToolImage {
	mimeType: string;
	data: string;
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'thinking' | 'tool';
	content: string;
	timestamp: number;
	isStreaming?: boolean;
	sessionId?: string;
	toolName?: string;
	toolArgs?: string;
	toolOutput?: string;
	// The source session-tree entry id this message maps to. Set on `user`
	// messages (from history) so the UI can offer a "Fork from here" action that
	// forks the session BEFORE this entry (pi's position:'before'), pre-filling
	// the composer with this message's text to edit and resend.
	entryId?: string;
	// Image attachments extracted from a tool result (e.g. `read` on an image
	// file). `data` is base64 (no data-URI prefix); rendered inline in the tool
	// output, mirroring the CLI's inline image display.
	images?: ToolImage[];
	isError?: boolean;
	// A tool call that ended WITHOUT a result: the assistant issued the toolCall
	// but no toolResult was ever persisted (e.g. a CLI took over the session and
	// the running tool was killed mid-execution). Its outcome is unknown, so the
	// UI must show a distinct "interrupted / no result" state, NOT the green
	// success tick (we do not know if it succeeded or failed) and NOT the red
	// error tick (it was not an error, it just never finished). Only meaningful
	// for role: 'tool'; mutually exclusive with a live isStreaming tool.
	interrupted?: boolean;
	// True when this bash tool call came from a user `!command` / `!!command` (a
	// "force command"), rather than one the agent issued. Set from the tool_start
	// frame (live) or the history tool_call (reload). The web UI auto-expands
	// force-command bash output. Only meaningful for role: 'tool', toolName 'bash'.
	forceCommand?: boolean;
	// True on an OPTIMISTIC force-command (`!command` / `!!command`) tool bubble
	// the client rendered locally at send time, BEFORE the server's real
	// `tool_start` arrives. It gives instant feedback (the server no longer echoes
	// `!`-commands as a user message, so without this nothing shows until the
	// server round-trip completes). When the real `tool_start` for the same
	// command arrives it RECONCILES onto this bubble (clearing this flag) instead
	// of appending a duplicate. Only meaningful for role: 'tool', toolName 'bash'.
	optimistic?: boolean;
	// Wall-clock start of a tool call (ms epoch), set when the tool_start frame
	// arrives. `timestamp` also carries this, but startedAt is kept explicit so
	// the elapsed/took duration is unambiguous and survives content rewrites.
	startedAt?: number;
	// Wall-clock end of a tool call (ms epoch), set when tool_end arrives. While a
	// tool is running this is undefined and the UI ticks a live "Elapsed N.Ns";
	// once set the UI freezes it as "Took N.Ns" (mirrors the pi CLI).
	endedAt?: number;
	// Delivery state for an OUTBOUND user message. A frame handed to a socket that
	// reports OPEN can still never reach the server (a half-open TCP connection:
	// send() buffers locally, no throw, but the bytes never land). So an optimistic
	// echo is NOT proof of delivery. `delivery` tracks that:
	//   'sending'   -> handed to the socket, awaiting the server's echo.
	//   'failed'    -> no echo within the confirmation window; delivery is
	//                  uncertain, so the UI surfaces a retry affordance rather than
	//                  a normal-looking sent message.
	// Undefined = confirmed/delivered (or a message that never needed tracking,
	// e.g. one loaded from server history). Confirmed on the server's user echo
	// (message_end role:user) or when it reappears in loaded history.
	delivery?: 'sending' | 'failed';
	// True on a user message this client RESTORED from the server's steer-queue
	// snapshot rather than from history or its own send (see queue_update). Such a
	// message is queued in the agent but not yet in the session file, so when pi
	// finally injects it the server's user echo must RECONCILE onto this bubble
	// (clearing the flag) instead of appending a duplicate. Content-matching the
	// last user message is not enough: with several messages queued they are
	// delivered oldest-first, so the echoed one is usually not the last bubble.
	restoredFromQueue?: boolean;
}

export interface SessionNotice {
	level: 'info' | 'warning';
	message: string;
}

// A pending `!sudo ...` command waiting for the user to supply a password. The
// password itself is never stored in state: the UI collects it in a masked
// field and hands it straight to sendSudoPassword(). `command` is the sudo
// command line WITHOUT any password, safe to display in the prompt.
export interface SudoPrompt {
	promptId: string;
	command: string;
	sessionId: string;
}

// State for the folder-conflict warning banner. Set when this client attaches
// to a session in a folder that already has ANOTHER active session. There is no
// take-over/read-only protection anymore: `active` reflects whether another
// session is still live in the folder (the banner shows while true), and
// `continued` is true once the user clicked "Continue anyway" (so the composer
// is enabled and the banner drops its button, staying only as a passive notice).
export interface FolderConflictInfo {
	cwd: string;
	active: boolean;
	continued: boolean;
}

// State for the MISSING-FOLDER lock. Set when the server reports that this
// session's working folder does not exist on this machine (the `folderMissing`
// flag on session_created, and the `folder_missing` frame that names the path).
// The transcript still paints -- reading never needed the folder -- but the
// server built no live agent and refuses every send.
//
// Unlike a folder conflict this is HARD: there is no "Continue anyway". It is
// cured by restoring the folder and RELOADING the session (whether a session has
// a live agent is a load-time decision). `cwd` is the absolute missing path, so
// the UI can name exactly what to restore where the composer would be.
export interface FolderMissingInfo {
	cwd: string;
}

// --- RESTORE (materialising a missing working folder) ----------------------
//
// Vocabulary, pinned (see CONTEXT.md): RESTORE here means making a missing
// working folder exist again -- cloning the repository back, or creating the
// folder. It is NOT the unrelated in-codebase sense of re-materialising queued
// steers and drafts after a reload (`restoredFromQueue` above). Every frame and
// field in this family is namespaced `restore*`.
//
// These mirror the server's restore-job snapshot (server/src/restore-jobs.ts)
// field for field, duplicated here rather than imported so this package keeps no
// server dependency (the same posture as ContextUsage).

// One honest progress reading. `percent` is null exactly when git reports no
// percentage for the phase, and `indeterminate` says so explicitly rather than
// leaving the UI to invent a 0. `scope` is the repository itself
// ('repository') or a submodule's path relative to the target: submodules are
// counted SEPARATELY, never folded into one fake global percentage.
export interface RestoreProgressInfo {
	phase: string;
	scope: string;
	percent: number | null;
	indeterminate: boolean;
	/** The git line this was parsed from, for a detail line under the bar. */
	text: string;
	at: number;
}

// A failed restore, explained. `cause` is the server's mapping onto a named,
// actionable problem ('no-key' | 'unknown-host' | 'not-found' | 'network' |
// 'unknown'); `message` is the human sentence for it, and `stderr` is git's raw
// output, kept UNDERNEATH the mapping and never replaced by it.
export interface RestoreFailureInfo {
	cause: string;
	message: string;
	stderr: string;
}

// A restore job as the server reports it. Keyed by `targetPath` on the server,
// so `id` is what tells a retry apart from the job it replaced.
export interface RestoreJobInfo {
	id: number;
	kind: 'clone' | 'create';
	targetPath: string;
	/** The url the job is ACTUALLY cloning (clone kind only). */
	url?: string;
	gitInit?: boolean;
	state: 'running' | 'done' | 'failed' | 'cancelled';
	progress: RestoreProgressInfo | null;
	failure?: RestoreFailureInfo;
	startedAt: number;
	endedAt?: number;
}

// What the restore panel needs to render, for ONE folder. Created as soon as a
// folder-missing session is loaded (with `job` already set when the server is
// mid-clone for that path, so a reconnecting phone repaints a running job), and
// updated by the server's restore frames.
export interface RestoreInfo {
	/** The absolute folder being restored. Frames for any other path are ignored. */
	targetPath: string;
	/** The server's job for that path, or null while none has been started. */
	job: RestoreJobInfo | null;
	// True when THIS client's last start JOINED a job that was already running.
	// With `requestedUrl` it is what lets the panel say "a clone of <job.url> is
	// already running" instead of pretending the edited url was accepted.
	joined: boolean;
	/** The url this client last asked for, whether or not it was the one used. */
	requestedUrl?: string;
	// A request REFUSED before anything was spawned (an unsafe target, a
	// non-empty folder, a url outside the allowlist). No job exists and no
	// completion is coming, so the panel shows this and stays in its offer state.
	rejection: {reason: string; message: string} | null;
	// True when this restore is the first step of a SESSION CREATE (the
	// new-session clone), not the restore of a loaded session's missing folder.
	// Same job, same frames, same progress display -- what differs is the ENDING:
	// there is no session to reload here (it does not exist until the clone
	// lands), so the server continues into creation itself and the client hands
	// the screen back to the create instead of offering a Reload.
	forSessionCreate?: boolean;
}

export interface WhereverState {
	connected: boolean;
	connecting: boolean;
	creatingSession: boolean;
	// True from the moment a session_load is requested until its message_history
	// (or an error/conflict) arrives. Distinguishes "opening an existing session"
	// from "a brand new empty session" so the UI can show a loading state instead
	// of the "New Session Started" empty state.
	loadingSession: boolean;
	// True while the connection was suspended (e.g. the tab was backgrounded) and
	// is now reconnecting + rejoining the previously-active session. The cached
	// messages remain visible; the UI shows a "reconnecting/syncing" affordance
	// and blocks input until the resync completes.
	resyncing: boolean;
	// True after a `pending` session_created (history painted from a cheap read)
	// until session_ready arrives (the live agent finished building). The
	// conversation is READABLE during this window, but SENDING must be blocked:
	// reading only needs the transcript, sending needs the live agent. Distinct
	// from loadingSession/resyncing, which gate the whole view; agentPending gates
	// only the composer so opening a cold session to read is instant.
	agentPending: boolean;
	error: string | null;
	session: string | null;
	sessionId: string | null;
	isStreaming: boolean;
	messages: ChatMessage[];
	clientId: string | null;
	// Version of the server we are connected to (the `wherever-dev` package
	// version), as reported in its `connected` message. null until connected, or
	// when talking to a server old enough not to report it.
	serverVersion: string | null;
	folderConflict: FolderConflictInfo | null;
	// The active session's working folder is gone from this machine (see
	// FolderMissingInfo). Non-null implies `readOnly`, and no `session_ready` is
	// coming: the composer is replaced by a notice naming the path. Cleared with
	// the session it belongs to.
	folderMissing: FolderMissingInfo | null;
	// The restore of the active session's missing folder: the server's job for
	// that path (running, finished or not yet started) plus this client's own last
	// request. Non-null exactly while a folder-missing session is open, so the
	// panel that replaces the composer renders from here. Cleared with the session
	// it belongs to.
	restore: RestoreInfo | null;
	isInterrupted: boolean;
	// A dismissible, non-fatal notice about the active session (e.g. a CLI bridge
	// took over while this session was mid-turn here, discarding the in-flight
	// tool call or streaming reply). Rendered as a banner and cleared on dismiss,
	// on leaving the session, or when a fresh notice replaces it. null when there
	// is nothing to show.
	notice: SessionNotice | null;
	// A pending sudo password prompt for the active session, or null when there is
	// nothing to ask. Set on a server bash_sudo_prompt and cleared when the user
	// submits/cancels, when the session changes, or when the connection drops.
	sudoPrompt: SudoPrompt | null;
	sessionError: string | null;
	readOnly: boolean;
	activeSessionFile: string | null;
	activeCwd: string | null;
	activeModel: string | null;
	hideThinking: boolean;
	hideTools: boolean;
	// Tail-first history pagination. `historyTotalCount` is the total number of
	// history messages on the server; `historyOffset` is the index of the first
	// message currently loaded in `messages`. When `historyOffset > 0`, older
	// history can be fetched via `loadMoreHistory()`.
	historyTotalCount: number;
	historyOffset: number;
	loadingMoreHistory: boolean;
	// Context-window usage for the active session (drives the "11.3% / 1.0M"
	// indicator). null when unknown (no model, no usage yet, or just compacted).
	contextUsage: ContextUsage | null;
	// The mid-stream STEER messages currently queued on the server (pi injects
	// them at the next step boundary). Mirrors the server's queue_update: it is
	// the FULL current queue, replaced outright on each update. Used to badge a
	// still-pending steer bubble and to offer a session-level cancel (pi's
	// clearQueue() drops the whole queue at once); empty when nothing is queued.
	// Only server-type sessions populate this (CLI bridges do not emit
	// queue_update), so CLI steers are not cancellable from the web.
	pendingSteering: string[];
	// Skill commands available for the active session, for the composer's
	// `/skill:<name>` autocomplete. Each `name` is the full invocation without
	// the leading slash (e.g. "skill:setup"). Requested on session_ready and
	// replaced outright by each skills_list; empty for CLI bridges or before the
	// list arrives.
	skills: SkillCommand[];
}

export interface SkillCommand {
	name: string;
	description?: string;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

// A parsed `/skill:<name> <args>` invocation. `skillName` is the bare skill
// name; `args` is the trailing text the user typed after `/skill:<name>` (empty
// when none).
export interface SkillInvocation {
	skillName: string;
	args: string;
}

// Recognize a `/skill:<name> <args>` invocation in EITHER form and return its
// parsed parts, or null when the content is not a skill invocation.
//
// Two forms carry the same logical invocation and must be treated as one:
//   - RAW: what the client sends and optimistically echoes, e.g.
//       `/skill:setup do the thing`
//   - EXPANDED: what the server stores/echoes back after pi inlines the skill
//     body (pi's _expandSkillCommand), e.g.
//       `<skill name="setup" location="...">\n...body...\n</skill>\n\ndo the thing`
// Both resolve to { skillName: 'setup', args: 'do the thing' }. This lets the
// delivery-confirmation match the optimistic RAW echo to the server's EXPANDED
// echo (same invocation) instead of appending a duplicate and orphaning the
// optimistic bubble as "failed".
export function parseSkillInvocation(
	content: string,
): SkillInvocation | null {
	if (!content) return null;
	const trimmed = content.trimStart();
	// Expanded form: the stored/echoed skill block.
	const open = trimmed.match(/^<skill\s+name="([^"]*)"[^>]*>/);
	if (open) {
		const closeIdx = trimmed.indexOf('</skill>');
		if (closeIdx === -1) return null;
		return {
			skillName: open[1],
			args: trimmed.slice(closeIdx + '</skill>'.length).trim(),
		};
	}
	// Raw form: the `/skill:<name> <args>` the user typed / the client sent.
	if (trimmed.startsWith('/skill:')) {
		const rest = trimmed.slice('/skill:'.length);
		const spaceIdx = rest.indexOf(' ');
		const skillName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
		if (!skillName) return null;
		const args = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
		return {skillName, args};
	}
	return null;
}

// A stable identity string for a skill invocation, or null when `content` is not
// one. Equal identities mean the RAW and EXPANDED forms are the same invocation.
// The NUL separator cannot appear in either the name or the args.
export function skillInvocationIdentity(content: string): string | null {
	const parsed = parseSkillInvocation(content);
	if (!parsed) return null;
	return `skill:${parsed.skillName}\u0000${parsed.args}`;
}
