# wherever-dev

## 0.14.0

### Minor Changes

- bf90aed: Make "this session's folder does not exist on this machine" an explicit, safe, explained state instead of a silently broken one.

  Transcripts and the folders they refer to travel separately: a transcript syncs (syncthing, a backup, a new laptop), the git clone it talks about does not. Opening such a session used to look fine and then quietly hand you a live agent pointed at a directory that is not there: pi's `SettingsManager.create()` and `DefaultResourceLoader.reload()` both succeed against a nonexistent cwd, so nothing threw and the first sign of trouble was every file and bash tool misbehaving for no stated reason.
  - The cheap session-meta read now also answers whether the working folder EXISTS (one `stat`, beside the read-only verdict it already computes from the cwd), so both the warm and the cold load path share the answer.
  - When it does not exist, the transcript still paints (reading never needed the folder), the client is marked read-only, and the cold path does **not** build the live agent at all. There is no `session_ready`, so the composer stays disabled.
  - New `folder_missing` frame (plus a `folderMissing` flag on `session_created`) carries the **absolute** missing path, and the dashboard replaces the composer with a notice naming it. The shared client package mirrors it as `WhereverState.folderMissing`.
  - A message sent anyway is refused out loud, naming the path, instead of being dropped in silence.
  - Read-only precedence is now explicit and lives in one predicate: a configured `sessions.readOnly` folder is hard and never lifted, a missing folder is hard and lifted only by restoring the folder and reloading, and a folder conflict remains the only dismissible one. "Continue anyway" can no longer lift a missing-folder lock.
  - Detection is load-time only, deliberately: a session that is already RESIDENT when its folder is found missing is locked read-only for anyone loading it, but its running agent is left alone.

  Older clients degrade safely: they simply do not render the notice, and the server's own refusal is what protects them. The restore ACTIONS (clone/create with progress) are separate, later work; until they land this state is locked with no in-app remedy, which is strictly better than an agent running against a directory that is not there. See the new `CONTEXT.md` sections and `docs/adr/0009` / `0010`.

- 5214eb8: Creating a new session that CLONES an existing remote now runs through the path-keyed restore registry, with live progress instead of a blocking overlay, and the old synchronous clone is gone.

  Creating a session in a folder that does not exist could already clone the remote the provider probe found, but it did so synchronously behind the "Creating session..." overlay: no progress, no submodules, and a 25-second client watchdog that gave up while git was still running, which made a large repository effectively un-clonable. That clone is now the same job the restore panel drives, so there is ONE clone implementation left in the codebase.
  - **Cloning here is now RECURSIVE** (`--recurse-submodules`), which it was not before. A session created this way lands with its submodule content present rather than with empty submodule directories discovered later. Upstream tracking is still configured on the resulting clone, as it always was.
  - **Real progress, no watchdog.** The server answers `session_new { cloneRemote: true }` with `restore_started` and then the ordinary `restore_progress` / `restore_complete` frames; the dashboard shows the same honest progress display as the restore panel (phase, scope, a real percentage or an explicitly indeterminate bar, submodules counted separately) and disarms the create watchdog while the job is watched. A multi-minute clone no longer strands the UI.
  - **The server continues into creation itself** once the job is `done`. Unlike the restore panel, this path has nothing to reload: the session does not exist until the clone lands, so the flow completes itself rather than asking the user to retry.
  - **A failed or cancelled clone fails the create** with the registry's mapped cause (no key this host accepts, host missing from `known_hosts`, repository not found, network) on `session_error`, and leaves no half-made session. The clone stays cancellable while it runs, through the ordinary `restore_cancel` frame, because the job is server-owned and keyed by the target path.
  - **`POST /session/new` takes the same branch** for `cloneRemote`, gaining recursion; having no progress channel, it simply waits for the job.
  - **The synchronous `cloneRemoteRepo()` helper is DELETED** and `SessionPool.createNewSession` no longer takes `cloneRemote`: by the time it is called the folder is there. Creating a NEW remote repository (the other branch of the clone-or-create dialog), creating a session in a folder that already exists, and the plain create-the-folder path are all unchanged.
  - The shared client package carries `RestoreInfo.forSessionCreate`, which marks a restore that is the first step of a session create, so a client can tell "watch this and then hand back to the create" apart from the panel's "restore, then reload".

- eecb694: Add the server-side restore engine: a path-keyed registry of restore jobs that materialise a missing working folder, either by cloning a remote or by creating an empty folder. It is a standalone module (`server/src/restore-jobs.ts`) with its own tests and is wired to nothing yet; the WebSocket protocol, the dashboard panel and the re-point of the existing create-session clone are separate work.
  - Jobs are keyed by the resolved absolute TARGET PATH, not by socket or session (`docs/adr/0009`), so a clone survives a dropped phone connection, is shared by two tabs, and is never started twice for one folder. A second request for a running path coalesces onto that job and is told the URL actually in flight, so a requester whose edited URL differs is never silently answered as though their own URL was accepted.
  - Clones are RECURSIVE (submodules) and report live progress. Git rewrites one progress line in place, so the parser splits on carriage returns as well as newlines; each frame carries a phase, a scope, and either a percentage or an explicit indeterminate marker, and submodules are scoped to themselves rather than folded into one fake global percentage. The previous synchronous helper did neither, and the create-session path's 25-second client watchdog is why asynchrony and progress matter.
  - Unsafe input is refused before anything is spawned: the target must resolve inside the home directory, the leaf must be absent or empty, and the URL must match a shape allowlist (scp-style SSH, `ssh://`, plus `file://` for fixtures) rejecting control characters, newlines and a leading dash. The clone runs through an argv array with no shell, and never carries a relaxation of git's file-transport protection.
  - SSH only, with the missing credential NAMED rather than worked around (`docs/adr/0010`): interactive prompts are disabled (no terminal prompt, no askpass, batch-mode SSH with a connect timeout) so an unprovisioned box fails fast instead of hanging at zero percent, and git's well-known signatures are mapped onto actionable causes (no key this host accepts, host absent from `known_hosts`, repository not found stated as both wrong-URL and no-access, network rather than credentials) while git's raw stderr is kept underneath.
  - Cancel is authoritative: the child is signalled, the job settles as cancelled, and the target directory is removed only when the job created it.
  - A second, trivial job kind creates the folder (with an optional `git init`) so callers drive one state machine rather than two, and the module owns an explicit subscription seam (progress plus terminal outcome, with unsubscribe) for its two coming consumers: the client broadcast and a per-folder existence-cache invalidation.

