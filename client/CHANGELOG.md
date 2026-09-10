# @wherever-dev/client

## 0.6.0

### Minor Changes

- 5214eb8: Creating a new session that CLONES an existing remote now runs through the path-keyed restore registry, with live progress instead of a blocking overlay, and the old synchronous clone is gone.

  Creating a session in a folder that does not exist could already clone the remote the provider probe found, but it did so synchronously behind the "Creating session..." overlay: no progress, no submodules, and a 25-second client watchdog that gave up while git was still running, which made a large repository effectively un-clonable. That clone is now the same job the restore panel drives, so there is ONE clone implementation left in the codebase.
  - **Cloning here is now RECURSIVE** (`--recurse-submodules`), which it was not before. A session created this way lands with its submodule content present rather than with empty submodule directories discovered later. Upstream tracking is still configured on the resulting clone, as it always was.
  - **Real progress, no watchdog.** The server answers `session_new { cloneRemote: true }` with `restore_started` and then the ordinary `restore_progress` / `restore_complete` frames; the dashboard shows the same honest progress display as the restore panel (phase, scope, a real percentage or an explicitly indeterminate bar, submodules counted separately) and disarms the create watchdog while the job is watched. A multi-minute clone no longer strands the UI.
  - **The server continues into creation itself** once the job is `done`. Unlike the restore panel, this path has nothing to reload: the session does not exist until the clone lands, so the flow completes itself rather than asking the user to retry.
  - **A failed or cancelled clone fails the create** with the registry's mapped cause (no key this host accepts, host missing from `known_hosts`, repository not found, network) on `session_error`, and leaves no half-made session. The clone stays cancellable while it runs, through the ordinary `restore_cancel` frame, because the job is server-owned and keyed by the target path.
  - **`POST /session/new` takes the same branch** for `cloneRemote`, gaining recursion; having no progress channel, it simply waits for the job.
  - **The synchronous `cloneRemoteRepo()` helper is DELETED** and `SessionPool.createNewSession` no longer takes `cloneRemote`: by the time it is called the folder is there. Creating a NEW remote repository (the other branch of the clone-or-create dialog), creating a session in a folder that already exists, and the plain create-the-folder path are all unchanged.
  - The shared client package carries `RestoreInfo.forSessionCreate`, which marks a restore that is the first step of a session create, so a client can tell "watch this and then hand back to the create" apart from the panel's "restore, then reload".