- 84fc5a9: Restore a session's missing working folder from the dashboard: tap Clone, watch it honestly, cancel it, survive a dropped connection, and come back to a live session.

  A folder-missing session now shows a RESTORE PANEL in place of its composer: the missing absolute path, an editable URL pre-filled from the server's remote candidates (`GET /remote-candidates`, so a repository can be restored from a phone without typing one), a Clone button, live progress, Cancel while it runs, and on success a Reload that brings the session back live. This is the user-facing half of the path-keyed restore registry, wired over the WebSocket.
  - **New frames**, all namespaced `restore_*` and all addressed by TARGET PATH (never by session id, because the job's key is the path). Client to server: `restore_start { targetPath, action, url?, gitInit? }` and `restore_cancel { targetPath }`. Server to client: `restore_started` (with `outcome: 'started' | 'joined'` and the url really in flight), `restore_rejected` (refused before anything was spawned: no job, no completion coming), `restore_progress` and `restore_complete` (which carries every terminal state -- `done`, `failed` or `cancelled`). `folder_missing` now also carries any `job` already running for the path.
  - **Subscription is DERIVED, not registered**: progress reaches every client whose attached session cwd, pending load target, or folder-missing path MATCHES the job path, evaluated per frame. A phone that drops mid-clone and reconnects repaints the RUNNING job from the `folder_missing` frame and keeps receiving live progress, with no second clone and no leaked bookkeeping. A second device sees the same job, and its Clone tap JOINS it and is told which URL is actually being cloned rather than being silently answered as though its edited URL had won.
  - **A restore in flight now counts as folder-missing.** `git clone` creates the target directory in its first breath, so the plain existence check said "present" for the whole of a multi-minute clone and a client loading in that window was handed a live agent pointed at a HALF-CLONED tree. A session whose folder has a running restore job is locked read-only with no agent built, exactly like one whose folder is absent, and the send refusal says "still being restored" instead of "does not exist".
  - **Honest progress, per story 8**: the phase, the scope (the repository or a named submodule), and either a real percentage or an explicitly indeterminate bar -- never a fake unified number. Submodules are shown under their own scope with a standing note that each is counted separately.
  - **Failures explain themselves**: the mapped cause (no key this host accepts, host missing from `known_hosts`, repository not found, network) with git's raw output available underneath, and a refused request (a target outside the home directory, a non-empty folder, a URL outside the SSH/`file://` allowlist) says why and leaves the panel offering to try again.
  - The shared client package carries the new frames as `WhereverState.restore` (`RestoreInfo` / `RestoreJobInfo` / `RestoreProgressInfo` / `RestoreFailureInfo`) plus `startRestore()`, `cancelRestore()` and `reloadSession()`. Older clients degrade safely: they do not render the panel, and the server's refusal to accept their sends is what protects them.

  Restoring ends in a RELOAD by design: whether a session has a live agent is a load-time decision, and the load that found the folder missing built none. See the new `CONTEXT.md` section and `docs/adr/0009`.

- 8a4fb9f: Mark folders that do not exist on this machine in the session browser, so a freshly migrated machine shows the scale of what still needs restoring without opening every conversation.
  - `GET /sessions` stamps each folder with `missing: true` when its cwd is not a directory on this machine. It is a SECOND, orthogonal per-folder fact beside `readOnly`: read-only is a configured policy, missing is a fact about the disk and is curable by a restore, and the dashboard renders them differently (a **Missing** chip on the folder, never the read-only treatment).
  - The check costs one `stat` per DISTINCT folder path, cached for 10s, never one per session: the listing can cover thousands of sessions and the dashboard refetches it on every `sessions_updated`, so a naive per-session check would put a syscall storm back into the pass the listing cache exists to keep free of IO.
  - Completing a restore invalidates that folder's cached answer (by subscribing to the restore job registry directly, not through the WebSocket layer) and asks connected dashboards to refetch, so the chip disappears without a manual refresh. A folder that reappears by other means (cloned by hand in a terminal, a mount coming back) loses its chip within the cache window on its own.

  The listing's ordering, its ignore and read-only filters, and everything else about the response are unchanged.

- ee71bd3: Answer "which repository is this missing folder?" with an ordered list of SSH candidates, served on demand from a new authenticated `GET /remote-candidates` endpoint so the restore panel can pre-fill an editable URL instead of asking for one to be typed on a phone.
  - Two sources, in decreasing confidence (`server/src/remote-candidates.ts`): the PROVIDER PROBE (the folder matches a configured `remoteRepoRules` entry, so the provider CLI the create-session path already uses is asked whether the repository exists and its SSH URL is taken), then the PATH CONVENTION (`<...>/<host-token>/<owner>/<repo>` read back into `git@host:owner/repo.git`). The convention is what covers repositories owned by SOMEONE ELSE, which the probe structurally cannot find and which dominate a machine migration where one rule covers one personal namespace. Neither source produces anything: an honestly empty list, and the user pastes a URL.
  - SSH only (`docs/adr/0010`): an HTTPS candidate is never synthesised, and a probe result that is not an SSH URL is dropped rather than offered. Candidates are ADVISORY -- the server clones what it is finally given (after the restore job validates it), not what it guessed.
  - A probe failure of any kind (CLI missing, not authenticated, repository absent, a throw) degrades to the derived candidate instead of erroring. A folder no rule covers is never probed at all, so nothing shells out on the common path.
  - Known host tokens are `github`, `codeberg` and `gitlab`, plus any token that is already a dotted hostname (`git.example.com`). An unknown token yields no candidate rather than a confidently wrong one, as does a path too shallow to carry an owner and a repo.
  - The endpoint sits beside `/check-remote-repo`, behind the same token gate, and refuses a path outside the home directory like `/check-path` does. It is called on demand (the panel opening), never per keystroke and never on the session-load path, because the probe shells out.
  - Remote-repo rule matching is now one implementation (`matchRemoteRepoRule`), shared by `/check-path`, `/check-remote-repo` and the resolver.

### Patch Changes

- 77a7f37: Gate file uploads behind the read-only verdict, honour tilde-written remote-repo rules at session-creation time, and fix the port race that made the server suite flake.
  - **`file_upload` is now refused on a read-only session.** An upload writes a file to disk, so it is a write capability, but the handler never consulted `client.readOnly`: a client on an observe-only session could not send a message referencing an attachment yet could still drop the attachment itself into the upload directory. It is now refused for every read-only reason (a configured `sessions.readOnly` folder, an uncontinued folder conflict, a missing folder), and refused **out loud** with a `file_upload_error` rather than silently, for the same reason a refused message answers: a client only hides its composer when it agrees it is read-only, so a desync has to be visible instead of swallowed.
  - **A `remoteRepoRules` pattern written as `~/dev/github/me/` now matches when the session is actually created.** Rule matching in `session-pool.ts` used a bare `new RegExp(pattern)` while the HTTP layer expanded a leading `~`, so a rule written the natural way matched in `/check-path` and `/check-remote-repo` — the checks the new-session dialog runs — but not at creation time, and the promised remote was silently skipped. It now goes through the shared `matchRemoteRepoRule`, which also treats an invalid pattern as a non-match rather than throwing.

  Test-suite reliability (no production behaviour change):
  - **Fixed the port TOCTOU race behind the suite's flakiness.** The two helpers that spawn a real server picked a port by binding to `0`, reading the assigned port, closing the socket, and only then spawning the child — leaving a window in which the port belonged to nobody and another concurrent spawn could be handed the same one. That produced two failures that looked unrelated but were one bug: a server that never bound (`server did not become healthy`), and, worse, a test whose requests reached **another test's** server and got a correct answer to the wrong question (a 401 where a 200 was expected, because that server had a different token). The second shape is why raising timeouts never fixed it — nothing was slow, the request went somewhere else. Port allocation now lives in one place (`server/test/free-port.ts`) and gives each vitest worker a disjoint band below the OS ephemeral range, tracking every port already issued, so two workers cannot collide by construction.
  - **Bounded test concurrency** (`maxWorkers`), since most files boot a real server and vitest otherwise forked one worker per core, putting tens of processes in contention. The suite got _faster_ as a result (~97s vs ~133–186s).
  - **Removed two remaining timing assumptions**: the three heavy `session-transcript` cases assert memory, not elapsed time, but relied on the default 5s timeout while writing tens of MB, so they carry an explicit one; and the `conversation-mode-hint` lockstep test now freezes the clock instead of deep-equalling two independently stamped `Date.now()` values, which only passed when both landed in the same millisecond.

  No API or protocol changes.

- 4bc44ce: Restore panel: create the folder instead of cloning, with a git-init checkbox that honours the configured default.

  The second remedy for a folder-missing session, for the case where the folder was never a clone (a scratch directory, a folder whose contents only ever lived on the old machine): make it. It reuses the clone's machinery rather than forking it, so there is ONE flow, not two.
  - **Same job, same frames, same state machine.** Create is the existing path-keyed restore job's `create` kind driven over the existing `restore_start { action: 'create', gitInit }` frame: the directory and any missing parents are made, a git repository is optionally initialised, and the panel lands in the same ready-and-reload state a completed clone does. The same safety rules apply, because they are the same guards: the target must resolve inside the home directory, and an existing non-empty target is refused before anything is created.
  - **The checkbox is the CONFIGURED git-init default** (`gitInitDefault`, the same value the new-session dialog reads), never a second restore-only default, so a user who turned it off does not get a surprise repository. The panel refreshes `GET /config` when it opens for a folder rather than depending on the session browser having done so, and the choice travels explicitly in both states.
  - **Deliberately SECONDARY.** The common case is a repository that exists remotely, so Create sits behind a disclosure with a secondary button rather than beside Clone: an accidental tap makes an empty folder that then looks restored, while the non-empty guard refuses the clone that should have happened.
  - The panel is now kind-aware in its running, cancelled and progress wording, and drops the submodule note and the scope label for a create, which has exactly one scope.

  Tests cover both checkbox states at the WebSocket seam against the resulting filesystem state (a git repository with it on, a plain directory with it off), plus the shared refusals, with the server run against a temp `HOME` and isolated git config.

## 0.13.0

### Minor Changes

- 70257b6: Make the server deployable from a READ-ONLY config directory, with no secret on the command line. Everything here is purely additive: with the new variables unset, every path and every behaviour is identical to before.
  - **`WHEREVER_STATE_DIR`** splits "where config is READ" from "where the server WRITES". It **defaults to the config directory**, so an existing install (or a test setting only `WHEREVER_CONFIG_DIR`) is unaffected and there is no migration. `drafts.json` and the auto-generated self-signed `certs/` pair move under it. That is the complete list of things the server writes into the config directory — uploads are _not_ among them, since `uploads.subDir` resolves against the session's own `cwd`, not the config dir.
  - **The certs directory now honours the override.** It was built from `os.homedir()` directly, so `WHEREVER_CONFIG_DIR` did not move it and an isolated server still wrote into the developer's real `~/.wherever`.
  - **`WHEREVER_TOKEN` / `WHEREVER_TOKEN_FILE`** supply the auth token without putting it in argv, where `ps` shows it to every user on the machine. Precedence, highest first: `--token` → `WHEREVER_TOKEN` → `WHEREVER_TOKEN_FILE` (a file whose contents are the token, the shape sops-nix and systemd `LoadCredential=` produce) → `PI_REMOTE_TOKEN`. The two **new** sources are whitespace-trimmed (a secret file ends with a newline); the two **pre-existing** ones are taken verbatim, and `--token` still wins whenever the flag is given even with an empty value, so no install can have the string that authenticates change under it. A `WHEREVER_TOKEN_FILE` that is set but missing/unreadable/empty is a **fatal startup error**, because falling through to "no token" would silently run an unauthenticated server that looks healthy.
  - **`WHEREVER_SSL_KEY` / `WHEREVER_SSL_CERT`**, each resolved independently, so a key from a secret manager and a certificate from ACME can live in completely different places, neither tied to a home directory. A leading `~` is expanded (a systemd `Environment=` line is not shell-expanded). Supplying only one half now warns instead of silently discarding it.
  - The startup banner reports the token's _source_, never the token. A token variable that is set but **blank** warns loudly (that is what a half-rendered secret looks like), as does binding a non-loopback address with no token at all.
  - The token is **deleted from the server's own environment** once resolved, so the children it spawns — the agent's `bash` tool and the memonaut indexer, both of which inherit `process.env` — cannot read it. Previously `!env` in the dashboard printed the server's auth token into a stored transcript.
  - **Explicitly-configured TLS that fails to load is now fatal instead of falling back to plaintext HTTP.** This is the one deliberate behaviour change: the old code caught the error, logged it, and served unencrypted on the same (often `0.0.0.0`) address, so clients sent their token in cleartext to a server that looked healthy — the same fail-open the token-file rule exists to prevent, and the exact shape of a secret that has not decrypted yet. The silent HTTP fallback survives for the self-signed pair the server mints for itself; use `--no-ssl` to ask for plaintext on purpose.
  - **Nix packaging**: `package.nix` (a plain function of `pkgs`, the interface a deployment repo imports with its own nixpkgs pin) plus a `flake.nix` providing `nix develop` (the exact node/pnpm toolchain, replacing a hardcoded version-manager path) and `nix build`. `nix/check-pnpm-deps-hash.sh` fails loudly when `pnpmDepsHash` goes stale, which a plain build cannot detect.
  - `web/svelte.config.js` honours `WHEREVER_BUILD_VERSION`, so a build with no `.git` reports a real build id instead of a timestamp.

  Also fixed while here: the Nix build never built the `@wherever-dev/client` workspace package, so it only succeeded on a tree where `client/dist` happened to exist from an earlier manual build and would have failed from a clean checkout.

  See `docs/deployment-nixos.md`, and ADRs 0006 / 0007 / 0008.

## 0.12.0

### Minor Changes

- c805329: Add saved drafts: keep a message instead of sending it, then load it back later from any device.

  The composer footer gains "💾 Save draft" (keeps the typed message and clears the box, the way a send would) and "🗂 Drafts (N)", which opens a list of saved drafts, newest first, with a one-line preview, when it was saved and the folder it was written in. Tapping one loads it into the message box; 🗑 deletes it.

  **Drafts live on the server**, not in the browser: `~/.wherever/drafts.json`, behind the same token gate as the other API routes, via new `GET /drafts`, `POST /drafts` and `POST /drafts/delete` endpoints. A draft saved on a phone is therefore there on the laptop, and survives clearing site data or restarting the server. The server is the only writer (it owns ids, dedupe, cap and ordering, and answers every mutation with the whole new list); the browser keeps a mirror only so the list still renders while disconnected. Saving fails loudly rather than silently, and the message stays in the box.

  **Drafts work in every composer mode**, including the no-session home page, which is exactly where you want to pull up something written yesterday and fire it into a new session. They are global rather than per session, for the same reason.

  **Loading a draft never destroys unsent text:** if the box is not empty the list warns first and offers Replace, Append below (keeps both, separated by a blank line) or Cancel. **Loading does not delete the draft, but sending it does** (mail-client semantics): a mistap must not lose the text, while a message that has actually been sent is no longer a draft. The draft is only consumed when the sent message is still exactly it, optionally below text you typed; edit it further and the draft is kept.

  The store fails safe throughout: over-long input is rejected rather than truncated, an unreadable or corrupt `drafts.json` is reported instead of being treated as "you have no drafts" (so a save can never overwrite a file it could not read), writes are atomic and 0600, and the composer is only cleared once the server confirms it has the text.

  This is separate from the existing per-session auto-draft, which remains client-side crash protection for the text currently in the box.

## 0.11.2

### Patch Changes

- a5723a8: Stop the test harness leaking a server process per test file. `startHarness()` spawned the server as `pnpm exec tsx ...` and tore it down with `child.kill('SIGTERM')`, but that signal reached only `pnpm`: the real server sat two levels down (`pnpm` -> `tsx/cli.mjs` -> `node`), so it survived teardown and was reparented to init. A full suite run therefore left ~50 MB of orphaned server behind per test file. Run inside the memory-capped `wherever` systemd service, this filled the cgroup with 141 leaked processes holding ~5.5 GB, pinning it at 98% memory pressure and 8.3 GB of swap: the service never OOM-killed (so `Restart=on-failure` never fired) and instead livelocked in permanent reclaim, presenting as a hang indistinguishable from a crash.

  The harness now invokes the `tsx` binary directly (no signal-swallowing intermediary), spawns it `detached` so it leads its own process group, and `cleanup()` signals the entire group and awaits the actual exit, escalating `SIGTERM` -> `SIGKILL` if the process is wedged. The group kill matters beyond the removed `pnpm` layer, since `tsx` itself spawns an inner `node` child that a bare `child.kill()` would strand. A `process.on('exit')` backstop reaps any still-live server, covering the abnormal path where a test throws or the runner kills the worker and `cleanup()` never runs.

- 8d458d3: Fix "new conversation here" landing you back in an existing conversation.

  Asking for a new session in a folder that already had a live viewer did not create anything: the server attached you read-only to the session already running there and raised the "another client is active in this folder" banner. The conversation you were handed was often the one you were already reading (any second tab, or your own socket that dropped silently and has not been reaped yet, counts as another viewer), and "Continue anyway" could only unlock that old conversation, never give you the new one you asked for.

  `session_new` now always creates a new session (`SessionPool.createNewSession(..., forceNew)` bypasses the reuse-an-occupied-folder shortcut). When the folder really is shared, the folder-conflict banner is raised on the NEW conversation, which starts read-only until "Continue anyway" - so the warning stays, but it now sits on the conversation you asked for. `POST /session/new` keeps its old reuse behaviour.

  Also stops a second viewer of the SAME conversation being counted as a folder conflict, which could pin the banner (and its read-only) on with nothing left to resolve it.

## 0.11.1

### Patch Changes

- 01b0601: Allow attaching files to the first message of a web search. The search composer (shown when no session is open) now has the 📎 button: picked files are held in the browser, uploaded as soon as the search creates its session, and referenced from the query as `[Uploaded file: ...]` lines. A search with files but no text is valid, upload failures still send the query and surface as a session error, and files are dropped if the composer leaves search mode. The uploaded-file message shape is now a shared, unit-tested helper (`web/src/lib/core/attachments.ts`) used by both the chat and search paths.
- a42ea5c: fix(web): wrap long tokens in still-streaming (plain-text) messages

  An assistant message that is still streaming is deliberately rendered as plain text (markdown is only parsed once the message is final, so the DOM stays stable and a selection survives), but that plain-text block had no `overflow-wrap`, unlike the finalized `.markdown-body` view. A single unbreakable token (a long file path, a URL) therefore pushed the rest of its line past the bubble and off-screen on a narrow viewport, so an in-progress reply looked like it was missing words until it finalized and re-rendered wrapped. The streaming block now uses `wrap-anywhere`, matching the finalized rendering; the same guard was added to the user/thinking plain-text bubbles and to skill-invocation args.

## 0.11.0

### Minor Changes

- 53f438b: Conversation search: find anything ever said in any session, and jump into it.
  - **Server**: new `GET /search?q=<FTS5>&view=default|readonly&limit=` (same token gate as the other API routes), backed by the [memonaut](https://github.com/wighawag/memonaut) index (`~/.local/share/memonaut/index.db`). Opened strictly read-only; wherever never writes to it. Results carry the absolute transcript path normalized exactly like `/sessions`, so a hit is directly clickable into the existing session view, and every fork carrying a match in shared history is returned (most recently active first, with per-thread `+N after` counts) instead of being collapsed to one.
  - **Never blocks the event loop**: the endpoint never builds or syncs the index in-process (memonaut's indexer is synchronous, ~40 s on a real corpus, which would freeze every WebSocket client). A missing index answers `status: "not-indexed"` telling you to run `recall index`; incremental catch-up is delegated to a TTL-gated child process, fired after the response and never awaited (`conversationSearch.autoSync` / `conversationSearch.syncIntervalMs` in `~/.wherever/config.json`).
  - **Privacy**: the two axes compose in one place. memonaut's `private` transcripts are never returned, and wherever's `sessions.ignore` sessions are dropped from search on every view, so search can never surface what the dashboard hides; `sessions.readOnly` folders mirror `/sessions` and stay on the read-only view.
  - **Web**: a "Search conversations" panel in the sidebar (and from the read-only page), with highlighted snippets, fork-aware result grouping and click-through to the session. The existing session-list filter box is unchanged, plus a "Search all conversations for …" hand-off.

### Patch Changes

- c478478: Order sidebar fork groups by their most recent activity across forks.

  Session groups were ordered by the top-most parent's own `modified` time, so a session forked long ago and worked on all day stayed buried under its stale root, making the active fork hard to find. Each fork group (a root plus its descendants) is now ranked by the newest `modified` in its whole subtree, and siblings are ranked the same way, so an active branch floats its group to the top while the parent/child tree shape is preserved. Ties fall back to the session's own `modified` then its path for a deterministic order.

  The tree builder moved out of `SessionBrowser.svelte` into `web/src/lib/core/fork-tree.ts` with unit tests.

- 63626f9: Stop loading whole session transcripts into memory: startup RSS on a 2 GB sessions directory drops from ~990 MB peak / 426 MB settled to 208 MB, and opening a large session no longer ratchets memory (or blocks the event loop).

  The server read session `.jsonl` files by materializing them. The `/sessions` listing scan did `readFile(utf8)` + `split('\n')` + `JSON.parse` per line into a retained array, per file, and it runs at startup to warm the cache; every history read (`session_load`, `history_page`, `cli_register`) went through pi's `SessionManager.open()` (which loads and parses the whole file twice) and then mapped EVERY entry into a `HistoryMessage[]`, base64 tool images included, only to slice the last 60 off the end. On a real corpus (3,831 files / 2.0 GB, single transcripts up to 62 MB) that is hundreds of MB of transient objects per pass, and V8 never gives the heap high-water mark back, so the process grew until systemd-oomd killed it.

  All of it now goes through a new streaming reader (`server/src/session-transcript.ts`) that finds newlines in the bytes, classifies each line from a bounded 512-byte head, and only ever materializes what the caller asked for. Tool results (most of a transcript's bytes) are counted and discarded without becoming strings. History is read as two bounded passes: one counts (and supplies the header, the current model and the total), the second stops as soon as the requested window is full, so paging back through a long session costs the same as reading its tail. `registerCliSession` reads the 8 KB header instead of the whole file for a session id. A file that cannot be read is skipped with a log line instead of failing the whole listing.

  Measured on the same 2.0 GB corpus, built server, identical methodology:
  - startup: peak RSS 990 MB -> 208 MB, settled 426 MB -> 208 MB (an empty sessions dir is 164 MB, so the corpus costs ~44 MB instead of ~260 MB)
  - opening the largest session (59 MB, 1,780 messages): 401 ms of blocked event loop and ~130 MB RSS growth per open -> 71 ms, non-blocking; 150 consecutive opens plateau at ~340 MB with live heap flat at 39 MB (40 opens on the old path alone reached 825 MB)

  Also in this change:
  - New optional listing retention, both off by default and applied from the file's `stat` before any body is read: `sessions.maxAgeDays` and `sessions.maxSessions` in `~/.wherever/config.json`. Nothing is deleted and excluded sessions still open by path or short ID; they just are not listed. The server prints a one-line hint at startup when it lists more than 1,000 sessions with neither set.
  - `wherever install` now bakes `MemoryHigh=1G` / `MemoryMax=1500M` into the systemd unit, so a memory problem can only take down (and auto-restart) that unit instead of pushing the whole machine into swap thrash. Tune with `--memory-high` / `--memory-max`, or drop them with `--no-memory-limits`; install prints how to verify systemd actually applied them (it silently ignores them without memory-controller delegation). launchd has no equivalent, so this is Linux-only.
  - Fixed a race the streaming reads exposed: "Continue anyway" clicked immediately after a cold `session_load` was dropped when it landed before the load had recorded its cwd, leaving the client read-only with the banner's button already gone. The intent is now recorded regardless and re-evaluated at attach (the `sessions.readOnly` guard still applies).
  - An unanswered `!sudo` password prompt (client vanished mid-prompt) is no longer retained forever: it is dropped when its session is evicted, and any entry past a 30-minute TTL is swept when the next prompt is armed.

## 0.10.15

### Patch Changes

- 2f4e67c: Fix "New Session Here" sometimes redirecting to the folder's already-active session as read-only, with no way to continue. Two separate bugs.

  **1. A reconnect was counted as a second viewer.** A client whose socket dropped silently (phone sleep, wifi/cellular switch, any half-open TCP) reconnects on a new socket with a fresh server-side client id, while its previous record stays attached to the session until the heartbeat reaper notices, up to a minute later. During that window `session_new` saw "another viewer holds this folder" and, by design for real conflicts, attached the client read-only to the existing session instead of creating a new one. Connections now carry an optional stable `clientKey` (`/ws?token=...&clientKey=...`); on connect the server retires any still-registered viewer with the same key, detaching it from its session before any further traffic is handled. The web client derives one key per browser TAB from `sessionStorage`, so two real tabs still count as two viewers and genuine folder conflicts behave as before. CLI bridges are untouched (their own registration path handles takeover). Because duplicating a tab clones `sessionStorage`, two live tabs can end up sharing a key: the server now tells the retired connection (`connection_superseded`, flushed before the socket is destroyed) and the client takes a fresh key before reconnecting, so they converge instead of evicting each other. The VS Code webview carries a key of its own too.

  **2. The folder-conflict banner destroyed its own "Continue anyway" button.** Attaching as a read-only observer puts the client on the occupant's session FILE, but the live `folder_conflict` broadcast scanned for another session file in the folder while skipping the client's own, so it immediately reported `active: false`. The client dropped the banner, taking the only escape hatch with it, and stayed read-only with nothing left to lift it. A conflict is now tracked per client, so the update keeps reporting `active` while the occupant is there, and it carries the server's authoritative `readOnly`, which also releases the composer automatically once the conflict resolves. The generic read-only banner is suppressed while the DISMISSIBLE conflict banner is up, since that one explains the cause and carries the action; a read-only that survives a continue (a hard `sessions.readOnly` folder) still explains itself.

  **3. "Continue anyway" could be silently lost.** Clicking it during a cold session load, i.e. after the conversation is painted but before the agent finishes building and the client is attached, resolved no session, so the click was dropped; and the build's completion path then re-imposed the read-only it had computed before the click. Either way the composer looked enabled while the server dropped every send with no error. The continue is now recorded as a durable intent, honoured at attach whatever the ordering, answered with an authoritative `folder_conflict` on the same socket (which also settles a broadcast that was already in flight), and restated explicitly once the cold build attaches.

  **4. Read-only sends are refused out loud.** A message rejected because the session is read-only was dropped with no reply at all, so any desync between the client's belief and the server's authority showed up as text vanishing. It now answers with a `session_error`, which the client surfaces as a recoverable, retryable failure.

## 0.10.14

### Patch Changes

- c1c26f4: Security hardening: command injection, eruda DOM-XSS, and path-scoping fixes.
  - **Command injection in remote-repo provisioning (critical):** all `gh`/`tea`/`cb`/`git` calls in the session pool now use `execFileSync` with argument arrays instead of `execSync` with interpolated shell strings. A client-supplied folder basename could previously break out of a quoted shell argument (e.g. `x";touch /tmp/pwned;"`) and run commands as the server user when `remoteRepoRules` was configured. The `tea`/`cb` `… | grep` pipelines were rewritten to read CLI output and match in JS. The `openssl` self-signed-cert generation was converted too.
  - **Unauthenticated route:** `/check-remote-repo` (the only reach that fired the injection without a token) is now behind the auth gate.
  - **eruda DOM-XSS (high):** the dashboard's eruda custom-plugin loader took `?eruda=<pkg>` and wrote it unescaped into a `<script src>`, letting a crafted link inject attacker JS that could read the auth token from `localStorage`. Plugin loading is now gated behind a `<meta name="wherever-eruda-plugins">` flag that is `false` in the built shell and only flipped to `true` when the server runs with `--debug` (or `PI_DEBUG`/`WHEREVER_DEBUG`). Core eruda still loads for phone debugging.
  - **`/session/delete`:** now scoped to `.jsonl` files inside the server's sessions directory, so an authenticated caller can no longer `unlink` arbitrary `.jsonl` files anywhere on disk.
  - **`/check-path` and `/autocomplete-path`:** now scoped to the home directory, so they can no longer be used to enumerate arbitrary paths on the server.
  - Added a `--debug` server flag (and `PI_DEBUG`/`WHEREVER_DEBUG` env vars) that enables eruda custom-plugin loading in the served dashboard for local debugging.

## 0.10.13

### Patch Changes

- 84c89c1: Fix the shrunken Android home-screen PWA icon and remove the fragile PWA post-process.

  The installed app icon had been shrinking over time to a tiny logo on a white
  circle because the deployed build shipped pwag's raw manifest (no maskable
  icon): the hand-rolled `pwa-postprocess.mjs` failed silently when ImageMagick
  was missing on the build machine, and `prepare`'s `|| echo ''` swallowed the
  error.
  - Use pwag 0.6.0 native maskable icon generation (`maskable: true`): padded,
    fully-opaque maskable icons at 192/512 with `purpose: "maskable"`, plus
    explicit `purpose: "any"` on the regular icons — generated via `sharp`, with no
    ImageMagick dependency.
  - Use pwag 0.6.0 native `screenshots` support: sources under `pwa-assets/` are
    copied into `static/pwa/` and emitted in the manifest with auto-detected
    sizes/type.
  - Delete `web/scripts/pwa-postprocess.mjs`; `generate-pwa-icons-and-tags` is now
    a single `pwag static/logo.svg src/web-config.json` invocation.
  - `prepare` no longer swallows failures, so a broken PWA build fails loudly
    instead of shipping a raw manifest.

## 0.10.12

### Patch Changes

- 6c3ea26: Conversation Mode is now per CONVERSATION, and the hands-free mic re-opens on both speech engines.

  **Per-conversation mode.** The 💬/🗣️ toggle above the composer used to flip one global flag, so turning conversation mode on while talking to one session turned it on everywhere, and every other session started stamping "a spoken conversation is active" on its messages too. A spoken back-and-forth is a property of the conversation you are having, not of the app. The toggle now sets the conversation you are in and leaves the others alone, exactly like the waiting-for-human beep's per-session control: the setting in Connection Settings became the DEFAULT for conversations you have not toggled, a conversation with no choice of its own follows that default live, and one you have toggled keeps its own choice. With no conversation open the toggle edits the default, since there is nothing else it could mean. The individual knobs (speak replies, collapse long replies, hands-free mic re-open) stay global: they describe how a spoken conversation behaves, while only whether THIS conversation is spoken is per conversation.

  **Hands-free on the cloud engine.** "Re-open mic after the agent speaks" only ever auto-recorded on the browser speech engine; on the Cloud AI engine it just re-focused the composer, so a phone user (the most likely to be on that engine) still tapped the mic every single turn, which is the tap the knob exists to remove. The confirmation belongs in the config the user already set, not in a per-conversation gesture, so the mic now re-opens on both engines. What the cloud engine actually lacked is a stop condition, since it records until told to stop: an auto-opened recording now ends itself after about two seconds of silence once you have spoken, gives up after six if nobody speaks at all, and can never run past a one-minute ceiling. Recordings you start by tapping are untouched: your next tap is still the stop.

- 6c3ea26: Make conversation mode actually speak, instead of only when the user asks it to.

  The per-turn conversation-mode signal (telling the agent a spoken conversation is active) was reaching the model, but only as one line appended to a long system prompt, and that turned out to be a coin flip. Measured against the local 35B a reported session ran on, with a realistic system prompt: with the hint 3/6 turns called `say`, without it 1/6, and at the moment that matters most, the synthesis call right after a tool result, the hint was ignored almost every time. Two things defeat it: the line sits far from the tail, and once the transcript contains earlier assistant turns that did not speak, the model imitates its own history. The result was the reported symptom, an agent that stayed silent unless nagged every turn.

  Three changes, from the model outwards:
  - **The signal now also rides the TAIL of every LLM call.** On top of the system-prompt line, a short reminder is added via pi's `context` event, which fires before EVERY provider call of the turn (including the post-tool-result one) rather than once per user prompt. It is ephemeral by construction: the SDK applies the handler to a clone on the way to the provider, so nothing reaches the session file, the web transcript or the CLI TUI. Placement is role-safe (it rides inside a clone of a `user`/`toolResult` tail rather than opening a second consecutive user turn, which Anthropic merges but Bedrock and some proxies reject), and it stops the moment the agent has actually called `say` in that turn, so it can neither nag nor drive a `say` loop.
  - **Spoken replies no longer depend on the model complying at all.** When a turn settles with spoken replies active and no `say` was spoken, the web app now speaks a short plain-text lead-in of the written reply (code fences, links, bare URLs and markdown markers stripped, cut to whole sentences). The agent's own `say` line always wins when there is one, and the written transcript is never modified.
  - **Mobile priming no longer depends on tapping one specific control.** Browsers gate the first `speechSynthesis.speak()` of a page behind a user gesture, and the existing priming points (the Conversation Mode toggle, the mic button, settings-save) all assume the user touches one of them in that page load. A returning user whose conversation mode is already persisted ON touches none, so on a phone every reply was dropped while desktop spoke fine. Priming now also happens from the user's first gesture of any kind, the priming utterance is silent but no longer blank (mobile Chrome discards a blank one without consuming the activation it was issued under), and a configured speech locale the engine has no voice for is dropped rather than set, since that is another known way to get silence on mobile.

## 0.10.11

### Patch Changes

- 823b39a: Show the server version next to the web app build id. The connection panel already displayed the frontend build (the short git commit baked in at build time), but there was no way to tell which server version that frontend was actually talking to, which made it easy to debug a stale server as if it were a frontend bug.

  The server now reports its package version in the `connected` WebSocket message, the client keeps it in state as `serverVersion` (null until connected, or when the server is old enough not to report it), and the connection panel renders it as `v<build> / srv <version>` with both spelled out in the tooltip.

## 0.10.10

### Patch Changes

- 5a3e325: Show messages that are still queued as mid-stream steers after a reload. A message sent while the agent is streaming is queued by pi and injected at the next step, but until then it lives only in the agent's memory: it is not in the session file, so a reloaded client painted history with no trace of it. The text simply disappeared from the UI while the agent still had it and went on to act on it.

  Attaching to a session (`session_load`, which also serves reload and reconnect resync) now replies with a `queue_update` snapshot of the current steer queue, and the client re-materializes any queued message its history does not contain, so it renders with the "Queued (not yet sent to the agent)" badge and stays cancellable. When the queued message is finally injected, the server's echo reconciles onto that bubble instead of appending a duplicate.

- c7b9999: Fix a session opened from a URL hash deep link (`https://host/#<sessionId>`) hanging forever on "Loading session...", while the same session opened instantly from the sidebar.

  The sidebar joins a session by FILE path, but the URL hash carries the session ID. `session_load` accepts either (the server resolves an ID to its file) yet always replies with the resolved file path. The client's superseded-load guard matched a `session_created` reply against the pending load target by file path only, so an ID-issued load never recognised its own reply: it was dropped as a stale/superseded load, no session ever became active, and the hash-driven spinner never cleared. The pending load target now matches its reply by session file OR session ID, while still rejecting late replies for genuinely abandoned loads.

## 0.10.9

### Patch Changes

- d831cdf: Fix session loading getting stuck while the console fills with `/sessions` requests.

  `GET /sessions` rebuilt the whole session list from scratch on every request: a synchronous `readFileSync` + per-line `JSON.parse` of EVERY session `.jsonl` on disk. On a real sessions directory (~2,800 files / 1.1 GB / 341k JSON lines) that is ~6.9s of work on the single Node thread, so the WebSocket could not deliver `session_created` / `message_history` for the session being opened. The list was also refetched constantly, because the server broadcast `sessions_updated` on every `message_end` (per message, many per turn) and every client answered each broadcast with a full-list fetch. Together: a flood of multi-second requests, an event loop pinned by them, and a "Loading session..." spinner that could hang past the client's 12s load watchdog.
  - **Cached, incremental scan** (`scanDiskSessions`): each file's parsed listing info is cached against its `(mtime, size)` stamp, so a repeat scan only re-reads what actually changed; the folder cwd probe is cached per directory; entries for deleted sessions are evicted. Cold pass ~6.9s, warm pass ~90ms.
  - **Non-blocking**: the scan is fully async and yields to the event loop between parses (worst measured event-loop lag during a cold pass: 29ms, vs the whole ~7s previously). Concurrent requests for the same view share one pass, and the cache is warmed in the background at startup.
  - **Fewer broadcasts**: `sessions_updated` now fires on `agent_end` only (not `message_end`) and is leading+trailing throttled at 2s, so structural changes stay instant but bursts collapse into one broadcast. Deleting a whole folder no longer triggers one full-list refetch per deleted session.
  - **No stranded promise**: `fetchSessions()` queued a resolver on the in-flight path that nothing would ever settle, so `await fetchSessions()` during an in-flight fetch could hang forever.
  - **Quieter logs**: the per-request `/sessions` log line now only appears when a pass did real parsing work.
  - **Lower memory**: the capped first-message preview is flattened, so caching it cannot pin the full (often huge) first message via a V8 sliced string (~33 MB retained -> ~3 MB).
  - **Test isolation**: `WHEREVER_CONFIG_DIR` overrides the config directory, and the harness sets it, so an isolated test server no longer reads the developer's real `~/.wherever/config.json` (whose `sessions.ignore` could hide the harness's own sessions).

  Also resolves a session by short ID/name through the same cached scan instead of `SessionManager.listAll()`, which re-read every session file just to resolve one deep link.

- de08e13: Fix `/skill:` composer autocomplete being empty on a freshly created session. The client only asked the server for the session's skill commands (`skills_request`) when it received `session_ready`, but `session_ready` is only sent by the session-LOAD path (it signals "the cold agent finished building"). A brand-new session created via `session_new` is live the moment `session_created` arrives and never emits `session_ready`, so the request was never sent and `state.skills` stayed `[]`: typing `/` in a fresh session showed no menu, while the same session offered the full list after a reload.

  The client now sends `skills_request` as soon as the agent is known to be live: on `session_created` when `pending !== true` (fresh create, and warm attach), and still on `session_ready` for a cold load that was `pending`. Re-requesting is harmless since the server always replies with the full list, and the per-session reset of `skills` on attach is unchanged, so switching sessions cannot leak another session's commands. Covered by `client/test/skills-autocomplete.test.ts`.

## 0.10.8

### Patch Changes

- fcd3d23: Make conversation mode's spoken reply actually happen: the agent is now TOLD, per turn, that a spoken conversation is active, so it adds a short `say` reply to its written answer instead of staying silent. "Conversation mode is on" only ever lived in the web client, and a dictated message is byte-identical to a typed one, so the agent had no signal and (following the `say` tool's own guidance) defaulted to not speaking, which made the feature inert unless the user nagged it every turn.

  The signal is an OPTIONAL `conversationMode` boolean FIELD on the EXISTING `message` WebSocket payload (no new message type, no new chat role; an absent field means false, so older clients keep working). The web app stamps it, on both the send and the resend path, only when the master `conversationMode` AND `speakReplies` knobs are both active. For a turn whose message carried the flag, a `before_agent_start` hook APPENDS one line to the assembled system prompt asking for a short spoken `say` reply in addition to the written answer; the hint is per-turn (the mode can flip mid-session) and ephemeral (it is a system-prompt addition, so the user's message is preserved verbatim, nothing extra renders on web or CLI, and only the resulting `say` call is visible). It is wired for BOTH session types, mirroring the `say` tool's dual registration: an inline pi extension on the server's own agent sessions, and a `pi.on("before_agent_start", ...)` handler in the `@wherever-dev/pi` extension fed by the flag relayed on `cli_message`, so a bridged terminal session driven from a phone speaks too. With conversation mode (or speak-replies) off, no flag is sent, nothing is injected, and behaviour is exactly as before.

  The `say` tool description/guidelines (server and extension, in lockstep) no longer tell the agent to stay silent when "the user is typing", which was the instruction fighting the feature; `say` is now framed as an additive short spoken layer for an active spoken conversation.

- c6ed2bb: Stop the agent from speaking when conversation mode is OFF: the `say` tool's own text no longer invites it to decide for itself whether a spoken conversation is active. Since the per-turn conversation-mode signal (ADR 0004) became the authoritative "a spoken conversation is active, add a `say` reply" instruction, the tool description's standing "while a spoken conversation is active" condition was a second, unreliable trigger: the agent could infer "active" from a chatty exchange or dictated-sounding text and call `say` with the mode off.

  The description, `promptSnippet` and `promptGuidelines` now split the concerns cleanly: the tool text owns HOW (an additive one-or-two-sentence plain-spoken reply on top of, never instead of, the written answer, no code/markdown/lists), while the injected per-turn hint owns WHETHER. `say` is to be called ONLY when the instructions for THIS turn explicitly state that a spoken conversation is active, that instruction is the only signal there is, and absent it `say` is never called. Both copies (`server/src/say-tool.ts` and the `@wherever-dev/pi` extension's `registerTool` block) are updated identically, and `server/test/say-tool.test.ts` now parses the extension source so the twins cannot drift.

  This is guidance, not a hard gate (the tool is still registered when the mode is off); behaviour with the mode ON is unchanged.

- 657cc76: Prime browser TTS when spoken replies are enabled from Connection Settings, closing a mobile gap in the conversation-mode gesture-unlock. Enabling conversation mode + speak-replies via the settings checkboxes is a real user gesture, so `unlockTts()` is now called from that save handler too. Without it, a mobile Chrome / iOS / PWA user who turned spoken replies on from settings and then only typed (never tapping the master toggle or the mic) would have their first `say` reply silently dropped by the browser's user-activation gate. The call is idempotent and only primes when spoken replies are actually intended.

## 0.10.7

### Patch Changes

- 012a260: Fix the conversation-mode spoken reply never being heard on mobile Chrome, iOS Safari and installed PWAs. Those browsers only allow the first `speechSynthesis.speak()` of a page from inside a user gesture, and the `say` reply speaks from a WebSocket-driven effect, so mobile silently dropped every utterance (desktop has no such gate, which is why it looked fine there). Speech synthesis is now primed once, silently, from a real tap: the Conversation Mode toggle, and the mic button (which also covers a returning user whose conversation mode was already persisted on). A real `say` reply additionally issues a defensive `resume()` kick, since mobile Chrome can leave the utterance queue paused. The priming utterance is kept off the TTS-settle signal, so `isTtsSpeaking()` / `whenTtsIdle()` still report only real spoken replies and the hands-free mic-reopen loop is unchanged.
- c1bd6c6: Fix a slow-loading session suddenly replacing the one you switched to. While a session was still loading, tapping a different session in the sidebar could let the old session's late reply clobber the one you were now looking at. The client now stamps every `session_load` with its target file and rejects a stale `session_created` / `message_history` for a session it already switched away from (the latest tap wins), so a superseded load can no longer take over the active view or strand the loading spinner.

## 0.10.6

### Patch Changes

- fa115a6: Add per-message actions to assistant replies in the web dashboard: a Copy button that copies the message's raw markdown to the clipboard (with a brief "Copied" confirmation and a clipboard fallback for insecure contexts), and a Raw/Rendered toggle that switches an individual message between its rendered markdown and its verbatim markdown source (shown in a monospace block). Both actions are keyed per message id so each toggles independently, and they live in a subtle action bar that reveals on hover/focus so the transcript stays uncluttered. Display-only: the underlying message content is never modified.

## 0.10.5

### Patch Changes

- 451c042: Add the `collapseLongReplies` conversation-mode behaviour to the web dashboard: when conversation mode + the `collapseLongReplies` knob are on, a LONG written assistant reply is de-emphasised (clamped behind a fade) so the short spoken `say` summary is the focus and the transcript stays glanceable. This is a display concern only — the full written reply is NEVER deleted, hidden, or destructively truncated; it always stays fully expandable via a "Show full reply" affordance (reusing the same expand/collapse idiom the chat message list already uses for tool cards) and re-collapsible once opened. Being a gated conversation knob, it only takes effect when the master `conversationMode` toggle is also on; with the knob off (or conversation mode off) replies render exactly as today, no collapse. The underlying transcript/message content is untouched. The pure decision logic (whether a given reply renders collapsed, and the long-reply char threshold) lives in a new `core/collapse-reply.ts` module — mirroring the `core/speak.ts` seam pattern for the `say` card — with unit tests at that seam.
- 6ec9b03: Add a conversation-mode knobs registry to the web dashboard: a named preset of independent boolean knobs (`conversationMode`, `autoSendOnSpeechEnd`, `speakReplies`, `collapseLongReplies`, `micReopensAfterReply`) persisted in the existing config, with a prominent "Conversation Mode" master toggle that flips the configured bundle on at once and gates the purely-conversation knobs. Each knob has exactly one canonical localStorage home: the purely-conversation knobs + the master toggle live in the single `wherever-config` entry (mirroring the `beepDefault` persisted-flag pattern), while `autoSendOnSpeechEnd` IS the existing `directSend` flag surfaced as a knob and reuses the `wherever-speech-direct-send` key (no forked second flag), so the two stay the same underlying value. When the master is off the purely-conversation knobs are dormant (default typing-first experience unchanged), but a standalone-set `directSend`/`autoSendOnSpeechEnd` still auto-sends. This task is the registry + toggle + persistence + gating only; the behaviours the knobs drive (TTS, the `say` card, collapse-long-replies, hands-free mic re-open) are consumed by separate tasks that read these knobs.
- df01c28: Add the hands-free `micReopensAfterReply` loop to the web dashboard: when conversation mode + the `micReopensAfterReply` knob are on, the agent settling (the same `isStreaming` true→false edge the waiting-for-human beep uses) now re-opens the mic so the user can keep talking without tapping. Per the resolved engine-scope decision (Open Question 3), auto mic-reopen is BROWSER-engine only (streaming speech recognition restarts cleanly); on the CLOUD engine (explicit hold-to-talk / tap-to-toggle) it FALLS BACK to just re-focusing the composer, no auto-record (which would have no natural gesture and surprise the user). Before re-opening, it waits for any in-flight `say` TTS to finish so the spoken reply is not captured as microphone input. With the knob off (or conversation mode off) nothing re-opens or auto-focuses; the typing-first default is unchanged.

  To coordinate this, `core/speak.ts` gains a minimal TTS-settle signal (`isTtsSpeaking()` / `whenTtsIdle()`, plus `resetTtsSettleSignal()`) that tracks outstanding utterances via `utterance.onend`/`onerror` — the shipped `speakUtterance` was fire-and-forget with no TTS-done signal — and reports idle immediately when no utterance was ever fired (speakReplies off) so the re-open is never blocked. `SpeechButton.svelte` gains a minimal public surface for the browser-engine auto-reopen: a bindable `activeEngine` and an exported `startRecordingProgrammatically()`. The pure engine-scope decision lives in a new `core/hands-free.ts` module (mirroring `core/collapse-reply.ts` / `core/compose-send.ts`) with unit tests at that seam; the settle-edge driver that consumes it lives in `ChatInput.svelte`, which already owns the composer focus and subscribes to the settle edge.

- ccf60d6: Add a self-contained `say` tool so the agent can emit a SHORT spoken-form reply (in addition to its written answer) that the web UI will later speak aloud and surface while a spoken conversation is active. Mirroring `attach_file`, it validates its `text` argument (error on blank) and returns a normal tool result carrying the text in `details` — no file reads, no bridge, no side channel. It is dual-registered: as a `customTool` on the server session pool's server-created sessions and via `pi.registerTool` in the `@wherever-dev/pi` extension, so behaviour is uniform across session types. The affordance rides the existing `tool_start`/`tool_end` stream — no new WS message type and no new chat role.
- c8557f3: Surface the `say` tool call in the web dashboard as a first-class 🔊 "spoken:" card and speak its payload via the browser `SpeechSynthesis` API. Driven entirely by the existing `tool_start`/`tool_end` stream (no new WS message type, no new chat role): a `say` call now renders a distinct "spoken:" card — mirroring the `attach_file` first-class treatment and exempt from the `hideTools` collapse — while the full written reply always remains present in the transcript (the card is additive, never a replacement). When the `speakReplies` conversation-mode knob is active (which, being a gated knob, also requires the master `conversationMode` toggle on), a completed `say` call fires exactly one `SpeechSynthesisUtterance` carrying the text, using the configured speech locale (`wherever-speech-locale`) for the utterance `lang`; each say message is spoken at most once. TTS is feature-detected to a graceful no-op when the browser has no `speechSynthesis`, and with `speakReplies` off no utterance fires. The short spoken text comes only from the agent's explicit `say` call — never a client-side summary of the full reply. The extraction + utterance logic lives in a new `core/speak.ts` module (mirroring the `core/beep.ts` feature-detected pattern) with unit tests at that seam.

## 0.10.4

### Patch Changes

- fe17675: Relicense the project from MIT to AGPL-3.0-only. The root `LICENSE` file now contains the verbatim GNU Affero General Public License v3.0 text. Documentation (`README.md`, `CONTEXT.md`) and the marketing site footer now reference AGPL-3.0, and the published packages (`wherever-dev`, `@wherever-dev/client`, and the extension `@wherever-dev/pi`) declare `"license": "AGPL-3.0-only"`.

## 0.10.3

### Patch Changes

- 3c035f6: Fix a `/skill:<name>` invocation showing up as TWO messages: the raw optimistic echo (which then flipped to "Not delivered / Retry" and persisted across reloads) plus the transformed skill chip. The client optimistically echoes the raw `/skill:...` invocation, but the server confirms it with a raw `message_ack` and later echoes back the expanded `<skill>` block, so exact-content delivery matching missed and appended a duplicate. Delivery confirmation now matches the raw optimistic bubble to the expanded server echo by skill-invocation identity (name + args) and rewrites it in place, so there is a single confirmed skill chip. Adds shared `parseSkillInvocation` / `skillInvocationIdentity` helpers to `@wherever-dev/client` (now used by the web instead of a local copy).

## 0.10.2

### Patch Changes

- 3760975: Display `/skill:<name>` invocations as a compact skill chip instead of the expanded skill body. Skill commands are still expanded server-side so the agent receives the full skill content, but the web now recognizes the expanded `<skill>` block (in both live echoes and reloaded history) and renders a distinct skill-invocation bubble showing the skill name plus any argument text the user typed after `/skill:<name>`.

## 0.10.1

### Patch Changes

- 1400666: Correct the PATH/environment caveat's account of the intermittency. Evidence from the richelieu drive sessions (~/.pi/agent/sessions) shows the git ENOENT toggled between consecutive tasks inside a SINGLE wherever process with the same, constantly-broken PATH. That toggling is not the systemd start-time race: the frozen process.env.PATH was constantly missing /usr/bin, and whether a given git spawn failed depended on which downstream code path (in dorfl) built the child env for that spawn. The docs now split the two layers explicitly: systemd/user-service setup explains why the PATH was incomplete at all (intermittent across service restarts), while a spawned tool's per-call-site env construction explains why the visible failure came and went within one process.
- 417dad7: Document the systemd user-service PATH/environment caveat in the README, and record the root-cause investigation under docs/. The root cause is the service environment wiring, not application logic: a Linux user service does not source the login shell and snapshots the systemd user-manager environment once at start; if that PATH was imported in stages and was still incomplete (e.g. missing `/usr/bin`) when the service started, every tool it shells out to (git, ssh, coreutils) can fail with an intermittent, start-time-ordering-dependent ENOENT. The README note explains how to get the full user PATH (volta/pixi/etc) into the service via `systemctl --user import-environment PATH` + restart (the recommended way to carry your session PATH), or by pinning `Environment=PATH=` / `environment.d` for deterministic/headless setups, and gives diagnostic commands to inspect the running service's frozen PATH. Docs only; no code or unit change.
- 5d05397: Make the per-message "Fork" button clearly visible with a proper hover state.

  The Fork action lived inside the message footer, which is rendered at 50% opacity; a parent opacity caps its children, so the button looked greyed out and its `hover:opacity-100` had almost no effect. It now renders as its own fully-opaque bordered chip below the timestamp, with a distinct blue hover (border, tint, and text), so it is easy to see and clearly interactive.

- 75f378d: Retract the incorrect "dorfl builds its child env differently per call site" explanation of the git ENOENT intermittency. Checked against the dorfl source (the commit that failed): dorfl does NOT edit PATH anywhere; run/runAsync spawn with `env: options.env ?? process.env` and identityEnv builds `{...base}`, faithfully propagating whatever PATH it inherited. The richelieu drive-session run markers show the failure was uniform within the process (every first-attempt hit ENOENT, including memory-pillar), and the `merged` results came from re-runs after a `~/.local/bin/git -> /usr/bin/git` workaround. So there is one cause (wherever handed dorfl a PATH without /usr/bin, dorfl passed it straight to git) and the only real intermittency is across service restarts (the systemd snapshot layer). Docs corrected accordingly; no code change.
- b3d3af3: Make `/skill:<name>` work in browser (server-created) sessions, and add composer autocomplete for skill commands.

  Previously, `/skill:<name>` only worked when a session was bridged to an external pi CLI process, because the CLI expanded it on its side. For sessions the wherever server runs in-process (the browser path), messages were sent via `AgentSession.sendUserMessage()`, which calls `prompt()` with `expandPromptTemplates: false`, so `/skill:foo` was forwarded to the model verbatim instead of inlining the skill body. Server sessions now route any `/`-prefixed message through `prompt({ expandPromptTemplates: true, source: 'interactive' })`, matching the pi CLI exactly: all expansions (skills, prompt templates, extension commands) are start-of-message anchored, and any trailing text after `/skill:<name> ` is preserved and appended after the skill block. Plain (non-slash) text keeps the existing `sendUserMessage()` path.

  Also adds a `/skill:` autocomplete dropdown in the composer. Skills discovered for the active session (including `~/.agents/skills`) are surfaced to the web client via a new `skills_request`/`skills_list` protocol pair (requested on `session_ready`). Typing `/setu` fuzzily matches and offers `/skill:setup`; ArrowUp/Down navigate, and the first Enter/Tab ACCEPTS the highlighted command (inserting `/skill:<name> ` with a trailing space) without sending, so a second Enter is needed to submit. This mirrors the CLI's accept-then-send behaviour and lets the user type an argument after selecting a skill.

## 0.10.0

### Minor Changes

- af0fd7a: Fork sessions at a specific user message, and show the fork hierarchy in the sidebar.

  The session list now renders forked sessions as a tree: a session created by forking is nested (indented, with a ↳ marker) under the session it was forked from. This mirrors pi's own session selector and is driven by each session's `parentSession` header, which the `/sessions` endpoint now surfaces as `parentSessionPath`.

  Every user message in a conversation gets a "Fork" action. Clicking it forks the session BEFORE that message (pi's default `position: 'before'`), creating a new branched session that keeps everything up to just before the chosen message and records the source as its parent. The web then switches to the new session and pre-fills the composer with the forked-at message's text, ready to edit and resend, exactly like `/fork` in the pi CLI.

  Implementation: user history messages now carry their source tree `entryId`; a new `session_fork` -> `session_forked` WebSocket exchange creates the branched file server-side (via the SDK's `createBranchedSession`) and returns the new path plus the pre-fill text; the client loads it through the normal session-load path. No live agent is built until the forked session is opened.

## 0.9.5

### Patch Changes

- c540ef8: Add a way to cancel queued steer messages on the web frontend.

  A message sent while the agent is mid-turn is queued by pi as a steer (injected at the next step boundary). Until now the web had no way to retract one: the only option was the Abort button, which kills the whole in-flight turn. The server now relays pi's steer queue to the client (a `queue_update` frame sourced from pi's `queue_update` event). Each still-queued steer bubble shows a passive "Queued (not yet sent to the agent)" badge so you can see which messages are pending, and a single session-level "Cancel queued" button (next to Abort) clears them via pi's `clearQueue()` without aborting the running turn. The cancel action is session-level, not per-message, because `clearQueue()` drops the whole steer queue at once; the button shows a count when more than one steer is queued.

  Only server-type sessions report a steer queue, so the affordance never appears for CLI-bridge sessions (the extension API has no per-steer dequeue), where it degrades gracefully to a no-op.

## 0.9.4

### Patch Changes

- 2d2a3c5: Fix steer messages wrongly flipping to "Retry", and show a proper in-flight state for pending messages.

  A message submitted while the agent is mid-turn is delivered as a steer, which pi only echoes back (as the user message) at the next model call. When the current turn outlasted the client's ~12s confirmation window, that missing echo made the accepted steer flip to a false "Not delivered / Retry" state. The server now emits a `message_ack` frame the moment it hands a message to the agent (both server and CLI-bridge sessions), and the client confirms delivery on that ack instead of waiting for the deferred user echo. `!command` bash is excluded (its tool output is the real feedback).

  The web UI now shows a spinner and a dimmed, ringed bubble while a user message is still `sending`, so a message no longer looks fully delivered and then abruptly becomes "Retry"; the failed state also gets a distinct amber ring.

## 0.9.3

### Patch Changes

- bc44497: Web dashboard: play audio attachments inline in tool cards.
  - A downloadable path (now `read` + `attach_file`) whose extension is audio (`mp3 wav oga ogg m4a aac flac opus`) renders an inline `<audio controls preload="metadata">` player, sourced from the SAME token-gated `downloadFileUrl(path)` as the image preview (not embedded bytes), OUTSIDE the collapsible section so it survives collapse.
  - The download chip stays, so an unsupported audio format degrades gracefully to the chip.
  - Images/video and non-media paths are unaffected — the audio branch keys purely off `mediaKind(path) === 'audio'`, beside the existing `image` branch, in both the `attach_file` attachment card and the generic tool card.

- b8b8d41: Web dashboard: preview images inline in tool cards and narrow the download/preview affordance to `read` + `attach_file`.
  - Narrowed `extractDownloadablePath()` from `attach_file`/`read`/`write`/`edit` to `read` + `attach_file` only — a `write`/`edit` card no longer renders a download chip (a download of a just-written file is noise).
  - Added a `mediaKind()` helper (`web/src/lib/core/media-kind.ts`) classifying a path by extension (case-insensitive) into `image`/`audio`/`video`/`null`; only `image` is used now (audio/video are pure additions later).
  - A downloadable image path now renders an inline `<img>` preview from the SAME token-gated `downloadFileUrl(path)` (not embedded bytes), OUTSIDE the collapsible section, tap-to-open and lazy-loaded, with the download chip still present.
  - De-duped against the model-facing `msg.images` `data:` path (left as-is): a `read`-on-image shows exactly one preview.

- 747b968: Play video attachments inline in the web dashboard, backed by server-side HTTP Range support so media can seek/scrub.
  - Web: a downloadable path (`read` + `attach_file`) whose extension is video (`mp4 webm mov m4v ogv`) renders an inline `<video controls playsinline preload="metadata">` player sourced from the SAME token-gated `downloadFileUrl(path)` (not embedded bytes), OUTSIDE the collapsible section, with the download chip still present. The branch keys purely off `mediaKind(path) === 'video'`, beside the existing `image`/`audio` branches, in both the `attach_file` attachment card and the generic tool card.
  - Server: `GET /session/download` now honours a single `Range: bytes=start-end` header — `206 Partial Content` with `Content-Range` + `Accept-Ranges: bytes` + a byte-exact sliced stream, a suffix range (`bytes=-N`), `416` for an unsatisfiable range, and a full `200` (advertising `Accept-Ranges: bytes`) when there is no `Range` header. A multi-range header serves only its first range (no multipart body).
  - Server: the MIME map gained audio/video types (mp3/wav/oga/ogg/m4a/aac/flac/opus, mp4/webm/mov/m4v/ogv) so media is served with a playable `Content-Type` instead of `application/octet-stream`, and media (audio/video/image) is served with an `inline` `Content-Disposition` (non-media stays `attachment`) — both keeping the existing ASCII + RFC 5987 filename encoding — so browsers render it in-chat.
  - The deny-by-default path resolution (out-of-root → `404`), the size cap (`413`), and the `downloads.enabled: false` gate (`403`) are unchanged and re-asserted by tests on the Range code path.

  ## Decisions
  - **Inline disposition for media.** Media (`audio/`, `video/`, `image/`) is served `Content-Disposition: inline` because an `attachment` disposition can suppress inline `<video>`/`<audio>` playback; non-media keeps `attachment` (the safe save default). The ASCII + RFC 5987 filename is preserved on both.
  - **Single-range only.** Only the first range of a (possibly multi-range) header is honoured; the server never emits a `multipart/byteranges` body — a single contiguous slice is all a media element needs to seek. An unsatisfiable range → `416` with `Content-Range: bytes */<size>`.
  - Observation captured: the default `uploads.type: 'tmp'` makes all of `os.tmpdir()` an allowed download root (`work/notes/observations/download-tmp-upload-dir-is-an-allowed-root.md`) — out of scope here, flagged for the deny-by-default posture.

- dd6a55c: Security fix (Gate-3 follow-up to inline-video-player-and-range): serve
  `image/svg+xml` downloads with `Content-Disposition: attachment` again instead
  of `inline`. The inline-media disposition change flipped every `image/*` type to
  `inline`, which for SVG (which can embed `<script>`) turned a tap-to-open of the
  same-origin download URL into a stored-XSS vector. SVG is not needed for inline
  `<video>`/`<audio>` seeking and previews fine via `<img src>` regardless of
  disposition, so it keeps the safe `attachment` default — preserving the
  pre-media-feature security posture. Adds a server test asserting SVG stays
  `attachment` while audio/video keep their inline disposition.

## 0.9.2

### Patch Changes

- d9df862: Show web `!command` / `!!command` (force command) bash tool calls INSTANTLY again instead of only after a server round-trip. Since the `!sudo` change, `!`-commands no longer add any local user echo — the bash tool-call render (driven by the server's `tool_start`) is the only feedback — so nothing appeared until the full client → server → `tool_start` → client hop completed, making force commands feel laggy.

  The client now renders an OPTIMISTIC bash tool bubble the moment a `!`/`!!` command is sent (correct `$ bash command="..."` label, `forceCommand`, live "Elapsed" timer), tagged `optimistic` so it is NOT delivery-tracked (no watchdog/retry banner) and is reconciled — not duplicated — when the server's real `tool_start` arrives (FIFO match on the oldest pending optimistic bubble, so back-to-back `!`-commands line up correctly). `!sudo ...` is intentionally excluded from the optimistic bubble because the server defers it behind a password prompt and only emits `tool_start` once the password arrives. A stuck optimistic bubble (e.g. the turn ends before any `tool_start`) is still finalized as interrupted by the existing agent_end/aborted sweep.

- 0610f2d: Refine the proposed `inline-media-attachments` spec: NARROW the download/preview
  tool set to `read` + `attach_file` only, dropping the pre-existing over-broad
  download button on `write`/`edit` tool cards (`extractDownloadablePath()` goes from
  `['attach_file','read','write','edit']` to `['attach_file','read']`). The narrowing
  rides slice 1 (same `ChatMessageList.svelte` seam as image-inline), with a matching
  user story and test. Spec-only change; no runtime code touched yet.
- 462d525: Task the `inline-media-attachments` spec into three vertical tracer-bullet tasks in
  `work/tasks/backlog/` (`inline-images-and-narrow-download-tools` → `inline-audio-player`
  → `inline-video-player-and-range`, serialized on the shared preview seam), trim the
  spec to its durable framing, and move it `work/specs/proposed/ → work/specs/tasked/`
  to record tasked-ness. No runtime code changed.

## 0.9.1

### Patch Changes

- 09c6f6a: Pin `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` to an exact version (`0.80.6`) instead of the loose `^0.80.3` range. A later `0.80.x` patch release removed the `AuthStorage` export that `session-pool.ts` imports, so fresh global installs (no lockfile) resolved a broken version and crash-looped on startup with "does not provide an export named 'AuthStorage'". Exact pinning prevents that drift.

## 0.9.0

### Minor Changes

- 9e4e6e0: Replace the blocking session take-over / conflict-resolution dialog with a
  non-blocking folder-overlap **warning banner**, and drop the take-over and
  read-only _choices_ entirely.

  Previously, loading or starting a session in a folder that already had another
  active session popped a modal offering **Take Over** (interrupt the other
  client) or **Read-Only** (observe). This had two problems: the modal blocked the
  flow, and **Read-Only** was broken for a brand-new session (there was nothing to
  observe, so it fell back to the existing session).

  Now the server never blocks:
  - On a folder conflict it attaches the client to the folder's session as a
    **read-only observer** and flags `folderConflict` on `session_created`.
  - The client renders a persistent **warning banner** with a single **Continue
    anyway** button. Clicking it sends the new `folder_conflict_continue` message,
    which lifts read-only for that client so it can send. It does **NOT** abort or
    take over the other session — both run concurrently (changes may conflict).
  - After continuing, the banner stays as a passive warning (no button) and
    **disappears automatically** once no other session is active in the folder,
    driven by a new live `folder_conflict` server→client update broadcast on every
    session-set change.
  - A `sessions.readOnly`-configured folder stays hard read-only (Continue anyway
    is a no-op there).

  Removed the `session_conflict` / `session_resolve_conflict` protocol messages,
  `resolveConflict` / `takeOver`-driven UI, and the `SessionConflictDialog`
  component. The web frontend and the VS Code sidebar both use the new banner.

### Patch Changes

- 81b5e26: Fix server test isolation: the integration harness spawns the real server with
  `...process.env`, so an ambient `PI_REMOTE_TOKEN` (present when tests run inside a
  wherever-managed shell) made the server enforce auth and reject the token-less
  test WS client with `401`, failing all 13 server tests. The harness now
  neutralizes every leaking `PI_REMOTE_*` var (token, host, port, SSL, HTTP
  fallback) so its documented "no token / no SSL" intent holds regardless of the
  ambient environment.
- faa9f4e: Onboard the repo onto the file-based `work/` contract: add the contract skeleton
  (`work/tasks`, `work/specs`, `work/questions`, synced `work/protocol/` docs),
  migrate the bespoke `work/briefs/ready/` specs to `work/specs/ready/` and
  `work/ideas/` to `work/notes/ideas/` (history-preserving renames), add a
  `dorfl.json` gate (`verify` = `pnpm format:check && pnpm build:all && pnpm run -r test`,
  `prepare` = `pnpm install --frozen-lockfile`, `promptGuidance.testFirst`), and
  document the conventions + contract layout in `CONTEXT.md`. No runtime code changed.
- 23e30fe: Add `work/specs/proposed/conversation-mode.md`: a spoken back-and-forth "conversation
  mode" that is a PRESET over individually-configurable speech knobs (reusing the
  existing `directSend` send-on-speech-end), plus a self-contained `say` tool (the
  `attach_file` pattern) so the agent emits a SHORT spoken reply — read aloud via
  browser `SpeechSynthesis` — IN ADDITION to its full written answer, letting the
  human hear something concise and spot when it misrepresents the detail. Staged in
  `specs/proposed/` with `needsAnswers: true` (three open questions: `say` registration
  surface, `say` UI treatment, hands-free/engine interaction). No runtime code changed.
- 3fe9369: Migrate the ad-hoc `docs/plan-inline-media-attachments.md` plan into the `work/`
  spec lifecycle as `work/specs/proposed/inline-media-attachments.md`, reshaped to
  the repo's `spec-template` (Problem / Solution / User Stories / Out of Scope /
  Implementation & Testing Decisions) and staged in `specs/proposed/` for review-first
  admission. No runtime code changed.
- 3fe9369: deploy: add `--sudo-password` option to the cloud-init generator that lets the wherever service run `sudo` but requires the user's password (collected by the frontend and piped to `sudo -S`). It sets a real login password on the account, switches sudoers to `ALL=(ALL) ALL`, and relaxes the systemd sandbox (`NoNewPrivileges=false`, `ProtectSystem=off`) so escalation actually works. The default (passwordless, fully-sandboxed, sudo-blocked service) is unchanged.

## 0.8.4

### Patch Changes

- f16bca7: Server: expand a leading `~` in `remoteRepoRules[].pattern` before matching. The pattern is tested against the absolute, tilde-expanded folder path (e.g. `/home/user/dev/...`), so a rule written as `~/dev/github/me/.*` (the natural form, mirroring `commonFolders`) never matched and the auto-remote-repo creation silently did not fire. A leading `~` in the pattern is now expanded to the home directory first. Absolute patterns are unaffected, and an invalid regex is treated as a non-match instead of throwing.

## 0.8.3

### Patch Changes

- 6a95014: Client: surface an actionable error when the WebSocket handshake keeps being rejected instead of silently reconnecting forever. The server rejects a missing or wrong token with HTTP 401 during the WS upgrade, which a browser WebSocket can only observe as an opaque 1006 close, so the dashboard previously just showed `reconnecting to relay (attempt N)` with no hint of the cause. The client now tracks whether it has ever connected; after a couple of failed attempts with zero successful opens it sets a clear error ("the connection is being rejected... missing or wrong token, or wrong host/port/scheme...") while still retrying. A drop after a successful connection is still treated as a normal transient reconnect.

## 0.8.2

### Patch Changes

- 8addff3: Auto-clone an existing remote when creating a session in a not-yet-cloned project. Previously, starting a session in a non-existing folder that matched a `remoteRepoRules` pattern always tried to CREATE the remote (`gh repo create` / `tea`/`cb repo create`); if that repo already existed on the host, the create failed and the session was left as an empty local folder with no `origin`. Now, at submit time (not on every keystroke), the server probes the provider using the same authenticated CLI and owner it would use to create (`gh repo view` for GitHub, `tea`/`cb` listing for Codeberg/Gitea/Forgejo). If the repo is found, the dashboard asks whether to clone it (preferring the SSH remote) or create a new one anyway; cloning runs `git clone <ssh-url>` into the target folder and pre-configures upstream tracking. When no matching remote exists, behavior is unchanged and it falls back to the normal create path (any probe/CLI failure is also treated as "does not exist"). `WhereverClient.createSession` gains an optional trailing `cloneRemote` argument.

## 0.8.1

### Patch Changes

- 6fff814: Web dashboard: connect back to the page's own origin port by default instead of always assuming 31415. When the dashboard is served behind a reverse proxy (e.g. Caddy on 443 with no port in the URL), the client previously forced `wss://host:31415/ws`, which is a closed port in that setup, so it hung on "Connecting to Wherever Server...". Now an unconfigured port resolves to the page's port (443/80/whatever the origin uses), and a legacy stored `31415` is healed to the page's port when the dashboard is actually served from a different origin. Direct `http://host:31415` LAN setups and explicit user-set ports are unaffected.

## 0.8.0

### Minor Changes

- fe11760: Support `!sudo ...` bash commands from the web client, for both server-hosted sessions and CLI-bridge sessions. When a `!`-command (or `!!`-command) starts with `sudo`, the server defers execution and asks the web client for the password via a new one-shot, masked prompt (a `bash_sudo_prompt` -> `bash_sudo_password`/`bash_sudo_cancel` protocol round-trip). Once the password arrives, a server session runs the command locally and a CLI-bridge session forwards it to the extension (new `cli_bash_sudo` message); in both cases the command runs with `sudo -S -k -p ''`, feeding the password over the child's stdin, and streams output/records history exactly like any other `!command`. The password is used once and is never streamed, logged, or persisted (only the password-free command line is recorded). A fresh prompt is required for every invocation (`-k` resets any cached sudo credential). Cancelling the prompt drops the command without running anything.

  Also fixes pre-existing UX bugs affecting all `!`/`!!` bash commands from the web client. Because the server runs them as a bash tool call instead of delivering them to the agent, there is no user-message echo to confirm: the delivery watchdog wrongly flagged them as failed (a spurious retry/discard banner) and re-surfaced them as failed user bubbles on reload. Web `!`/`!!` commands no longer add any local user-message echo at all (the bash tool call is the feedback), so there is no banner and nothing reappears after a reload. The server now also marks force-command bash tool calls explicitly (`forceCommand`), both live and in reloaded history, so the web auto-expands their output reliably, including for back-to-back `!command`s and after a reload.

## 0.7.1

### Patch Changes

- a4866aa: Show the context-window usage indicator ("11.3% / 1.0M") for CLI-controlled sessions as soon as a viewer joins, instead of leaving it blank until the next turn. Previously the pi extension only forwarded its context usage on `agent_end` and model switches, so an idle CLI-bridged session (no new turn since the bridge connected) had no usage snapshot to show, and the server broadcast `session_created` on `cli_register` without one. The extension now pushes a context-usage snapshot immediately after registering (on connect/reconnect), and the server includes any cached usage in the `session_created` message it broadcasts to web viewers on `cli_register`. Both are best-effort: when usage is genuinely unknown (no model or no turn yet) nothing is shown, matching the previous behavior.
- fe99d43: Keep the scroll position anchored when loading older messages. Previously, clicking "Load older messages" preserved the distance from the bottom, which could visually shift the content the user was reading once the older window was prepended. Now the client records the message that was first before the load and, after the older messages are prepended, scrolls so that same message stays in place near the top of the viewport, leaving a small gap above it that reveals the newly loaded messages. If the anchor message can't be located after the prepend, it falls back to the previous "preserve distance from bottom" behavior so the content never jumps unexpectedly.

## 0.7.0

### Minor Changes

- 13c2d36: Add a file download mechanism so agent-produced files (e.g. a generated PDF saved into the work folder) can be pulled down to a phone/browser. New authenticated `GET /session/download?sessionId=..&path=..` endpoint streams the file with `Content-Disposition: attachment`, guarded deny-by-default: a file is served only when its real (symlink-resolved) path is inside an allowed root (always the session cwd and the resolved upload dir, plus `config.downloads.roots`), so `..` traversal and in-tree symlink escapes are rejected. Configurable via a new `downloads` block (`enabled`, `roots`, `maxBytes`).

  The download button in the web UI is driven by the tool CALL itself: the client inspects each tool call and, for a small set of file-oriented tools, renders a download button in the tool-card header (building an authenticated URL against the active session). This works identically in CLI-bridge and pure server-side (web-frontend) sessions, since both already stream tool calls to every client, so no side-channel message is needed. `attach_file` is the intended, agent-driven trigger; `read`/`write`/`edit` cards also offer a button opportunistically. The server additionally registers `attach_file` as a `customTool` on its own `createAgentSession()` sessions so the tool exists in web-frontend sessions that have no CLI bridge.

### Patch Changes

- 817aa93: Fix a session-routing bug where a message could be delivered to the wrong session's agent (you switch to a session, post a message, and the agent replies as if it were in a different session). The web client already stamps every send with the `sessionId` of the session it is actually viewing, but the server ignored it and routed by its own per-connection `client.sessionId`, which is only (re)attached when a `session_load` completes. During a switch/reconnect/resync window that value could be stale (a reconnected socket even starts with no attachment, and a cold load attaches only seconds later inside the async agent-build step), so the message went to whatever session the connection was previously attached to.

  The `message` and `abort` WS handlers now treat the client-stamped `msg.sessionId` as authoritative: they resolve it through the session pool and verify it maps to the same tracked session the connection is attached to. On a mismatch the send is refused with a `session_error` (surfaced by the client as a recoverable, retryable failure via its delivery watchdog + Retry) instead of being misrouted into another session's agent. Adds an end-to-end regression test (`server/test/message-session-authority.test.ts`) that reproduces the misroute and asserts it is now refused, and that a correctly-stamped send is still delivered.

## 0.6.2

### Patch Changes

- 30db572: Fix the server test harness, which spawned the server without the required `start` verb. Since the explicit verb dispatch was introduced, a bare invocation prints usage and exits, so `/health` never came up and every gate test failed with "server did not become healthy". The harness now passes `start`, and the full suite (6 files, 11 tests) is green again.
- f1ccbcc: Chat rendering improvements: user messages now linkify bare URLs (http(s):// and www.) into clickable links without reinterpreting other characters as markdown, and long fenced code blocks (triple backtick) in assistant messages render as collapsible `<details>` showing the language plus a truncated first line so they no longer clutter the log. Single-line code blocks stay expanded.

## 0.6.1

### Patch Changes

- 3d193f3: `wherever install` now forwards all server flags directly, no separator needed. Install owns only `--system`, `--no-pi-config`, and `--dry-run`; every other argument is passed verbatim to the baked `wherever start` command. So `wherever install --host 0.0.0.0 --port 31415 --http-localhost-fallback` works, and any server flag (`--host`, `--port`, `--token`, `--http-localhost-fallback`, `--no-ssl`, `--ssl-key`, `--idle-timeout`, ...) can be baked into the service without install modelling each one. A leading `--` separator is still tolerated (and ignored) for backward compatibility. On Linux, re-running `install` now also restarts the running service so the freshly written options take effect immediately (previously `enable --now` left an already-running process on the old `ExecStart` until the next restart), mirroring the launchd unload+load behavior on macOS.
- 3d193f3: Add a `wherever --version` command (with `-v` and `version` aliases) that prints the installed package version. The version is read at runtime from the package's own `package.json` next to the entrypoint, so it reports correctly regardless of how the CLI was launched (npm, a Volta shim, or an absolute service path). The version line is also listed in `wherever help`.

## 0.6.0

### Minor Changes

- 0d7ca65: Add `wherever install` / `uninstall` / `service-status` subcommands to run the server as a background service.

  On Linux it writes a systemd unit (a per-user unit under `~/.config/systemd/user/` by default, or a system-wide unit with `--system`) and enables/starts it. On macOS it writes and loads a per-user launchd LaunchAgent under `~/Library/LaunchAgents/`. Server flags like `--port`, `--host`, and `--token` are baked into the service invocation.

  On install (unless `--no-pi-config`) the `npm:@wherever-dev/pi` extension is added to the `packages` array in `~/.pi/agent/settings.json` if it is not already configured, so a running pi CLI bridges into the same server automatically. The existing settings file is backed up to `settings.json.bak` before it is modified. A `--dry-run` flag prints the unit/plist and the actions without writing anything.

  The server is now started with an explicit verb: `wherever start [server flags]`. A bare `wherever` prints the command help instead of starting the server (breaking change; acceptable pre-1.0). All existing server flags work unchanged after `start`. Windows is not supported yet; the command prints the manual steps instead.

## 0.5.3

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

- b87f1bc: Search mode: let the user pick the model before searching, and make the default folder-aware.

  The main-page search composer now shows a compact model picker (same list as the sidebar new-session picker). The selection is seeded from the search folder's default model, which the server now resolves against that folder's own settings (a folder-local harness/pi config default wins over the server global). The chosen model is threaded through `runSearch` into session creation, so a search runs on the selected model instead of always falling back to the global default. The top-bar magnifier needs no separate control: it just focuses the same composer.

  Server: `getAvailableModels(cwd?)` now resolves `isDefault` against an optional folder, a new `getDefaultModelFor(cwd)` returns a folder's default as `provider:modelId`, and `GET /config` includes `searchDefaultModel` for the configured search folder.

- db16623: Render `read`-tool image output inline in the web frontend, mirroring the CLI's inline image display.

  When the agent uses the builtin `read` tool on an image path, the pi tool result carries an image content block (`{type:'image', data, mimeType}`) alongside the text note. Previously the server's `extractToolResult` kept only text blocks, so the web never saw the image. The server now also pulls image blocks out of the tool result and ships them (base64 + mimeType) on the `tool_end` frame via a new optional `images` field, and reconstructs them from history when a session is reloaded. The client stores them on the `ChatMessage` (`images`), and the web renders each image inline right under the tool header, always visible (not hidden behind the collapse toggle), while the textual arguments/output stay collapsible. Click an image to open it full size. Text-only tools are unaffected.

- 9931867: Pair reconstructed tool results to their exact tool call by id, not just by tool name.

  The server now forwards the tool-call id on both `tool_call` (the id the assistant issued) and `tool_result` (the `toolCallId` it satisfies) history messages, and the web history mapping matches a result to its exact call by that id, falling back to the previous oldest-open-first per-tool-name behaviour only when no id is present (older sessions, or the synthesized `bashExecution` pair).

  This fixes mis-pairing when same-named calls interleave with some left dangling: e.g. two `bash` calls issued back-to-back where only the second returns a result. Name-FIFO alone would resolve the first call and leave the second dangling; id matching resolves the correct one and leaves the genuinely-interrupted call marked interrupted, in place.

  Tests: a new client test covering id-exact pairing (result resolves call #2 by id, leaving call #1 dangling/interrupted, order preserved).

- 676ca94: Add an inviting "agent is waiting for you" beep to both the web frontend and the CLI bridge extension.

  Both surfaces can now play a gentle sound the moment the agent finishes and is waiting for a human message, so you can look away and be called back when it is your turn. The beep is DISABLED by default on both. Each surface has a per-session toggle, and a config that sets the default for new sessions (which the per-session toggle can still override). The two surfaces are configured independently.

  Web frontend (`wherever-dev`): the chime is synthesised with the Web Audio API (a soft two-note rising interval, no bundled asset) and fires on the `isStreaming` true -> false edge for the active session. Connection Settings has a "Beep when the agent is waiting" checkbox (`beepDefault`) for the persisted default and an optional custom sound URL (`beepSoundUrl`, played via an `Audio` element, with a Test button; blank = built-in chime), both persisted in the `wherever-config` localStorage entry.

  The chat toolbar (next to "Hide Thinking" / context usage) has a tri-state per-session beep control that cycles Default -> On -> Off -> Default. Per-session choices are stored per session id (persisted in a separate `wherever-beep-overrides` localStorage map), so a session with NO explicit choice follows the global default live (changing the default updates it), while an explicit On/Off sticks to that session across session switches and reloads, unaffected by later default changes, until cleared back to Default. The default is a reactive store so toggling it in the Config menu takes effect immediately.

  CLI bridge extension (`@wherever-dev/pi`): plays a sound on the `agent_settled` event (the run has fully settled and is genuinely waiting for input, so it does not fire between chained internal turns).
  - Enabled by default when EITHER the `--remote-beep` flag is set OR `beep.enabled: true` in `~/.wherever/config.json` (the flag can only force-on, so the config file is the way to enable-by-default without passing the flag). Default off.
  - `/remote-beep [on|off]` toggles it for the current session (no argument toggles; enabling plays a sample); resets to the configured default on each session start.
  - Sound resolution, highest precedence first: `--remote-beep-command` flag, then `beep.command` in `~/.wherever/config.json`, then an auto-detected player + a system chime (`pw-play`/`paplay`/`canberra-gtk-play`/`ffplay` + freedesktop `complete.oga`, or `afplay` on macOS), then a terminal bell. The bell (`\x07`) is written to `/dev/tty` rather than stdout because pi's TUI owns stdout and can swallow an out-of-band byte; the command path exists because many terminals (e.g. WezTerm on Linux) have a silent audible bell.

  Also adds a typed `beep` section (`enabled`, `command`) to the server's `WhereverConfig` (the shared `~/.wherever/config.json` type), which the extension reads directly.

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

## 0.5.2

### Patch Changes

- 333f6ad: Never silently lose a message when the connection drops mid-send; confirm delivery and recover it on reload.

  A frame handed to a socket that reports OPEN can still never reach the server (a half-open TCP connection: `send()` buffers locally and does not throw, but the bytes never land). The optimistic echo was treated as delivered, the input was cleared, and on reload the message was gone with no way to recover it.

  Outbound user messages are now tracked as `delivery: 'sending'` until the server echoes them back (`message_end` role:user), at which point they are confirmed. If no echo arrives within a window, the message flips to `delivery: 'failed'` and the UI surfaces "Not delivered" with Retry / Discard instead of a normal-looking sent message. Unconfirmed messages are persisted per session, so a reload reconciles them against the loaded history: anything the server actually persisted is shown as delivered, and anything it did not is re-surfaced as a recoverable failed message (never silently dropped). New client APIs: `resendMessage(id)` and `discardMessage(id)`.

- 0976c2e: Steer the agent immediately on a mid-stream submit, matching pi's default.

  Submitting a message while the agent is streaming now steers it right away (the server injects it at the next tool/step boundary, before the next LLM call) instead of parking it in a local queue that waits for the whole turn to resolve. The primary button is renamed "Queue" -> "Steer" and the surrounding copy is aligned to pi's language ("Agent is working, Steer to interrupt"). The local `queuedText` wait-then-send and the `isStreaming`-driven auto-drain (and the "Unqueue" button) are removed; this also eliminates the "pi stops midway" auto-fire mechanism (see docs/adr/0003). The submit decision is now a pure, unit-tested helper (`web/src/lib/core/compose-send.ts`), and the hard-won safety is preserved: text is kept on a dropped send, per-session drafts persist, and disconnected/resyncing/agent-pending surface clear states instead of silently swallowing a message.

- 9368269: Show how long each tool call has been running, like the pi CLI.

  A running tool now shows a live-ticking "Elapsed N.Ns" and, once it finishes, "Took N.Ns" (one decimal, matching the CLI's bash duration format). The client reducer stamps `startedAt` on `tool_start` and `endedAt` on `tool_end` (new `ChatMessage` fields), and freezes a still-running tool's `endedAt` if the turn ends or is aborted without a `tool_end`, so the timer stops instead of counting up forever. The web UI ticks only while a tool is actually running (no per-frame work on an idle session).

  Durations also survive a reload/reconnect: history mapping pairs each `tool_call` with its `tool_result` and derives `startedAt`/`endedAt` from their timestamps (no server change needed), so a tool restored from loaded history shows the same "Took N.Ns" as a live-streamed one.

## 0.5.1

### Patch Changes

- e15f5fa: Fix Abort being disabled (and the composer enabled) when joining a pi CLI session that is mid-tool-call.

  When a session is being driven by the pi CLI and you opened it in the web frontend while a long tool call was in flight, Abort showed disabled and the composer looked ready, even though the CLI was still waiting for the tool to finish. Root cause: the CLI bridge only forwarded `agent_start`/`agent_end` as they happened and registered the session with a hardcoded `isStreaming: false`, so a turn already in progress when the bridge (re)connected was invisible to the server. Now the extension reports the agent's current streaming state (`!ctx.isIdle()`) in the `cli_register` handshake, and the server honors it (and keeps the mid-turn session from being idle-reaped), so a viewer joining a running CLI session correctly sees it as streaming.

- 2701c07: Fix the composer showing the web-search input while a session is still loading.

  The bottom composer decided it was in "search mode" purely from `!sessionFile`, ignoring the loading/resyncing/hash state. So during a session open (spinner showing "Loading session..." in the message area) the composer would render the search text box and "Search" button, an inconsistent, confusing state. Search mode is now derived from a single shared `isSearchActive` helper that also treats a session that is loading, resyncing, or targeted by the URL hash as "not the search state", so the composer and the message area always agree.

  Also adds a `vitest` unit-test tier to the `web` package covering the view-mode logic.

## 0.5.0

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

## 0.4.3

### Patch Changes

- 326f8a2: Fix duplicate parallel sessions when switching between the CLI and the web frontend.

  Root cause was a pi SDK version skew: the standalone server and the CLI-bridge extension were pinned to `@earendil-works/pi-coding-agent@^0.75.3`, while the user's `pi` binary had moved to 0.80.x. pi >=0.80 canonicalizes the cwd (resolving trailing slashes and `.`/`..` segments) before encoding the session directory name, whereas <0.80 encoded the raw cwd. Because the server keys its in-memory session map by the session file path, the 0.75-built server and the 0.80 CLI produced two different path strings for the same logical session, so the browser and the terminal ended up attached to two separate tracked sessions.

  Changes:
  - Bump the server and extension to `@earendil-works/pi-coding-agent@^0.80.3` (and pin `@earendil-works/pi-ai` to `^0.80.3`) so both sides use the same session-directory encoding as a modern pi CLI.
  - Harden the pool against any future version skew: a new `normalizeSessionFile()` canonicalizes the session file path at every map-key boundary (`registerCliSession`, `unregisterCliSession`, `handleCliEvent`, `getSession`, `loadSession`, `createNewSession`, and the active-session lookup in the session listing), so a CLI-reported path and a server-computed path converge on one key regardless of trailing slashes, `.`/`..` segments, or an SDK mismatch.

## 0.4.2

### Patch Changes

- e132f93: Make installed PWAs pick up new versions, and add a Reload button to the connection settings panel.

  An installed PWA is a hash-routed SPA and almost never issues a `navigate` request, so the service worker's skipWaiting-on-navigate trick never fired and a freshly deployed worker stayed stuck in the `waiting` state. The idle-gated update check also rarely ran right after a relaunch, so the "new version available" popup never appeared. The service worker registration now calls `registration.update()` immediately and on every `visibilitychange` to visible (relaunch / tab re-show), so the manual update popup is surfaced. The manual popup is kept (no silent auto-update).

  Also adds a Reload button to the web app's connection settings panel for forcing a fresh page load.

## 0.4.1

### Patch Changes

- 81c552f: Add an automated npm publish (approve) flow via Changesets and GitHub Actions. Landing a changeset on `main` opens/updates a "Version Packages" PR; approving and merging that PR builds every package and runs `changeset publish` to npm. Publishing uses npm Trusted Publishing (OIDC, no `NPM_TOKEN`) with provenance, so each published package (`wherever-dev`, `@wherever-dev/client`, `@wherever-dev/pi`) must register this repo + `release.yml` as a trusted publisher. Adds `build:all` (builds `client` first so the extension resolves it, then the web/server/extension bundle with the web UI embedded into `server/public`, then `vscode`) and a `release:ci` script for the workflow.
- 074af64: Fix uploads failing with "No active session" after using the file picker / camera. Opening a native file picker backgrounds the page and fires `visibilitychange: hidden`. If the user took longer than the 8s background-suspend delay (e.g. taking a photo or browsing files), the suspend timer tore down the session, so the upload that ran on return failed. The visibility handler now skips scheduling a suspend while a native file picker is open, and clears that guard when the picker closes (file selected, cancelled, or the page returns to the foreground).
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

- 613f439: Show the app build version next to the "Connected" indicator in the web frontend. Uses SvelteKit's built-in `version` (already wired to the git short hash, with a `-dirty` suffix when the tree has uncommitted changes), rendered right-aligned in a muted monospace style so you can tell at a glance which UI build is loaded.

## 0.4.0

### Minor Changes

- 2b72232: Render assistant chat messages as markdown, and fix two text-selection/copy problems in the chat (most visible on mobile Firefox).
  - **Markdown rendering**: finalized assistant messages now render GFM markdown (headings, lists, bold/italic, links, inline and fenced code, tables, blockquotes) with a dark, compact style scoped to `.markdown-body`. Parsing is done with `marked` and sanitized with `DOMPurify`. Links open in a new tab with `rel="noopener noreferrer"`.
  - **Copy while streaming**: a finalized assistant message is now parsed once and its DOM stays stable, so a text selection inside it survives instead of being collapsed on every token. While a message is still streaming it renders as plain text (no markdown re-parse per token), and only the live, bottom message keeps mutating.
  - **Selection spilling into the chrome**: a drag-select that started in a message bubble and reached the viewport edge could extend into the top bar / sidebar / toggle bar and copy the whole page. The app chrome is now marked non-selectable (`.app-chrome`) and message content is explicitly selectable (`.chat-selectable`), keeping a selection contained to the message.

- 3a430c7: Show context-window usage in the session top bar, like the pi CLI (e.g. `11.3% / 1.0M`).

  The dashboard now surfaces how much of the model's context window the active session is using, next to the model indicator. It updates live as turns complete and when the model changes.
  - **Server-managed sessions:** the server reads usage from pi's `AgentSession.getContextUsage()` and broadcasts a new `context_usage` message after each turn / message / model switch, and includes an initial snapshot on `session_created`.
  - **CLI-bridged sessions:** the server cannot run the agent, so the pi extension forwards its `ctx.getContextUsage()` on `agent_end` and model change; the relay caches and broadcasts it the same way.
  - **Display:** percentage of the context window used over the humanized window size (`1.0M`, `200K`, ...), matching the pi CLI. Right after compaction (when token count is momentarily unknown) it shows `– / <window>`. The value clears when leaving a session.

- 2aee118: Add a `sessions.readOnly` config option and a separate, observe-only Read-only sessions page.

  Building on `sessions.ignore` (which fully hides + skips folders), `sessions.readOnly` takes the same glob syntax but treats matching folders differently: they are **hidden from the main session list** (and, like `ignore`, skipped before their file bodies are read on the main view, so they do not slow it down), yet remain viewable on a dedicated **Read-only sessions** page reached via a link in the sidebar.

  ```json
  { "sessions": { "ignore": ["/tmp/**"], "readOnly": ["~/.agent-runner/**"] } }
  ```

  This is aimed at autonomous agent fleets (e.g. `agent-runner` working directories) you want to watch but not drive:
  - `GET /sessions?view=readonly` returns only the read-only folders, each tagged `readOnly`.
  - The Read-only page reuses the session browser but hides the create form and all delete controls.
  - Opening a read-only session is **forced read-only end-to-end**: the server sets the client read-only (so `message` sends are refused) and reports it in `session_created`; the dashboard then hides the composer entirely, showing an "observing only" notice.

  When `sessions.readOnly` is empty or omitted, behaviour is unchanged.

### Patch Changes

- f3c6c43: Add a client-side stale-socket liveness watchdog so a half-open WebSocket to the relay no longer hangs the connected agent forever.

  A half-open TCP connection (peer vanished without a clean FIN/RST: relay restart, network blip, dropped upstream) leaves the socket in `ESTAB` and fires neither `close` nor `error`, so the client's existing reconnect machinery was never triggered and the agent waited on the dead socket indefinitely (recoverable only by restarting the relay). `WhereverClient` now:
  - records `lastInboundAt` on every inbound frame (any frame, including the `pong` reply, counts as proof of life);
  - runs a periodic app-level `{type:'ping'}` keepalive so a healthy connection stays warm even during long, token-less model turns;
  - runs a watchdog that, when the socket has been silent past a threshold (~60s, comfortably above the keepalive interval), forcibly `terminate()`s/`close()`s the dead socket and calls the existing `scheduleReconnect()`.

  This reuses the existing exponential-backoff reconnect logic (the only thing missing was the trigger), so a wedged agent now self-heals in ~60s by reconnecting instead of requiring a manual relay restart. The watchdog timers are torn down on `close`/`disconnect`, and the socket is nulled before `terminate()` so the normal `close` handler does not double-fire a reconnect. Implements Slice A of `work/observations/ws-half-open-connection-hangs-agent-no-heartbeat.md`.

- dff6a44: Move the context-window usage indicator (e.g. `11.3% / 1.0M`) from the top bar to the bottom toggle bar, next to the Hide Thinking / Hide Tools toggles, and let that bar wrap onto a second line on narrow screens so nothing gets squeezed off.
- 94cb06c: Fix session selection showing the "New Session Started" empty state and not scrolling to the bottom while an existing session loads.
  - Added a dedicated `loadingSession` state flag that is set the moment a `session_load` is requested and cleared when its `message_history` (or an error/conflict/disconnect) arrives. This distinguishes "opening an existing session" from "a brand new empty session", so the chat view now shows a "Loading session..." spinner instead of "New Session Started" during the gap between the `session_created` and `message_history` websocket messages.
  - Scroll-to-bottom now also fires on the `loadingSession` true→false edge (when the history actually renders) using a settle loop across a couple of animation frames plus delayed retries, so freshly opened sessions reliably land at the bottom even when tall markdown/code content keeps growing for a few frames after mount.

- 6c036d9: Add a server-side WebSocket heartbeat that reaps dead/half-open relay connections.

  A half-open TCP socket (peer vanished without a clean FIN/RST: process restart, network blip, dropped upstream) stays in `ESTAB` and fires neither `close` nor `error`, so the relay never noticed the dead agent and its session was left dangling forever. The relay now sends a protocol-level ping frame to every connection on a fixed interval (30s) and `terminate()`s any socket that did not answer the previous ping. Because `terminate()` fires `close`, this routes through the existing teardown (`unregisterCliSession` / `removeClient` + `broadcastSessionsUpdated`), so a reaped agent's session is released rather than left hanging. The interval is cleared on `wss` close and on shutdown.

  Pairs with the client-side stale-socket watchdog (Slice A): the server reaps its own view of the dead connection while the client self-heals by reconnecting. Implements Slice B of `work/observations/ws-half-open-connection-hangs-agent-no-heartbeat.md`.

- 9db52f1: Add a `sessions.ignore` config option to exclude session folders from the dashboard list and speed up `/sessions`.

  The session list was built by reading and JSON-parsing **every** session file on disk on every `/sessions` request (to compute each session's first-message preview). With hundreds of sessions, including large piles of throwaway agent scratch sessions (e.g. under `/tmp`), this made the list noticeably slow to load.

  You can now set, in `~/.wherever/config.json`:

  ```json
  { "sessions": { "ignore": ["/tmp/**", "~/.agent-runner/**"] } }
  ```

  Any session whose resolved working directory matches one of these globs is excluded from the list. Crucially, because all sessions in one on-disk folder share a working directory, a matching folder is detected by reading only its first file's header (not its body) and is then **skipped before its file bodies are read**, so ignored sessions no longer cost anything to scan. Globs support `*` (does not cross a path separator), `**` (crosses separators), and `?`; `~` is expanded to home; and a pattern ignores both the directory itself and everything nested under it. When `sessions.ignore` is empty or omitted, behaviour is unchanged (the existing fast path is used).

- e1f9601: Shrink and de-thrash the `/sessions` payload so the dashboard loads fast with many sessions.

  The session list shipped the **entire, untruncated first message** of every session (often huge: pasted prompts, PRDs, specs), even though the sidebar only renders a ~40-char snippet. With hundreds of sessions this made `/sessions` multi-megabyte and slow, and it was refetched aggressively.
  - **Server (shrink):** `listSessions()` now caps `firstMessage` to a short, whitespace-collapsed preview (160 chars) at a single choke point, so every listing path ships a small preview. The field name is unchanged (now documented as a capped preview); the sidebar's display and filtering work as before. Measured against a real ~900-session store, the first-message portion of the payload dropped roughly 33x (multi-MB to ~140 KB).
  - **Web (de-thrash):** `fetchSessions()` no longer runs two fetches at once, collapses any requests arriving while a fetch is in flight into a single trailing re-fetch, and caps its debounce so a continuous stream of `sessions_updated` events (one per agent turn) can no longer pull the whole list repeatedly or postpone the fetch indefinitely.

  This composes with the `sessions.ignore` / `sessions.readOnly` options (which cut how many sessions are scanned/listed at all): together the default session list is now small and quick to load.

- 123b6a3: Add a per-turn transport-stall timeout and liveness observability to the WebSocket relay.

  Builds on the stale-socket watchdog (Slice A) and server heartbeat (Slice B):
  - **Per-turn stall timeout (client).** While a turn is streaming, the watchdog now uses a shorter deadline (`TURN_STALL_MS`, 45s) than the idle stale-socket threshold (60s). The keepalive pong should keep traffic flowing during a turn, so this distinguishes a merely slow model (heartbeat still arriving, not stale) from a dead transport (heartbeat stopped). On a mid-turn stall it surfaces a recoverable `sessionError` ("Connection to relay stalled mid-turn; reconnecting...") and clears `isStreaming` before reconnecting, instead of silently parking mid-stream.
  - **Idempotent re-register on reconnect.** Confirmed already handled: the extension re-sends `cli_register` on every `connected` state edge, which the watchdog reconnect re-triggers, so a vanished-and-returned client re-attaches cleanly.
  - **Observability (pi-remote half).** The client logs stale-socket teardowns, reconnect attempts, and successful reconnects; the server logs each reaped dead socket with its client/session context. A hung agent now shows up as an event rather than as silence.

  Implements Slice C and the pi-remote half of Slice D of `work/observations/ws-half-open-connection-hangs-agent-no-heartbeat.md`. The `agent-runner` wrapper change in Slice D is intentionally left to the agent-runner repo.

## 0.3.0

### Minor Changes

- a0a6adc: Reuse the chat composer as the search composer instead of a separate top-bar input.

  ChatInput is now mode-aware via props (onSubmit, placeholder, submitLabel, showAttach, searchMode, searchConfigured). In search mode it routes submit to the injected handler (runSearch), is enabled with no active session (requires only a live connection and a configured search folder), shows the "Search the web..." placeholder and "Search" button, hides file attach, and skips slash-command handling. The mic, autosize, and Shift+Enter behaviour are kept in both modes.

  On the page the inline single-line top-bar search input is removed. The always-mounted bottom composer becomes the search composer in the empty state (connected, search folder configured, no active session), which is also the page-load state, so users can type directly. When a session is active, a compact magnifier button in the top bar drops back to the search empty state and focuses the composer synchronously inside the tap gesture so the mobile virtual keyboard rises (notably on iOS Safari). Only one search input is ever shown at a time.

  Also fixes a bug where a search query was silently dropped: the client runs app message listeners before its internal state update, so sending the pending query directly from the session_created handler hit sendMessage while sessionId was still null. The query is now deferred to a microtask so the session is fully established first, and the magnifier clears the URL hash synchronously to avoid flashing the "Loading session..." spinner.

- 242b652: Add a web "search mode". A search bar in the dashboard top bar (visible when connected and a search folder is configured, autofocused on first load) creates a fresh session in the configured search folder and sends the query as the first message, returning a current, cited answer. New `searchFolder` and `searchCreateRemote` config keys (in `~/.wherever/config.json`) are exposed via `GET /config`; the search folder is created on demand on first search, with a private remote when `searchCreateRemote` is enabled and a matching remote rule exists. The reusable web-search skill (in `skills/web-search`) drives the same behaviour from the terminal via the companion `pisearch` installer.

### Patch Changes

- 37de34b: Extract core client WebSocket and state management logic into a dedicated, framework-agnostic `@wherever-dev/client` monorepo package. Update both the web dashboard (`@wherever-dev/web`) and the CLI extension (`@wherever-dev/pi`) to use the new shared client, reducing duplicate code and establishing a modular architecture for future integrations.
- ffd28c7: Improve resume behaviour after the page is backgrounded (notably Firefox on Android after a screen lock). The dashboard now closes its WebSocket after the page has been hidden for a short delay and reconnects immediately on return, improving back/forward-cache eligibility (so resume can be instant) and ensuring that, when a full reload does happen, the active session is restored quickly from the URL hash. Quick tab switches do not churn the connection.
- ffd28c7: Fix stale data on first load: the service worker no longer serves cached responses for dynamic server API endpoints (`/sessions`, `/config`, `/models`, `/check-path`, `/autocomplete-path`, `/session/*`, `/health`), which are now fetched online-first. App-shell navigations are also served online-first so a freshly deployed build is picked up without needing a second reload. Hashed assets and images remain cache-first for offline support.
- ffd28c7: Fix: unqueuing a queued message now restores its text into the editable input (so it can be edited or resent) instead of silently discarding it. Previously `Unqueue` cleared the input even though a backup of the message existed.
- 40c88c7: robust againt invalid session file
- ee52ff4: Improve Lighthouse scores for the dashboard PWA.
  - Web: stop shipping un-minified production assets. The Vite build had an
    inherited `minify: false` override which left JS/CSS unminified, roughly
    halving the largest chunk's size and fixing slow First/Largest Contentful
    Paint. Sourcemaps stay enabled for debuggable production stack traces.
  - Server: set `Cache-Control` headers when serving static files. Content-hashed
    `/_app/immutable/` assets are served `public, max-age=31536000, immutable`;
    the HTML app shell, manifest and other top-level files stay `no-cache` so a
    freshly deployed build is always picked up. This fixes the "efficient cache
    lifetimes" audit without affecting the service worker's own caching.
  - Server: add `.txt` and `.webmanifest` MIME types so robots.txt is served as
    `text/plain` and the manifest as `application/manifest+json` instead of
    `application/octet-stream`.
  - Web: add a minimal valid `robots.txt` so the SPA fallback no longer returns
    the HTML app shell for `/robots.txt` (which Lighthouse flagged as invalid).
    Wherever is a private Tailscale-only tool, so it disallows all crawlers.

- affc7cf: PWA: make the installed icon resolve correctly on Firefox Android. Regular icons now carry an explicit `purpose: "any"` (some Firefox versions otherwise fall back to a generated letter icon), and maskable icons are generated at both 192 and 512 (Firefox prefers a maskable at the launcher size). Firefox still overlays its own small badge on installed-PWA icons, which is a browser behaviour and not controllable from the manifest.
- eb0cfd0: PWA polish: the installed app icon is now generated from the Wherever logo (`logo.svg`) instead of the old placeholder, a properly padded `maskable` icon is generated (fixing the previous broken/missing maskable icon reference), and the manifest now declares desktop (`wide`) and mobile screenshots so Chrome offers its richer install UI. Icon/screenshot assets are produced at build time via a post-process step from committed sources under `static/pwa-src/`.
- 7b2ca04: PWA: set the web manifest `display` to `standalone` (was the pwag default `fullscreen`) and give the app a real identity (`name`/`title` "Wherever" with a proper description) instead of the template placeholder. This makes the installed app launch in its own window rather than a normal browser tab on browsers that honor `standalone`.
- 347e214: Removed all architecture overview diagrams and explicit references to "pi CLI" from the website landing page to simplify the landing page experience and remove any installation dependencies on pi or the CLI extension for typical dashboard users.
- a57e137: Rephrased website landing page copy, app description, and user onboarding elements to focus on building and maintaining apps "from wherever" (on any device), shifting the AI component to an implementation detail and correcting references from "mirroring terminal" to "syncing sessions and conversations".
- ffd28c7: Speed up loading of long sessions with tail-first history windowing. On load/join, the server now sends only the most recent messages (with a total count and offset) instead of the entire history in one payload, and the web dashboard shows a "Load older messages" button that lazily fetches earlier windows (with scroll-position anchoring). This adds `history_load_more` / `message_history_prepend` to the protocol and a `loadMoreHistory()` method plus history pagination state to `@wherever-dev/client`.
- fd8427d: Updated documentation and the landing page to clarify that installing the `pi` CLI is optional and not required to run Wherever in Headless Mode. Added notes detailing the architectural limitation where quitting/killing the `pi` CLI in Bridge Mode interrupts active sessions and running tools.

## 0.1.0

### Minor Changes

- 76522ac: Add standalone marketing/info website for GitHub Pages deployment. The new `site/` folder contains a SvelteKit + TailwindCSS static site with a landing page featuring hero section, features grid, architecture diagram, install guide, and footer. Includes a custom SVG logo with a pi symbol made of tetris-like blocks and signal waves. Deployed automatically via GitHub Actions workflow on push to main.

### Patch Changes

- bb36b59: Automatically expand shell/bash command tool calls in the remote web dashboard when the user executes a prompt starting with "!" or "!!".
- 8626cd3: Automatically update the session browser list in the sidebar in real time whenever a session is created, loaded, left, when client connections open or close, and when messages or agent cycles end.
- 26cba7b: Add toggles for hiding tool calls and thinking messages in the chat UI.
- e5fae9d: Maximize available horizontal space in the header for the workspace folder path by displaying the agent status (Ready vs. Agent working) directly on the robot model selector icon, removing the redundant text status indicators.
- e87ab30: Add "Hide thinking steps" and "Hide tool calls" options in the config UI to clean up the chat log. "Hide tool calls" keeps tool execution blocks visible if they are associated with explicit user terminal commands starting with `!` or `!!`.
- bb0bc3d: Normalize `cwd` paths in the server's session pool before creating, loading, or registering sessions. This resolves duplicate session folders when a workspace is accessed with vs. without a trailing slash (e.g. `--home-wighawag...--` vs `--home-wighawag...---`), fragments conversation history, and handles relative segments and double slashes.
- 01e6641: Fix the `/new` / `session_new` command on the server so that it successfully creates a brand new, clean session instead of returning the existing active session when the requesting client is already connected to it.
- 0630cff: Add a full-screen loading overlay on the main screen during session creation. This prevents users from initiating multiple simultaneous session creations and provides visual feedback during the creation delay.
- afe5ebc: Change sessions in the sidebar session browser to standard anchor links, allowing users to middle-click, command-click, or right-click to open sessions in new tabs.
- 70a974a: Configure both `web` and `site` packages for static site pre-rendering by setting `prerender = true` (in page/layout routing) and removing `fallback: 'index.html'` from the svelte static adapter configs. This enables SvelteKit to generate correct, portable relative-path references in the built HTML files, allowing the dashboard and marketing website to load perfectly under subpaths or IPFS gateways.
- ae04a3c: Redesign the remote web dashboard to match the brand design system and colors of the marketing website, introducing brand-dark, brand-surface, brand-border, emerald, and rose theme tokens across all UI components, dialogs, inputs, and layout blocks.

## 0.0.4

### Patch Changes

- 393e8aa: update to port 31415

## 0.0.3

### Patch Changes

- e54e697: Allow users to collapse folders in the session browser even when a filter query is active, with automatic reset of search-specific folder expansions when clearing the search query.
- 948ad33: fix: show full folder path under folder name in session sidebar

  When multiple directories share the same basename (e.g. `/home/user/wighawag`
  and `/home/user/projects/wighawag`), they appeared as separate groups with the
  same visible name, making them indistinguishable. Now the full resolved path is
  shown in smaller gray text beneath the folder name for easy differentiation.

- 14f1269: Show queued message text in input box as greyed-out italic text when agent is streaming

  When a message is queued (sent while agent is working), the text is now visible in the disabled textarea in a grey italic style instead of being hidden. Unqueueing clears the text and re-enables editing. Also added a refresh button (↻) next to the session filter in the sidebar to manually refresh the session list, with a spinning animation while loading.

- d319cfd: Fixed session list issues in the sidebar:
  - Fixed duplicate folder entries by properly resolving path representations (like expanding ~ and relative paths) consistently on the server.
  - Added keyed loops in Svelte `#each` blocks to make session list rendering reactive and prevent unnecessary DOM rebuilds.
  - Debounced `fetchSessions()` calls to coalesce rapid concurrent requests during bulk operations.
  - Added a "Delete All" button inside each folder's expanded session list to delete all sessions of that folder at once.
  - Prevented visual reloading/layout-flashing by keeping the existing list visible during background refreshes, only displaying the loading spinner on initial load when the folder list is empty.

- a697a2d: Ensure model choices are preserved across page reloads, server restarts, and synchronized dynamically between web and CLI.

  Specifically:
  - Fixed an issue where the model resolved to the first (oldest) model_change entry on session reload/restart instead of the most recent one.
  - Added model_select event propagation so that changing the model in a CLI session dynamically updates any connected web client.
  - Added support in the CLI bridge extension to receive and apply model changes initiated from the remote web dashboard.

## 0.0.2

### Patch Changes

- 2b2a81e: Add the ability to send images and documents by uploading them to a configurable server-side folder and appending their absolute paths to the user's message so the agent can read and process them.
- dda50b5: Add hint on the main screen stating that the sidebar can be used to open existing/running sessions.
  - format files

- 4859ae8: remove empty message from the conversation
- 1ae3216: Compress session list folders by default and support inline session deletion with double-confirmation, syncing state instantly across all clients. Fix mobile browser layout issues on Firefox by locking page overscroll and constraining container layout to visual viewport boundaries.
- 696abee: auto-completion path
- 66f8354: common folder
- e890743: Add support for executing bash commands directly from the Svelte web frontend using the `!` prefix (e.g., `!ls`, `!!git status`), matching the pi CLI's interactive behavior.
  - Intercepts prompts starting with `!` or `!!` on the server and runs them through the active AgentSession's executeBash or forwards them as `cli_bash` messages to the CLI bridge client.
  - Streams tool execution chunk updates back to the Svelte client in real-time.
  - Captures output and exit status and persists them to the session log as a `bashExecution` history message.
  - Supports raw output streaming of direct shell command executions.

- ce9aff8: Document all advanced features in the main README and enrich the USAEG guide with HTTP endpoints and WebSocket events.
- 002e622: fix abort on reload
- 49bc222: better side bar
- bf81616: git remote repo creation
- 2a1466a: speech api
- b8acc26: Improve speech recording feedback and reliability:
  - Transition from `MediaRecorder` to direct `AudioContext` / PCM buffer capture for instant, zero-latency WAV creation.
  - Add an audible synthesizer beep / chime on recording start for clear user feedback.
  - Introduce an explicit `isProcessing` state during local downsampling and cloud transcription to replace the red pulsing mic indicator with an orange processing indicator.
- 0a6f84e: remove empty message from the conversation and fix url hash persistence
- 99c1afa: Remove the clear button from the chat list and add a way to collapse the text input bar for easier reading on mobile. Clicking the collapsed bar expands the input and automatically focuses the textarea.
- ba41c2a: better enter keys for send
- 5ba8fd3: add option to upload via normal post request

## 0.0.1

### Patch Changes

- first release