- 84fc5a9: Restore a session's missing working folder from the dashboard: tap Clone, watch it honestly, cancel it, survive a dropped connection, and come back to a live session.

  A folder-missing session now shows a RESTORE PANEL in place of its composer: the missing absolute path, an editable URL pre-filled from the server's remote candidates (`GET /remote-candidates`, so a repository can be restored from a phone without typing one), a Clone button, live progress, Cancel while it runs, and on success a Reload that brings the session back live. This is the user-facing half of the path-keyed restore registry, wired over the WebSocket.
  - **New frames**, all namespaced `restore_*` and all addressed by TARGET PATH (never by session id, because the job's key is the path). Client to server: `restore_start { targetPath, action, url?, gitInit? }` and `restore_cancel { targetPath }`. Server to client: `restore_started` (with `outcome: 'started' | 'joined'` and the url really in flight), `restore_rejected` (refused before anything was spawned: no job, no completion coming), `restore_progress` and `restore_complete` (which carries every terminal state -- `done`, `failed` or `cancelled`). `folder_missing` now also carries any `job` already running for the path.
  - **Subscription is DERIVED, not registered**: progress reaches every client whose attached session cwd, pending load target, or folder-missing path MATCHES the job path, evaluated per frame. A phone that drops mid-clone and reconnects repaints the RUNNING job from the `folder_missing` frame and keeps receiving live progress, with no second clone and no leaked bookkeeping. A second device sees the same job, and its Clone tap JOINS it and is told which URL is actually being cloned rather than being silently answered as though its edited URL had won.
  - **A restore in flight now counts as folder-missing.** `git clone` creates the target directory in its first breath, so the plain existence check said "present" for the whole of a multi-minute clone and a client loading in that window was handed a live agent pointed at a HALF-CLONED tree. A session whose folder has a running restore job is locked read-only with no agent built, exactly like one whose folder is absent, and the send refusal says "still being restored" instead of "does not exist".
  - **Honest progress, per story 8**: the phase, the scope (the repository or a named submodule), and either a real percentage or an explicitly indeterminate bar -- never a fake unified number. Submodules are shown under their own scope with a standing note that each is counted separately.
  - **Failures explain themselves**: the mapped cause (no key this host accepts, host missing from `known_hosts`, repository not found, network) with git's raw output available underneath, and a refused request (a target outside the home directory, a non-empty folder, a URL outside the SSH/`file://` allowlist) says why and leaves the panel offering to try again.
  - The shared client package carries the new frames as `WhereverState.restore` (`RestoreInfo` / `RestoreJobInfo` / `RestoreProgressInfo` / `RestoreFailureInfo`) plus `startRestore()`, `cancelRestore()` and `reloadSession()`. Older clients degrade safely: they do not render the panel, and the server's refusal to accept their sends is what protects them.

  Restoring ends in a RELOAD by design: whether a session has a live agent is a load-time decision, and the load that found the folder missing built none. See the new `CONTEXT.md` section and `docs/adr/0009`.

## 0.5.4

### Patch Changes

- fcd3d23: Make conversation mode's spoken reply actually happen: the agent is now TOLD, per turn, that a spoken conversation is active, so it adds a short `say` reply to its written answer instead of staying silent. "Conversation mode is on" only ever lived in the web client, and a dictated message is byte-identical to a typed one, so the agent had no signal and (following the `say` tool's own guidance) defaulted to not speaking, which made the feature inert unless the user nagged it every turn.

  The signal is an OPTIONAL `conversationMode` boolean FIELD on the EXISTING `message` WebSocket payload (no new message type, no new chat role; an absent field means false, so older clients keep working). The web app stamps it, on both the send and the resend path, only when the master `conversationMode` AND `speakReplies` knobs are both active. For a turn whose message carried the flag, a `before_agent_start` hook APPENDS one line to the assembled system prompt asking for a short spoken `say` reply in addition to the written answer; the hint is per-turn (the mode can flip mid-session) and ephemeral (it is a system-prompt addition, so the user's message is preserved verbatim, nothing extra renders on web or CLI, and only the resulting `say` call is visible). It is wired for BOTH session types, mirroring the `say` tool's dual registration: an inline pi extension on the server's own agent sessions, and a `pi.on("before_agent_start", ...)` handler in the `@wherever-dev/pi` extension fed by the flag relayed on `cli_message`, so a bridged terminal session driven from a phone speaks too. With conversation mode (or speak-replies) off, no flag is sent, nothing is injected, and behaviour is exactly as before.

  The `say` tool description/guidelines (server and extension, in lockstep) no longer tell the agent to stay silent when "the user is typing", which was the instruction fighting the feature; `say` is now framed as an additive short spoken layer for an active spoken conversation.

## 0.5.3

### Patch Changes

- c1bd6c6: Fix a slow-loading session suddenly replacing the one you switched to. While a session was still loading, tapping a different session in the sidebar could let the old session's late reply clobber the one you were now looking at. The client now stamps every `session_load` with its target file and rejects a stale `session_created` / `message_history` for a session it already switched away from (the latest tap wins), so a superseded load can no longer take over the active view or strand the loading spinner.

## 0.5.2

### Patch Changes

- fe17675: Relicense the project from MIT to AGPL-3.0-only. The root `LICENSE` file now contains the verbatim GNU Affero General Public License v3.0 text. Documentation (`README.md`, `CONTEXT.md`) and the marketing site footer now reference AGPL-3.0, and the published packages (`wherever-dev`, `@wherever-dev/client`, and the extension `@wherever-dev/pi`) declare `"license": "AGPL-3.0-only"`.

## 0.5.1

### Patch Changes

- 3c035f6: Fix a `/skill:<name>` invocation showing up as TWO messages: the raw optimistic echo (which then flipped to "Not delivered / Retry" and persisted across reloads) plus the transformed skill chip. The client optimistically echoes the raw `/skill:...` invocation, but the server confirms it with a raw `message_ack` and later echoes back the expanded `<skill>` block, so exact-content delivery matching missed and appended a duplicate. Delivery confirmation now matches the raw optimistic bubble to the expanded server echo by skill-invocation identity (name + args) and rewrites it in place, so there is a single confirmed skill chip. Adds shared `parseSkillInvocation` / `skillInvocationIdentity` helpers to `@wherever-dev/client` (now used by the web instead of a local copy).

## 0.5.0

### Minor Changes

- d9df862: Show web `!command` / `!!command` (force command) bash tool calls INSTANTLY again instead of only after a server round-trip. Since the `!sudo` change, `!`-commands no longer add any local user echo — the bash tool-call render (driven by the server's `tool_start`) is the only feedback — so nothing appeared until the full client → server → `tool_start` → client hop completed, making force commands feel laggy.

  The client now renders an OPTIMISTIC bash tool bubble the moment a `!`/`!!` command is sent (correct `$ bash command="..."` label, `forceCommand`, live "Elapsed" timer), tagged `optimistic` so it is NOT delivery-tracked (no watchdog/retry banner) and is reconciled — not duplicated — when the server's real `tool_start` arrives (FIFO match on the oldest pending optimistic bubble, so back-to-back `!`-commands line up correctly). `!sudo ...` is intentionally excluded from the optimistic bubble because the server defers it behind a password prompt and only emits `tool_start` once the password arrives. A stuck optimistic bubble (e.g. the turn ends before any `tool_start`) is still finalized as interrupted by the existing agent_end/aborted sweep.

## 0.4.0

### Minor Changes

- 6a95014: Client: surface an actionable error when the WebSocket handshake keeps being rejected instead of silently reconnecting forever. The server rejects a missing or wrong token with HTTP 401 during the WS upgrade, which a browser WebSocket can only observe as an opaque 1006 close, so the dashboard previously just showed `reconnecting to relay (attempt N)` with no hint of the cause. The client now tracks whether it has ever connected; after a couple of failed attempts with zero successful opens it sets a clear error ("the connection is being rejected... missing or wrong token, or wrong host/port/scheme...") while still retrying. A drop after a successful connection is still treated as a normal transient reconnect.

## 0.3.4

### Patch Changes

- 8addff3: Auto-clone an existing remote when creating a session in a not-yet-cloned project. Previously, starting a session in a non-existing folder that matched a `remoteRepoRules` pattern always tried to CREATE the remote (`gh repo create` / `tea`/`cb repo create`); if that repo already existed on the host, the create failed and the session was left as an empty local folder with no `origin`. Now, at submit time (not on every keystroke), the server probes the provider using the same authenticated CLI and owner it would use to create (`gh repo view` for GitHub, `tea`/`cb` listing for Codeberg/Gitea/Forgejo). If the repo is found, the dashboard asks whether to clone it (preferring the SSH remote) or create a new one anyway; cloning runs `git clone <ssh-url>` into the target folder and pre-configures upstream tracking. When no matching remote exists, behavior is unchanged and it falls back to the normal create path (any probe/CLI failure is also treated as "does not exist"). `WhereverClient.createSession` gains an optional trailing `cloneRemote` argument.

## 0.3.3

### Patch Changes

- 11c4dc8: Fix a crash that could take down the pi CLI (not the wherever server) when a session was torn down while the client's WebSocket was still connecting, typically when the wherever server is not running. Calling `close()` on a socket that is still in the `CONNECTING` state makes `ws` abort the handshake and emit an `'error'` event asynchronously on the next tick; because `disconnect()` had already removed every listener, that error became an unhandled `EventEmitter` error and surfaced as an `uncaughtException` ("WebSocket was closed before the connection was established"), exiting the process. The existing try/catch could not help since the error was emitted asynchronously rather than thrown synchronously. `disconnect()` now attaches a no-op `'error'` sink to the socket it is tearing down (in both the node `ws` and browser `WebSocket` environments) so the late handshake-abort error is swallowed instead of crashing pi.

## 0.3.2

### Patch Changes

- 4836b65: Fix dangling tool calls being hoisted to the end of the transcript on the web frontend, showing as a phantom "series of aborted tool calls" after the latest reply.

  When loaded history contained a tool call with no matching tool result (e.g. an interrupted long-running `bash` that was superseded by a new user turn, then more replies), the web history mapping deferred every unmatched tool call and appended them all AFTER the last mapped message. So dangling calls from the MIDDLE of the conversation piled up below the latest assistant reply, even though the CLI (and the actual transcript) has them inline where they were issued. The reproducing session was a deliberate recoverability test ("Generate a long message..."/"long running tool call using bash sleep" then interrupting it).

  The mapping now renders each tool call IN PLACE at its position in the stream: a result-less tool message is emitted when the tool call is seen, and its matching tool result fills it in later (oldest-open-first per tool name, preserving the parallel-call FIFO behaviour). A call that never receives a result stays exactly where it was issued, correctly marked `interrupted` (neutral "no result" state), instead of migrating to the end. On the live streaming tail, only the newest still-open call is kept streaming ("Elapsed" ticking); earlier open calls in the window are interrupted.

  Tests: two new client tests covering (1) a mid-conversation dangling call staying in place with the final message still an assistant reply, and (2) multiple dangling calls where only the newest streams on the live tail while earlier ones are interrupted in place. All existing tool abort/interrupted/duration tests still pass.

- 12083e5: Render an aborted tool call as interrupted, not a red error.

  When you hit the web "abort" button while tools are running, pi kills the in-flight tools and surfaces each as an errored result with a trailing "...aborted" status ("Command aborted" for bash, "Operation aborted" for edit/write). The web then rendered that as a red error tick, as if the tool had genuinely failed. With parallel tool calls this was especially confusing: a tool that happened to finish just before the abort showed a green success tick while the killed one showed a red error, even though the user aborted the whole turn.

  The client now detects an abort result (an errored result whose trailing status line is "...aborted") and renders it with the neutral "interrupted" state (muted icon, neutral border) instead of a red error, on both the live tool_end path and when reconstructing from loaded history. A tool that genuinely completed keeps its green success, and a genuine failure keeps its red error. The match is anchored to the trailing status line, so ordinary command output that merely contains the word "aborted" is not misclassified.

  Also fixes a related mismatch with PARALLEL same-named tools. Live tool_end frames were matched to a tool message by name via a last-match search, so with two concurrent bash calls both tool_end frames could land on the same message, leaving the other tool stuck streaming; it was then finalized by the agent_end sweep with no result and shown as a bogus green success tick. tool_end now claims the OLDEST still-streaming tool of that name (FIFO), so each concurrent call settles a distinct message. And any tool still streaming when the turn ends (agent_end) is now marked interrupted rather than left to render green, since its outcome is unknown.

  Also adds a `tool-calls` (parallel tool_use) behavior to the test fake LLM to exercise concurrent tool execution.

- db16623: Render `read`-tool image output inline in the web frontend, mirroring the CLI's inline image display.

  When the agent uses the builtin `read` tool on an image path, the pi tool result carries an image content block (`{type:'image', data, mimeType}`) alongside the text note. Previously the server's `extractToolResult` kept only text blocks, so the web never saw the image. The server now also pulls image blocks out of the tool result and ships them (base64 + mimeType) on the `tool_end` frame via a new optional `images` field, and reconstructs them from history when a session is reloaded. The client stores them on the `ChatMessage` (`images`), and the web renders each image inline right under the tool header, always visible (not hidden behind the collapse toggle), while the textual arguments/output stay collapsible. Click an image to open it full size. Text-only tools are unaffected.

- 9931867: Pair reconstructed tool results to their exact tool call by id, not just by tool name.

  The server now forwards the tool-call id on both `tool_call` (the id the assistant issued) and `tool_result` (the `toolCallId` it satisfies) history messages, and the web history mapping matches a result to its exact call by that id, falling back to the previous oldest-open-first per-tool-name behaviour only when no id is present (older sessions, or the synthesized `bashExecution` pair).

  This fixes mis-pairing when same-named calls interleave with some left dangling: e.g. two `bash` calls issued back-to-back where only the second returns a result. Name-FIFO alone would resolve the first call and leave the second dangling; id matching resolves the correct one and leaves the genuinely-interrupted call marked interrupted, in place.

  Tests: a new client test covering id-exact pairing (result resolves call #2 by id, leaving call #1 dangling/interrupted, order preserved).

- 8536f30: Warn both the web frontend and the CLI when a CLI takeover discards an in-flight turn.

  When a `pi` CLI resumes/registers a session while the standalone server is mid-turn for a web viewer, the CLI seizes control and the server disposes its live agent. Disposing mid-turn discards the whole in-flight turn without persisting it (persistence only happens on turn completion), so the web viewer, who was watching a tool run or a reply stream, lost it silently with no explanation.

  The server now detects that the server-side agent was mid-turn at takeover and sends the attached web clients a non-fatal `session_notice` (level: warning). The web frontend renders it as a dismissible banner. The wording is tailored to what was lost: a running tool call (tracked via a per-session in-flight tool-execution count, so its result never arrives) or a streaming reply (the partial text is discarded and not saved). A takeover of an already-settled (idle) session is not flagged. The session stays attached (informational, unlike `session_interrupted`).

  The notice also states the takeover semantics accurately: once the CLI has taken over it owns the session's execution loop, so messages sent from the web frontend are relayed to the CLI rather than wresting control back. The web frontend regains control only when the CLI disconnects.

  The CLI side is covered too. On register, the server sends the taking-over CLI a `cli_takeover_interrupted` message, and the Wherever extension surfaces a single matching notice. This closes a blind spot: a still-streaming turn is never persisted, so the extension's own resumed-mid-tool-call check (which reads the saved transcript) cannot see the streaming-text case. For the tool-call case, the extension's transcript check already warns with the tool names, so the server-driven notice defers to it to avoid a duplicate.

  Also fixes the web frontend rendering a killed-then-orphaned tool call as a green success tick. When a CLI takeover kills an in-flight tool (the pi SDK aborts the run and SIGKILLs the tool's process tree, so it does not keep running in the background), the transcript keeps a dangling toolCall with no toolResult. The web history mapping now flags such a result-less, non-streaming tool call as `interrupted`, and the UI shows a neutral "interrupted, no result" state (a muted ⊘ icon, neutral border, and an explanatory output note) instead of the green ✅ "Succeeded": its outcome is genuinely unknown, neither success nor failure.

  Also cleans up the CLI's resumed-mid-run warning (the extension's dangling-tool-call widget):
  - It now counts only the TRAILING dangling tool calls (those after the last user message on the active branch), not every unsatisfied tool call in the whole session. Earlier turns' interrupted tool calls are already superseded by a later human turn and do not block auto-continue, so they were over-counted (e.g. "4 tool calls" when only 1 was actually blocking).
  - It shows a single persistent widget instead of a widget plus a duplicate transient notify.
  - Its guidance is corrected: the CLI has already taken over, so it says to send a message to retry or continue, rather than the stale "send a message to take over".

## 0.3.1

### Patch Changes

- 333f6ad: Never silently lose a message when the connection drops mid-send; confirm delivery and recover it on reload.

  A frame handed to a socket that reports OPEN can still never reach the server (a half-open TCP connection: `send()` buffers locally and does not throw, but the bytes never land). The optimistic echo was treated as delivered, the input was cleared, and on reload the message was gone with no way to recover it.

  Outbound user messages are now tracked as `delivery: 'sending'` until the server echoes them back (`message_end` role:user), at which point they are confirmed. If no echo arrives within a window, the message flips to `delivery: 'failed'` and the UI surfaces "Not delivered" with Retry / Discard instead of a normal-looking sent message. Unconfirmed messages are persisted per session, so a reload reconciles them against the loaded history: anything the server actually persisted is shown as delivered, and anything it did not is re-surfaced as a recoverable failed message (never silently dropped). New client APIs: `resendMessage(id)` and `discardMessage(id)`.

- 9368269: Show how long each tool call has been running, like the pi CLI.

  A running tool now shows a live-ticking "Elapsed N.Ns" and, once it finishes, "Took N.Ns" (one decimal, matching the CLI's bash duration format). The client reducer stamps `startedAt` on `tool_start` and `endedAt` on `tool_end` (new `ChatMessage` fields), and freezes a still-running tool's `endedAt` if the turn ends or is aborted without a `tool_end`, so the timer stops instead of counting up forever. The web UI ticks only while a tool is actually running (no per-frame work on an idle session).

  Durations also survive a reload/reconnect: history mapping pairs each `tool_call` with its `tool_result` and derives `startedAt`/`endedAt` from their timestamps (no server change needed), so a tool restored from loaded history shows the same "Took N.Ns" as a live-streamed one.

## 0.3.0

### Minor Changes

- f17f262: Make opening a session fast, and add the deterministic fake-LLM integration gate.

  Opening a session no longer blocks on building the live agent. Previously `session_load` awaited `createAgentSession` (which resolves extensions and connects MCP servers, seconds of work, occasionally hanging past the client's load watchdog) before sending anything, so returning to an idle-evicted session was slow and could time out. Now the server reads the session header + transcript cheaply and sends `session_created` (with a new `pending` flag) + `message_history` immediately, then builds the agent asynchronously and sends a new `session_ready` message. The client renders and lets you scroll the conversation right away; only the composer stays disabled (with a "Preparing the session agent..." banner) until the agent is ready. A failed cold build degrades to readable-but-not-sendable instead of a hard load failure. Warm (still-resident) sessions skip the pending phase entirely.

  Also raised the default session idle-eviction window from 5 to 20 minutes (`PI_IDLE_TIMEOUT`, ms) so a dip-in/dip-out user usually returns to a warm session with no agent rebuild at all.

  Foundation: promoted the fake-LLM test substrate (ADR 0001) into `server/test/` and wired `vitest` into the `server` and `client` packages, giving a deterministic, offline integration gate (real server + real pi + fake Anthropic-Messages SSE server). New coverage: server integration tests for fast-first load and a client reducer test for the pending/ready lifecycle.

  Protocol: `session_created` gains an optional `pending` flag and there is a new `session_ready` server message. Both are additive and backward compatible (an older client that ignores them simply treats the load as before, seeing history once and the composer enabled on `session_created`).

### Patch Changes

- f615141: Fix three frontend session-lifecycle bugs and add the first client unit tests.
  - Creating a new session no longer spins the blocking "Creating session..." overlay forever when the server reply is lost (slow git init / remote-repo creation, a half-open socket, or an error before the reply is sent). A create watchdog now mirrors the existing load watchdog: it clears the overlay and surfaces a recoverable error instead of forcing a reload.
  - Returning to the app (PWA/mobile) after a background suspend no longer flashes the new-session / search empty-state or the big "Not connected" panel over an already-loaded conversation. `suspend()` now correctly reflects the disconnected state so `resume()` actually rejoins in place (it was silently no-op'ing on a stale connected flag and falling through to a session-dropping reconnect). The chat view keeps the cached messages visible during a reconnect, with a thin "Reconnecting and syncing session..." banner over the composer; the sidebar and top-bar search stay usable, and only sending into that one session is blocked.
  - An UNSOLICITED socket drop (tab switch, network blip, laptop sleep, half-open reap) no longer silently detaches the frontend from a still-running session. Previously the reconnect neither re-issued `session_load` nor preserved the cached session, so the relay reconnected but the session stream was dead: the UI froze on a stale tool call with "Abort" disabled and no "connecting"/"loading" hint while the agent kept working headless, recoverable only by reload. Now the auto-reconnect preserves the cached conversation, shows the resyncing banner during the backoff, re-attaches to the active session on open, and restores the true streaming state (re-enabling Abort) from the server.
  - Added `vitest` to the `client` package with unit tests covering the create watchdog, the suspend/resume-keeps-session invariants, and unsolicited-reconnect re-attachment.

## 0.2.2

### Patch Changes

- cf11972: Stop silently losing (or wrongly queueing) a message sent right after returning to a backgrounded/idle tab.

  Two related failures, both rooted in the suspend/resume-on-background path:
  - Lost message: `send()` silently dropped any frame issued on a non-OPEN socket (null / CONNECTING / CLOSING / half-open), so a message typed during the reconnect+resync window rendered locally but never reached the server and was gone after reload. `send()` now reports whether the frame actually went out, and `sendMessage()` checks the real socket `readyState` (via `getIsConnected()`, not the laggy store `connected` flag) and only commits the local echo + clears the error after the frame is confirmed sent; on failure it surfaces a recoverable "not connected, your message was not sent" error, ensures a reconnect is scheduled, and returns `false`. `sendMessage()` now returns a success boolean so the composer only clears the textarea on a real send: a dropped send keeps the typed text intact for retry instead of losing it.
  - Cannot send while disconnected + clear status: the chat composer is now disabled when the socket is not connected (previously only gated on having a session, so you could press send into a dead socket). The placeholder and the existing status line now show "Reconnecting to remote server..." / "Disconnected - cannot send" so the connection state is visible.
  - Wrongly queued, never drained: `isStreaming` could stay stuck `true` across a suspend/resume (the `agent_end` that would clear it arrives on the now-dead socket), so the composer queued the next message as if the agent were still busy, and the queue never drained. `suspend()` now clears the stale `isStreaming` (the authoritative value is re-established by `session_created` on rejoin), `disconnect()` cancels any pending `agent_end` clear timer so it cannot fire against a fresh connection, and the composer only queues when streaming AND connected (and only auto-drains the queue when connected), falling through to a clear error otherwise.

- 605693a: Fix the sidebar getting stuck on "Loading session..." when switching sessions, where the previous session would close but the sidebar stayed open over a hanging spinner and tapping other sessions appeared to do nothing.
  - client: add an atomic `switchSession()` that leaves the current session (if any) and loads the target in a single step. The UI previously did `leaveSession()` then `joinSession()` separated by a 100ms `setTimeout`; that gap could strand the loading state if a tap landed mid-switch or a leave's follow-up load never fired. `switchSession()` always (re)arms the load watchdog for the new target, so a superseded or lost load can never strand the UI and the latest tap always wins.
  - client: shorten the session-load watchdog from 20s to 12s so a genuinely stuck load surfaces a recoverable error (and frees the UI) sooner.
  - web: the sidebar now closes as soon as a load is in flight (loading/resync), not only once the session id is set. A stalled load no longer leaves the sidebar open on top of the spinner.
  - web: the sidebar session click and the URL-hash change handler both use the atomic `switchSession()` path, removing the fragile leave -> setTimeout -> join dance.

- f9080e1: Fix a "Loading session..." spinner that could hang forever, and stop losing a typed message during session resync.

  Stuck loading state (hash auto-join, sidebar selection, and tab-return after >8s):
  - web: only take the resume (preserve-cache, rejoin-in-place) path when a session was actually suspended; otherwise do a plain `connect()` so the hash auto-join drives the load.
  - web: make the hash auto-join self-healing by gating on live state (active session id + loading/resync flags) instead of a latched guard that connect/disconnect churn could strand, and debounce the join via a single tracked timer.
  - client: add a session-load watchdog. The loading/resync flags are set the moment a `session_load` is issued and cleared when `message_history` (or an error/conflict/disconnect) arrives; if none ever comes back (a lost reply, a half-open socket, or any unforeseen edge), the watchdog now clears the flags and surfaces a recoverable error instead of spinning forever. Armed for the sidebar/hash join and the resume-on-reconnect path alike.
  - client: add `hasSuspendedSession()` so callers can choose resume vs. plain connect.

  Lost message draft during resync:
  - web: keep the composer (ChatInput) mounted during reconnect/resync instead of swapping it for a status line, showing a thin "Reconnecting and syncing session..." banner above a disabled input so the in-progress text stays in the live DOM.
  - web: also persist the draft to localStorage and restore it on (re)mount, so the typed message survives even a full unmount or reload. The draft is cleared automatically on a successful send. Drafts are scoped per session, with the no-session search composer getting its own shared draft: switching contexts does not carry text over (the box swaps to the target's own draft, or empties), and returning to a session (or back to search mode by closing the session or hitting the search button) brings its draft back.

- caabb92: Keep the session cached when the tab is backgrounded instead of reloading it on return.

  Previously, backgrounding the tab disconnected and reset the whole client state, so coming back re-fetched and re-rendered the entire session (a visible "reload"). Now the connection is suspended without dropping the cached messages/session: the client records the active session, reconnects preserving the store, and rejoins+resyncs that session in place.

  While reconnecting and resyncing, the composer is replaced by a "Reconnecting and syncing session..." status line so no message can be sent until the socket is back and history has resynced.

  Also fixes the session error banner: long error text now wraps and scrolls within a bounded area instead of pushing the dismiss (X) button off-screen.

## 0.2.1

### Patch Changes

- 37de34b: Extract core client WebSocket and state management logic into a dedicated, framework-agnostic `@wherever-dev/client` monorepo package. Update both the web dashboard (`@wherever-dev/web`) and the CLI extension (`@wherever-dev/pi`) to use the new shared client, reducing duplicate code and establishing a modular architecture for future integrations.
- ffd28c7: Speed up loading of long sessions with tail-first history windowing. On load/join, the server now sends only the most recent messages (with a total count and offset) instead of the entire history in one payload, and the web dashboard shows a "Load older messages" button that lazily fetches earlier windows (with scroll-position anchoring). This adds `history_load_more` / `message_history_prepend` to the protocol and a `loadMoreHistory()` method plus history pagination state to `@wherever-dev/client`.
