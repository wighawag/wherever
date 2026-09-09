# Wherever - Project Context

**Created:** 2026-05-20  
**Location:** `/home/wighawag/dev/github/wighawag/wherever`

## Project Overview

Wherever is a TypeScript extension for the [pi coding agent](https://pi.dev) that provides HTTP/WebSocket server capabilities for remote control. It allows controlling pi from anywhere while maintaining full access to all local folders and tools.

## What Exists

### Core Files

- **`src/index.ts`** - Main extension server
  - HTTP server with REST API endpoints
  - WebSocket server for real-time streaming
  - Token-based authentication
  - Event broadcasting (agent lifecycle, tool execution, messages)
- **`src/client.ts`** - Reference WebSocket client
  - Command-line client for testing
  - Demonstrates WebSocket protocol usage
- **`docs/USAGE.md`** - Complete API documentation
  - WebSocket API reference
  - HTTP API reference
  - Example clients (JavaScript, Python, cURL)
  - Mobile usage options
  - Troubleshooting guide

### Web Applications & Extensions

- **`web/`** - SvelteKit dashboard app (mobile-friendly)
  - Real-time WebSocket connection to wherever-dev server
  - Chat interface, session browser, voice dictation
  - Served by the server at `/` when connecting to a server
  - Built to `web/build/`
- **`vscode/`** - Wherever VS Code Companion Extension
  - IDE-native Sidebar Chat GUI
  - Establishes local loopback with `@wherever-dev/client`
  - Integrated with VS Code commands and native theme variables
  - Direct editor actions: Open Document and side-by-side git diff view
- **`site/`** - Standalone marketing/info website
  - Landing page, features, install guide, architecture diagram
  - Built as a static site for GitHub Pages deployment
  - Independent from web/ — no shared code or dependencies
  - Built to `site/build/`
  - Deployed via `.github/workflows/deploy-gh-pages.yml`

### Configuration

- **`package.json`** - Dependencies and pi package manifest
  - Runtime: `ws` (WebSocket library)
  - Dev: TypeScript, tsx, @types/node, @types/ws
  - Pi package config for auto-discovery
- **`tsconfig.json`** - TypeScript configuration
  - ES2022 target, ESNext modules
  - Strict mode enabled
  - Output to `dist/`
- **`~/.wherever/drafts.json`** - Saved drafts (see "Saved drafts" below). Lives in the STATE dir (`WHEREVER_STATE_DIR`), which DEFAULTS to the config dir, so `WHEREVER_CONFIG_DIR` alone still isolates it exactly as before.
- **`~/.wherever/config.json`** - Server-side runtime config (`getWhereverConfig()`): `sessions.ignore` / `sessions.readOnly`, `uploads`, `downloads`, `beep`, `searchFolder`, `conversationSearch` (autoSync / syncIntervalMs for `GET /search`), remote-repo rules. `WHEREVER_CONFIG_DIR` overrides the directory it is read from; the test harness sets it so an isolated server never picks up the developer's real config (a personal `sessions.ignore: ["/tmp/**"]` would otherwise hide the harness's own temp-dir sessions).
- **`~/.wherever/certs/localhost.{key,crt}`** - The auto-generated self-signed TLS pair, written only when the key and cert are NOT BOTH supplied (exactly one half is discarded with a warning). Also in the STATE dir (see below); it used to be built from `os.homedir()` directly, ignoring `WHEREVER_CONFIG_DIR` entirely.

### Documentation

- **`README.md`** - Quick start guide
- **`LICENSE`** - AGPL-3.0 License
- **`.gitignore`** - Standard Node.js ignores

## Technical Details

### Architecture

```
┌─────────────────┐         ┌──────────────────┐
│  Remote Client  │◄───────►│  Wherever Server │
│  (WebSocket)    │         │  (Extension)     │
│  (Web Dashboard)│         │                  │
└─────────────────┘         └────────┬─────────┘
                                     │
                              ┌──────▼──────┐
                              │  Pi Core    │
                              │  + Tools    │
                              └─────────────┘
```

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  Web Browser     │◄────────│  wherever Server │────────►│  pi CLI          │
│  (Dashboard)     │  WS     │  (Extension)     │  Ext    │  (Agent + Tools) │
└──────────────────┘         └──────────────────┘         └──────────────────┘
```

```
┌──────────────────┐
│  Marketing Site  │
│  (GitHub Pages)  │
│  site/           │
└──────────────────┘
```

### Server Endpoints

**WebSocket:** `ws://host:port/ws?token=XXX&clientKey=YYY`

- Real-time bidirectional communication
- Streams agent responses, tool events
- Accepts messages, abort commands
- `session_new` ALWAYS creates a new session, even when another viewer is live in that folder. (It used to attach the asker read-only to the occupant's session instead, since the pool refused to create beside a live session; that answered a different question than the one asked, and "Continue anyway" then unlocked a conversation the user never asked for. `SessionPool.createNewSession(..., forceNew)` now bypasses the reuse-the-occupied-folder shortcut for this path.) The shared-folder risk is carried by the folder-conflict banner on the NEW session instead: it starts read-only until "Continue anyway".
- Folder conflicts are tracked PER CLIENT (`conflictObserver`), not per folder, so the client's own verdict survives attach/leave churn; the conflict itself is always between DIFFERENT session files in one cwd, which the folder scan sees. The live `folder_conflict` message carries `readOnly` so the client mirrors the server's verdict, and read-only is released when the conflict resolves. A second viewer of the SAME conversation is not a folder conflict. "Continue anyway" is recorded as a durable intent (`conflictContinued`) and answered with an authoritative `folder_conflict` on the same socket, so it holds whether it lands before the paint, during a cold load's agent build, or after the attach.
- `connection_superseded` tells a connection it is being retired because a newer one arrived with the same `clientKey`. A client that receives it is alive, so the key was shared by accident (duplicating a tab clones `sessionStorage`): it regenerates its key before reconnecting instead of evicting the other connection back.
- `clientKey` (optional) is a stable per-viewer identity carried across reconnects. On connect the server retires any still-registered connection with the same key (detaching it from its session), so a viewer whose socket dropped silently is never counted as a second viewer. Without it, a half-open socket lingers until the heartbeat reaper (up to 60s) and makes `session_new` in that folder open its new session read-only behind a folder-conflict banner, for a conflict with nobody. The web client scopes the key per TAB via `sessionStorage`, so separate tabs remain separate viewers.

**HTTP REST:**

- `POST /message` - Send message to agent
- `GET /session` - Get session info
- `POST /session/new` - Start new session
- `POST /session/compact` - Trigger compaction
- `GET /search` - Conversation search over every past session (see "Conversation search" below)
- `GET /drafts` / `POST /drafts` / `POST /drafts/delete` - Saved drafts (see "Saved drafts" below)
- `GET /health` - Health check (no auth)
- `POST /session/upload` - Upload a file from the client to the server
- `GET /session/download` - Download an agent-produced file to the client (see "File Download / Attachments" below)

### Config dir (read) vs state dir (written)

The server distinguishes the directory it READS configuration from and the directory it WRITES to, because the deployment target (a declarative NixOS system service) renders `config.json` through sops-nix into a root-owned `0400` file the service can never write next to. ADR `0006-config-dir-is-read-only-state-lives-in-a-separate-state-dir`.

- `getWhereverConfigDir()` (`WHEREVER_CONFIG_DIR`, default `~/.wherever`) - READ only. `getWhereverConfig()`'s attempt to seed a default `config.json` when none exists is best-effort and warns rather than erroring, because an unwritable config dir is a supported deployment.
- `getWhereverStateDir()` (`WHEREVER_STATE_DIR`, **default: the resolved config dir**) - everything WRITTEN. The default is what makes the split purely additive: with the variable unset, and with only `WHEREVER_CONFIG_DIR` set (as every existing test does), every path is byte-identical to what it was before. There is no migration.
- `getWhereverCertsDir()` = `<state dir>/certs`.

**The complete list of config-dir writers, which is also the `StateDirectory` / backup set:** `drafts.json` (+ its `.tmp` sibling during the atomic write) and `certs/localhost.{key,crt}`. Nothing else. In particular **uploads are NOT under the config dir** despite `uploads.subDir` defaulting to `.wherever/uploads`: `resolveUploadDir()` resolves that against the SESSION's `cwd` (`path.resolve(cwd, subDir)`), so it is a per-project folder; the other two modes are `os.tmpdir()` (the default) and an explicit `uploads.dir`.

A future writer belongs in the state dir. If something genuinely has to be written next to the config, that is a design problem to solve, not a reason to reopen the config dir for writing.

### Auth token resolution (no secret need ever be in argv)

`/proc/<pid>/cmdline` is world-readable, so `--token <secret>` publishes the token to every local user via `ps`. `resolveToken()` in `server/src/index.ts` takes the first non-empty of, highest first: `--token` -> `WHEREVER_TOKEN` -> `WHEREVER_TOKEN_FILE` (a path whose trimmed CONTENT is the token, the shape sops-nix / `LoadCredential=` produce) -> `PI_REMOTE_TOKEN` (pre-existing, still honoured). Argv ranks first because precedence should follow EXPLICITNESS, not safety; safety is handled by warning at startup when the flag is used. The startup banner reports the SOURCE, never the token, since it lands in the journal.

**A set-but-unreadable/empty `WHEREVER_TOKEN_FILE` is FATAL** (`process.exit(1)`), deliberately choosing unavailability: falling through to "no token" would bring up a healthy-looking server on `0.0.0.0` with authentication silently off, which is the one failure that must never be quiet. ADR `0007-secrets-never-in-argv-token-resolution-order`.

TLS material is resolved as two INDEPENDENT absolute paths (`--ssl-key` / `WHEREVER_SSL_KEY` / `PI_REMOTE_SSL_KEY`, and the `*_CERT` triple), so a sops-mounted key and an ACME certificate in different places both work. Supplying exactly one half now WARNS instead of silently discarding it (the behaviour, falling back to the self-signed pair, is unchanged).

### Nix packaging (`package.nix` + `flake.nix`)

`package.nix` is a plain function of `pkgs` and IS the interface: the deployment repo evaluates several nixpkgs pins and does `import .../package.nix { pkgs = <its pin>; }`, so a flake-only output would drag a third nixpkgs into its closure. `flake.nix` merely calls it, and exists for `nix develop` (the exact node/pnpm toolchain, replacing the hardcoded volta path the old user service ran) and `nix build`. Verified: given the same nixpkgs and the same `buildVersion`, the flake path and a bare `import` produce the same store path. (In a git checkout the flake additionally stamps `buildVersion` with the commit rev, which a plain `import` leaves at the package version, so the two then differ by exactly that one build id.) The `src` filter is an ALLOWLIST of the workspace members plus the root manifests, not a denylist: `package.nix` is imported BY PATH as well as through the flake, and a path import of a working checkout would otherwise copy this repo's gitignored scratch (`tmp/`, `.kilo/`, ~160 MB) into the store and make the two paths disagree. ADR `0008-nix-packaging-package-nix-is-the-interface-flake-is-a-wrapper`.

`pnpmDepsHash` in `package.nix` pins the resolved dependency set and MUST be regenerated whenever `pnpm-lock.yaml` changes. A stale hash does not break the build; it silently builds against the OLD lockfile's dependencies. Hence `nix/update-pnpm-deps-hash.sh` (regenerate) and `nix/check-pnpm-deps-hash.sh` (CI guard that fails loudly). `web/svelte.config.js` honours `WHEREVER_BUILD_VERSION` so an out-of-tree build with no `.git` does not fall back to a `timestamp_<ms>` build id and lose reproducibility.

### Service Install (`wherever install`)

The standalone server (`server/`, bin `wherever`) uses explicit verbs. `server/src/index.ts` dispatches on the first argv: `start` runs the server (server flags follow it; the `start` token is stripped from `process.argv` before `main()` so the existing flag parser is unchanged), `install` / `uninstall` / `service-status` (aliased `status`) route to `server/src/commands/install.ts`, and a bare `wherever` (or `help`) prints usage. An unknown verb prints usage and exits 1. The generated service unit invokes `wherever start ...`.

- **Linux**: systemd unit. Per-user (`~/.config/systemd/user/wherever.service`) by default, or system-wide (`/etc/systemd/system/wherever.service`) with `--system` (needs root). Enabled + started via `systemctl [--user] enable --now wherever`.
- **macOS**: per-user launchd LaunchAgent at `~/Library/LaunchAgents/dev.wherever.server.plist`, loaded via `launchctl`. `--system` is not supported.
- **Windows**: not supported yet; the command prints the manual steps.
- Server flags `--port` / `--host` / `--token` are baked into the service's `ExecStart` / `ProgramArguments`. That is precisely why `--token` should not be used for a real deployment: the flag lands verbatim in `ExecStart` and therefore in `ps`. Pass `WHEREVER_TOKEN` / `WHEREVER_TOKEN_FILE` in the unit's environment instead.
- **`install` is NOT the model for a declarative host.** It writes a unit imperatively, which is the thing NixOS replaces; see `docs/deployment-nixos.md` for the module that supersedes it there.
- **Pi config injection**: unless `--no-pi-config`, install adds `"npm:@wherever-dev/pi"` to the `packages` array in `~/.pi/agent/settings.json` (creating the file if missing) when not already present, backing up to `settings.json.bak` first.
- `--dry-run` prints the generated unit/plist and intended actions without writing anything.

### Authentication

- Optional token via `--remote-token` flag
- WebSocket: query param or Authorization header
- HTTP: query param or Authorization header
- Default bind: `127.0.0.1` (localhost only)

### Waiting-for-human Beep

Both the web frontend and the CLI bridge extension can play an inviting sound when the agent finishes and is waiting for a human message. Disabled by default on both, with a per-session toggle and a default-setting config (the per-session toggle overrides the default). The two surfaces are configured independently.

- **CLI extension** (`extension/src/index.ts`): plays a sound on the `agent_settled` event (fully settled, not between chained internal turns).
  - **Enable default**: `--remote-beep` flag OR `beep.enabled: true` in `~/.wherever/config.json` (the flag can only force-on; the config file is the way to enable-by-default without passing the flag). Default off.
  - **Per-session**: `/remote-beep [on|off]` (no arg toggles; enabling plays a sample). Resets to the configured default on each session start.
  - **Sound**: resolves, highest first: `--remote-beep-command` flag → `beep.command` in `~/.wherever/config.json` → auto-detected player + freedesktop/system chime (`pw-play`/`paplay`/`canberra-gtk-play`/`ffplay` + `complete.oga`, or `afplay` on macOS) → terminal bell `\x07` written to `/dev/tty` (falling back to stdout). The BEL goes to `/dev/tty` because pi's TUI owns stdout and can swallow an out-of-band byte; and many terminals (e.g. WezTerm on Linux) have a silent audible bell, which is why the command path exists.
- **Web frontend** (`web/src/lib/core/beep.ts` + `web/src/lib/wherever.ts`): a Web Audio soft two-note chime fires on the `isStreaming` true -> false edge. A 🔔/🔕 top-bar button toggles it per session; Connection Settings has a "Beep when the agent is waiting" checkbox (`beepDefault`) and an optional custom sound URL (`beepSoundUrl`, played via an `Audio` element with a Test button; blank = built-in chime). Both persist in the `wherever-config` localStorage entry. The per-session override resets when the active session changes.

### Session Forking & Fork Hierarchy

Sessions can be forked at a specific user message, mirroring pi's `/fork` (default `position: 'before'`), and the sidebar renders the resulting parent/child hierarchy.

- **Fork hierarchy (sidebar tree):** pi stamps a forked session's header with `parentSession` (the source `.jsonl` path). `SessionManager.listAll()` already returns this as `parentSessionPath`; the `/sessions` endpoint (`session-pool.ts` `buildFolders`/`buildDiskSessionInfo`) now threads it into each `FolderSessionInfo` (normalized so a child's `parentSessionPath` matches a sibling's `path`). The web (`web/src/lib/core/fork-tree.ts` `buildForkTree`, used by `SessionBrowser.svelte`) nests each session under its parent WITHIN a folder (indent + ↳ marker), depth-first, cycle-safe; cross-folder parents surface as roots. This is display-only and mirrors pi's own session selector.
- **Fork-group ordering (recency across forks):** the server returns each folder's sessions flat and newest-first by `modified`, but the sidebar tree is ordered by GROUP: a root and its siblings rank by the most recent `modified` across their whole subtree, so an old parent whose fork is actively used floats to the top instead of sinking to where its own stale timestamp would put it. Ties fall back to the session's own `modified`, then path, for a deterministic order. Unit-tested in `web/src/lib/core/fork-tree.test.ts`.
- **Fork at a user message (`/fork` parity):** every user message in the transcript carries its source tree `entryId` (added to `HistoryMessage` on the `user` branch of `mapEntriesToHistory`, and to the client `ChatMessage`). `ChatMessageList.svelte` shows a "Fork" action on each user bubble. Clicking it runs the WS exchange `session_fork { sessionId, entryId }` -> `session_forked { sessionFile, cwd, prefillText }`. The server (`SessionPool.forkSession`) opens the SOURCE, validates the entry is a `user` message, and creates a new branched file via the SDK's `createBranchedSession(parentIdOfThatEntry)` (position 'before' => the branch ends just before the chosen message; a null parent means fork-before-first, handled by `SessionManager.create(...).newSession({ parentSession })`). The new file records `parentSession` = source (feeding the hierarchy above). `forkSession` does NOT build a live agent or attach a client: the web loads the returned file through the normal `session_load` fast-first path, then pre-fills the composer with `prefillText` (the forked-at message, to edit and resend) via the `composerPrefill` store consumed by `ChatInput.svelte`.

### File Upload (composer attachments)

The 📎 button in the composer (`web/src/lib/components/ChatInput.svelte`) uploads to `POST /session/upload` (or the WS `file_upload` message, per `uploads.method`) and the agent learns about the file ONLY through a `[Uploaded file: <path>]` line in the user message. That line is built in one place, `web/src/lib/core/attachments.ts` (`buildAttachmentMessage`, unit-tested), so chat and search compose it identically; with no prose of its own the message becomes an explicit "I have uploaded the following file(s) for you".

- **Search mode uploads are DEFERRED, not disabled.** An upload is attributed to a session (the session's `cwd` decides the upload dir for `uploads.type: 'session'`, and it is one of the allowed download roots), but a search has no session yet: `runSearch()` CREATES one and sends the query as its first message. So the search composer holds the picked `File` objects in the browser (chips render a 📎 instead of the upload spinner/✓) and `deliverPendingSearch()` in `web/src/lib/wherever.ts` uploads them right after `session_created`, then sends the query with the resulting paths. A search with files but no text is valid; upload failures never swallow the query (it is sent with whatever uploaded, and the failures surface as a session error).
- Files still held locally are dropped if the composer leaves search mode (the user opened a session instead of searching), so a stale chip can never ride along into a chat message.

### Saved drafts (save a message instead of sending it)

The composer can keep a message the user does not want to send yet, and load it back later, from any device. Two DIFFERENT things are called "draft" and they must not be conflated:

- **The per-session auto-draft** (`wherever-draft:<sessionId>` in localStorage, one entry per session plus a shared `search` key): invisible crash protection for the ONE text currently in the box, written on every keystroke, swapped on session switch and cleared by a send. Client-side on purpose: round-tripping a keystroke buffer to the server would be absurd, and its only job is surviving an unmount (a resync, a transient disconnect).
- **Saved drafts** (`server/src/drafts.ts`, `<state dir>/drafts.json`): explicit, durable, many-at-once messages the user chose to KEEP. Saving one clears the box, exactly as a send would ("instead of sending" is the whole point) but only AFTER the server has it, so a failed save leaves the message in the box with the error rather than swallowing it. Attachment chips are deliberately NOT cleared: an uploaded file is a server-side path and a draft is text only, so dropping the chips would lose a file the user still means to send.

- **The store is the SERVER, not the browser.** That is the whole point of wherever: the machine holds the state and any device picks it up. A draft written on a phone must be there on the laptop, and must survive the browser losing its site data. `GET /drafts` lists, `POST /drafts` `{text, sessionId?, cwd?}` saves, `POST /drafts/delete` `{id}` deletes (POST, mirroring `/session/delete`, so a proxy dropping DELETE cannot break it). All three are behind the same token gate as the other API routes (the `/drafts` prefix is in `isApiRequest`), because drafts are the user's unsent words.
- **The server is the ONLY writer.** It owns the id, dedupe, cap and ordering, and every mutation answers with the WHOLE new list, which the client adopts verbatim. The client never merges, caps or dedupes a list of its own: that would be a second writer with no conflict rule, and the two copies would drift. localStorage keeps a MIRROR (`wherever-drafts-cache`) used only to render the panel while disconnected; saving/deleting always need the server, and the Save button is disabled without a connection.
- **Global, not per session, and available in EVERY composer mode** including the no-session home page (search mode). A prompt written while looking at one repo is often exactly what you want to send in another, and the home page is precisely where you want to pull up something written yesterday and fire it into a new session. The origin `sessionId`/`cwd` is DISPLAY metadata only (the list shows the trailing folder name).
- **Loading warns when the box is non-empty.** `decideDraftLoad(text)` returns `confirm` for any non-whitespace content, and the panel then offers Replace / Append below / Cancel. Append (`applyDraft(..., 'append')`, joined by a blank line) is the non-destructive way out, so a load can never silently destroy unsent text. Whitespace is not work, so a blank-ish box loads straight away.
- **Loading does NOT delete a draft; SENDING it does** (`draftToConsumeOnSend`). Mail-client semantics: one mistap must not destroy the text with no undo, but a message that has actually been sent is not a draft any more and leaving it behind turns the list into a pile of things already dealt with. The link is by CONTENT, not a flag, and matches EXACTLY the two shapes `applyDraft` can produce: the draft alone, or the draft as a suffix after `\n\n` (append below). Deliberately NOT a substring test, which would delete a short reusable prompt ("run the tests") whenever it happened to appear inside an unrelated later message. Anything else means the text was edited past the draft, so the draft survives, which is the safe side of a wrong guess. The delete is best-effort: the message is already delivered, so a failed delete must never look like a failed send. `draftSource` is dropped whenever the box stops holding that draft (session switch, `/clear`, `/new`, `/leave`, a save).
- **The composer is cleared only if it still holds what was saved.** `saveCurrentAsDraft` snapshots the text AND the draft key before the request and re-checks both when it resolves: over a slow link the user can keep typing (clearing would delete everything typed since) or switch session (clearing would wipe THAT session's box and its auto-draft entry instead). Drafts responses also carry a monotonic sequence number (`draftsRequestSeq`), because a save, a delete and a panel-open refresh can be in flight at once and do not complete in order: without it a slow list response landing after a fast delete would resurrect the deleted draft in the list and in the mirror.
- **Split of logic.** Server (`server/src/drafts.ts`): parse/serialize, save/remove/sort, caps (`MAX_DRAFTS` 100, `MAX_DRAFT_CHARS` 20k), atomic write. Client (`web/src/lib/core/drafts.ts`): only what the server cannot know -- the load decision, `applyDraft`, the send-consumption rule, preview + origin label, and a tolerant parse for the mirror. Both are unit-tested (`server/test/drafts.test.ts` also boots a real server and asserts drafts survive a RESTART, which is the property a localStorage implementation cannot have; `web/src/lib/core/drafts.test.ts` runs without jsdom, mirroring `core/collapse-reply.ts`).
- **Storage discipline:** re-saving identical text TOUCHES the existing entry (`updatedAt`, floats to top) rather than duplicating it, since re-saving a reusable prompt is the normal case; the list is capped (least recently touched dropped) because a draft is kept forever by definition and this file is otherwise the one thing that grows without bound. Writes are ATOMIC (tmp + rename, mode 0600): this file is the only copy of text the user explicitly asked to keep, so a torn write would lose every draft at once. A malformed MEMBER of a valid file is DROPPED, never repaired (inventing fields for user-authored text is worse than losing the one broken record).
- **"Unreadable" is NOT "empty", and that distinction is load-bearing.** Every mutation is a read-modify-write, so a `readDrafts()` that answered `[]` for an unreadable or corrupt file would DELETE every draft on the next save, and the client would then mirror that empty list over its own offline copy. `parseDrafts` therefore returns `null` for "not a drafts file" (only a missing file is an empty list), `readDrafts()` throws `DraftsUnavailableError`, and both the read and the mutation routes answer `500` naming the file, leaving it untouched for the user to fix.
- **Over-long input is REJECTED, not truncated** (`validateDraftInput`, the single rule the routes call): the composer clears itself once the server has the draft, so silently storing a prefix would destroy the tail of the message with no error and no undo. `sessionId`/`cwd` are bounded too (`MAX_DRAFT_META_CHARS`): they are values the client already holds, and uncapped they are a way to grow the file until the whole list becomes unreadable.
- The panel floats ABOVE the composer (like the skill-command menu) so opening it never resizes the textarea or shifts the transcript.

### File Download / Attachments

The reverse of the upload path: files the agent produces (a generated PDF, an export, a note in the work folder) can be pulled down to a phone/browser and shown as tappable chips/links.

- **Endpoint** (`server/src/index.ts`): `GET /session/download?sessionId=..&path=..` streams the file with `Content-Disposition: attachment`. Behind the same token gate as the other `/session/*` routes.
- **Security (deny-by-default):** `resolveSafeDownloadPath()` realpath-resolves the requested path BEFORE a containment check, so neither `..` traversal nor an in-tree symlink can escape. Allowed roots (`resolveDownloadRoots()`) are always the session `cwd` + the resolved upload dir, plus `config.downloads.roots`. Out-of-root returns `404` (existence not leaked); oversized returns `413` (`config.downloads.maxBytes`, default 100 MiB); `config.downloads.enabled: false` disables the feature (`403`).
- **The download button is driven by the tool CALL, not by any side channel.** The web UI (`ChatMessageList.svelte` + `parseToolMessage()`, using `extractDownloadablePath()` from `web/src/lib/core/media-kind.ts`) inspects each tool call and, for a small set of file-oriented tools, renders a ⬇️ download link in the tool-card header (a sibling anchor beside Expand/Collapse, never nested in the button) whose href is built by `downloadFileUrl()` in `web/src/lib/wherever.ts` (carrying sessionId + token). This works for BOTH CLI-bridge and pure server-side (web-frontend) sessions, because both already stream `tool_start`/`tool_end` to every client. No `file_attachment` message, no `attachment` chat role, no bridge marker.
  - `attach_file`: the intended, agent-driven download. The agent calls it to offer a specific file ("give me the gpx", or right after producing a PDF).
  - `read`: opportunistic. Its card already carries the exact path the agent read, so a button is offered there too.
  - `write` / `edit` are NOT offered (a download of a file the agent just wrote is noise), and `ls`/`grep`/`find` are excluded (their path arg is a directory/search scope). The download/preview tool set is exactly `read` + `attach_file`.
- **Inline media preview (image; audio/video planned).** For a card that carries a downloadable path whose extension is a media type (`mediaKind()` in `web/src/lib/core/media-kind.ts` classifies `image`/`audio`/`video` by extension, case-insensitive — no client MIME sniffing, the path is already server-validated), an inline preview is rendered from the SAME `downloadFileUrl(path)` (NOT from embedded bytes), OUTSIDE the collapsible section so it survives collapse, tap-to-open (link to the URL) and lazy-loaded. Images preview as `<img>`; the download chip STAYS (the preview is additive). De-dup: a `read` on an image can also carry model-facing image blocks (`msg.images` as `data:` thumbnails — an untouched, separate path); when `msg.images` is present the download-URL `<img>` is suppressed, so a card shows exactly one preview.
- **`attach_file` is a SELF-CONTAINED tool, registered in TWO places** so it exists in every session type:
  - **Server-side sessions** (web frontend, no terminal): `server/src/attach-file-tool.ts` (`createAttachFileTool(cwd)`) is passed as a `customTool` into both `createAgentSession()` calls in `session-pool.ts`. The tool runs inside the server's own agent.
  - **CLI-bridge sessions** (terminal pi): the same tool is registered by the `@wherever-dev/pi` extension (`extension/src/index.ts`), the extension you already load (nothing extra to install).
  - In both, `execute` only validates the path and returns a normal tool result (`details: { path, filename, size }`). It does NOT read the file bytes and does NOT touch the bridge. The earlier bridge-marker design (a `file_attachment` cli_event relayed to a `file_attachment` ServerMessage) was REMOVED, because it could not work in a web-frontend session (no bridge). Its prompt tells the agent that a bare file path in a reply is never enough for a remote user; it must call `attach_file`.
- **`say` is a SELF-CONTAINED tool, dual-registered exactly like `attach_file`** (`server/src/say-tool.ts` `createSayTool()` as a `customTool` on both `createAgentSession()` calls in `session-pool.ts`, AND a `pi.registerTool({ name: "say", ... })` block in `extension/src/index.ts`), so it exists in every session type. `execute` validates its single `text` argument (blank → `isError: true`, touches nothing) and returns a normal tool result whose `details: { text }` carries the trimmed spoken text, with a short confirmation string as model-facing content. It reads NO files and emits NO side channel: the spoken-reply affordance is driven entirely by the tool CALL over the already-streamed `tool_start`/`tool_end` (NO new WS message type, NO new chat role), the same reason `attach_file` works everywhere. **The tool TEXT owns HOW, the per-turn injection owns WHETHER.** The description/`promptSnippet`/`promptGuidelines` describe the SHAPE of a spoken reply (an ADDITIVE one-or-two-sentence plain-spoken layer on top of (never instead of) the full written answer, no code/markdown/lists) and carry NO standing "while a spoken conversation is active" condition for the agent to evaluate itself: they state that `say` is called ONLY when the instructions for THIS turn explicitly say a spoken conversation is active, that this is the only signal, and that absent it `say` is never called. The earlier standing invitation let the agent infer "active" from a chatty exchange and call `say` with conversation mode OFF; the only positive trigger is now the injected per-turn hint (see the conversation-mode signal below). This is GUIDANCE, not a hard gate: the tool is still registered when the mode is off (a dynamic per-session registration would be a separate, larger change). It also deliberately no longer says "if the user is typing, a written answer alone is enough": that line made the agent self-suppress in exactly the situation the feature exists for. The two copies are held together by `server/test/say-tool.test.ts`, which parses the extension's `registerTool` block and fails if the description, `promptSnippet` or `promptGuidelines` drift. The web-side TTS + "spoken:" card that consumes this call is a separate task (`say-tool-tts-and-card`).
- **Spoken replies have a CLIENT-SIDE FALLBACK (`web/src/lib/core/speak-fallback.ts`).** `say` is a REQUEST to the model and compliance is a model property: measured on a local 35B, a turn with the per-turn hint called `say` about half the time and almost never at the post-tool-result synthesis call, so conversation mode went silent for entire turns and the user had to nag for audio. When a turn SETTLES (the same `isStreaming` true→false edge the beep and the hands-free mic-reopen use) with `speakReplies` ACTIVE and no `say` spoken for that turn, `ChatMessageList.svelte` speaks `spokenFallbackText(reply)`: the written reply with code fences, inline code, links/bare URLs, images and markdown structure markers stripped, cut to whole sentences up to ~320 chars. **Rules:** `say` always WINS (a turn that spoke is never re-spoken, tracked by `spokeThisTurn`, reset on the turn-start edge); the written transcript is NEVER modified or truncated (this is speech-only); a turn with nothing speakable (tools only, code only) speaks nothing; with `speakReplies` off nothing is ever spoken. The pure module (text + `shouldSpeakFallback`) is unit-tested without jsdom, mirroring `core/collapse-reply.ts`.
- **Browser TTS needs a GESTURE UNLOCK (`web/src/lib/core/speak.ts`).** The `say` reply is spoken from a WebSocket-driven `$effect` in `ChatMessageList.svelte`, i.e. with NO user gesture in the call stack. Mobile Chrome / iOS Safari / installed PWAs allow the FIRST `speechSynthesis.speak()` of a page only under user activation, so before this was fixed every mobile utterance was silently dropped (desktop has no such gate). `unlockTts()` primes speech synthesis ONCE from inside a real tap — the Conversation Mode toggle (opting into spoken replies), the mic-button pointerdown, and settings-save — with a SILENT (`volume = 0`) utterance; it is idempotent, feature-detected, swallow-all, and stays lockable if it could not prime. **The priming text is NOT blank** (`'.'` at volume 0): mobile Chrome discards a whitespace-only utterance before the speech pipeline runs, so a blank prime can burn the user activation without priming anything. **Those explicit call sites are not sufficient on their own**, because a returning user whose conversation mode is already persisted ON taps none of them in a page load: `armTtsGestureUnlock()` (armed from `ChatMessageList` whenever `speakReplies` is active) adds a one-shot, capture-phase, passive `pointerdown`/`touchend`/`mousedown`/`keydown` net on `document` that primes from the user's FIRST gesture, whatever it is, and removes itself the moment priming succeeds (it stays armed if it could not prime). **`utterance.lang` is voice-aware** (`resolveUtteranceLang`): a configured speech locale the engine has NO voice for is DROPPED rather than set, since setting an unsupported lang is a known way to get silence on mobile; an empty/unknown voice list means "no information" and the locale is applied as before. `speakUtterance` additionally issues a defensive `speechSynthesis.resume()` before speaking, because mobile Chrome can leave the utterance queue paused. **Rule for future work: the priming utterance is deliberately NOT tracked by the TTS-settle signal** (`isTtsSpeaking()` / `whenTtsIdle()`), since some browsers never fire `onend` for an empty utterance and that would wedge the hands-free mic-reopen loop at "speaking" forever; the settle signal reports ONLY real `say` replies. `unlockTts()` from a non-gesture path (a timer, a WS effect) is pointless — there is no activation to consume — and the gesture-less hands-free re-open path does not call it. No `speechSynthesis.cancel()` around the priming either: cancel drops queued utterances without firing their `onend`, leaking the settle count.
- **Conversation-mode knobs registry (`web/`).** Conversation mode is a saved PRESET over a set of independent boolean knobs, NOT a single opaque flag. The registry + gating logic is a pure module (`web/src/lib/core/conversation-mode.ts`: `CONVERSATION_KNOBS`, `KNOB_STORAGE`, `isKnobActive`, `bundleOn`); the persistence + reactive stores live in `web/src/lib/wherever.ts` (mirroring the `beepDefault` persisted-flag pattern). The five knobs: `conversationMode` (the master toggle), `autoSendOnSpeechEnd`, `speakReplies`, `collapseLongReplies`, `micReopensAfterReply`. **Exactly one canonical persisted home per knob.** `autoSendOnSpeechEnd` IS the pre-existing `directSend` (send-on-speech-end) surfaced as a conversation knob: it reuses the `wherever-speech-direct-send` localStorage key (NO forked second flag) via the shared `autoSendOnSpeechEnd` store, and `SpeechButton.svelte` reads/writes through that same store so a change in either place is reflected in the other. The other four knobs live as boolean fields in the single `wherever-config` entry via `getConfig()`/`saveConfig()`. **Gating (`isKnobActive`):** the master `conversationMode` gates the purely-conversation knobs (`speakReplies`, `collapseLongReplies`, `micReopensAfterReply`) — with it OFF they are dormant and the default typing-first experience is unchanged. The ONE exception is `autoSendOnSpeechEnd` (= `directSend`), which is NOT gated: its standalone effect survives the master being off (a user who set `directSend` today still auto-sends with the mode off; story 14). Flipping the master ON via `bundleOn`/`setConversationModeBundle` bundles the configured knobs on at once; flipping it OFF does NOT force `autoSendOnSpeechEnd` off. **The master is scoped PER CONVERSATION over a global default** (`resolveConversationMode`), mirroring the waiting-for-human beep's per-session override exactly: a spoken exchange is a property of the conversation you are having, not of the app, so the 💬/🗣️ top-bar toggle writes THIS session's own choice (`wherever-conversation-mode-overrides`, keyed by session id/file) and never moves other conversations, while the `conversationMode` config field is the DEFAULT that every untoggled conversation follows LIVE. "Unset" is a real state: a session with no override tracks default changes; once toggled its choice sticks. With no conversation open the toggle edits the default instead (there is nothing to scope to). The gated knobs stay GLOBAL: they describe HOW a spoken conversation behaves, only WHETHER this conversation is spoken is per conversation, and `sendOptions()` therefore stamps the per-turn wire signal from the session being viewed. UI: the top-bar toggle for this conversation, and the default + each individual knob editable in Connection Settings. This task owns the registry + toggle + persistence + gating ONLY; the behaviours the knobs drive (TTS, the `say` card, collapse-long-replies, hands-free mic re-open) are separate tasks that READ these knobs.
- **The agent LEARNS conversation mode is on per turn, via a system-prompt append AND a tail reminder (the conversation-mode SIGNAL).** "Conversation mode is on" is web-client state (the knobs registry) and a dictated message is byte-identical to a typed one, so the agent had no signal and, following the `say` guidance, stayed silent: the spoken reply was inert in practice (root cause in `work/notes/observations/say-tool-not-invoked-agent-cannot-see-conversation-mode.md`). The signal is an OPTIONAL `conversationMode` boolean FIELD on the EXISTING `message` WS payload (NO new WS message type, NO new chat role; absent means false, so older clients are unaffected). **Who stamps it:** the web app, per send AND per resend (`sendOptions()` in `web/src/lib/wherever.ts` calling `shouldSignalConversationMode()` from `web/src/lib/core/conversation-mode.ts`), true iff the master `conversationMode` AND `speakReplies` are BOTH active (a "please also speak" hint is pointless with spoken output off, and it reuses `isKnobActive('speakReplies')` rather than re-deriving the rule). The client just carries it: `sendMessage(text, {conversationMode})` / `resendMessage(id, {conversationMode})` OMIT the field when false. **How the agent sees it:** the pi `before_agent_start` hook APPENDS one line to `event.systemPrompt` (append to the value the event CARRIES, since the SDK chains extensions' results; never replace it, never re-fetch a base prompt) telling the agent to ALSO call `say` with a short spoken reply in addition to its written answer. It is PER-TURN (the mode flips mid-session, so a static tool-description edit would be wrong) and EPHEMERAL: a system-prompt addition is not stored in the user message and renders as no chat line on web or CLI, so the user's text is preserved verbatim and only the resulting `say` call is visible. **Both session types, like the `say` tool's dual registration:** for server-created sessions the hook is an INLINE pi extension (`createConversationModeSignal().inlineExtension` from `server/src/conversation-mode-hint.ts`, handed to `DefaultResourceLoader`'s `extensionFactories` in both `createAgentSession()` paths; this is the SDK-supported way to get a `before_agent_start` hook on a server-built session) armed per message by `SessionPool.sendUserMessage(..., conversationMode)`; for CLI-bridge sessions the server RELAYS the flag on `cli_message` and the extension's own `pi.on("before_agent_start", ...)` appends the same line (`extension/src/conversation-mode-hint.ts`). **Latch semantics (shared by both):** `arm(active)` is called for EVERY user message so the latest one wins, and the handler CONSUMES the arming, so a turn not started by a flagged message (an auto-retry, or a message typed straight into the terminal pi) never inherits a stale signal. The hint text lives in TWO files because the extension is a separate published package that cannot import from the server (the same constraint that duplicates the `say` tool); `server/test/conversation-mode-hint.test.ts` imports BOTH modules and fails if the text or the latch behaviour drifts.
  - **The system-prompt line is only HALF the signal: the other half is a TAIL REMINDER on the pi `context` event** (`CONVERSATION_MODE_REMINDER` + `withConversationModeReminder()` in the same twin modules, registered in the inline extension and in `extension/src/index.ts`). WHY: the system-prompt append alone is too far from the tail for smaller models (measured on a local 35B: hint ON 3/6 turns spoke, hint OFF 1/6, and the post-tool-result synthesis call almost never spoke), and once the transcript shows earlier unspoken assistant turns the model imitates its own history. `context` fires before EVERY LLM call of the turn (`before_agent_start` fires once per user prompt), and the SDK applies handlers to a `structuredClone` on the way to `convertToLlm` (`transformContext`), so the reminder is EPHEMERAL by construction: never in the session file, the transcript or the TUI. **Placement is ROLE-SAFE:** it rides INSIDE a clone of a `user`/`toolResult` tail as one extra text block and only becomes its own `custom` (`display: false`) message when the tail is an assistant turn or the context is empty — Anthropic merges consecutive same-role turns but Bedrock and some proxies reject them, and after a tool result the tail is already a user turn. **Turn lifecycle:** `before_agent_start` consuming the arming also OPENS the turn (so an unflagged turn explicitly closes a previous one) and `agent_end` closes it (`endTurn()`). **Loop guard:** the reminder is suppressed once an assistant `toolCall` named `say` exists since the last user message, so a model that answers with only a `say` call is not nudged into speaking again, and again.
- **Hands-free mic re-open is a CONFIG decision, not a per-conversation one (`web/src/lib/core/hands-free.ts`).** `decideMicReopen` re-opens the mic on BOTH speech engines when `micReopensAfterReply` is active. An earlier revision auto-recorded only on the BROWSER engine and merely re-focused the composer on the CLOUD engine, to avoid "surprising" the user with a gesture-less recording; that had it backwards, since the user's confirmation lives in the knob they turned ON, and refusing on one engine made the knob lie and left phone users (the most likely to be on the cloud engine) tapping the mic every turn. What the cloud engine actually lacks is a STOP condition (it records until told to stop, unlike the browser engine which ends its own utterance), so `createAutoStopDetector()` ends an AUTO-OPENED cloud recording on silence (2s after speech, 6s if nobody ever spoke) with a hard 60s ceiling. It is fed from the PCM frames `SpeechButton`'s ScriptProcessor already captures (`frameLevel` RMS), NOT a wall clock, so a throttled background tab cannot mis-time it, and the decision STICKS once made. A recording the user opened by TAPPING never gets a detector: their next tap is the stop, and taking that away would be the surprising behaviour.
- **(Removed) prose path auto-linkify:** an earlier approach linkified file-path-looking tokens in assistant prose. Dropped because it was fuzzy (guessed paths, could 404 on out-of-root/non-existent paths).

### Event Flow

1. Client connects via WebSocket
2. Server broadcasts pi lifecycle events:
   - `agent_start` / `agent_end`
   - `message_update` (streaming text)
   - `message_end`
   - `tool_start` / `tool_end`
3. Client sends messages via WebSocket or HTTP
4. Server forwards to pi via `pi.sendUserMessage()`

### Reading transcripts: never materialize a whole session file (`server/src/session-transcript.ts`)

A real sessions directory is GIGABYTES (measured on the author's machine: 3,831 `.jsonl` files / 2.0 GB accumulated since May, single transcripts up to 62 MB) and it only ever grows. Every read path in the server therefore goes through `server/src/session-transcript.ts`, which has one rule: **no code path may hold a whole transcript in memory.** Breaking that rule is what put the server at ~1 GB RSS 45 seconds after boot and, over days, into the machine-wide swap thrash that got it OOM-killed.

The module streams: it finds newlines in the BYTES of a 64 KB chunk (buffers pooled across files), decodes only what is wanted, and classifies each line from a bounded 512-byte HEAD before deciding whether to assemble it at all. pi writes `type` first and the fixed `id`/`parentId`/`timestamp` keys before `message`, so the FIRST occurrence of `{"type":"` / `"message":{"role":"` in a line is always the structural one, whatever the payload text contains: a `toolResult` (file reads, bash output, base64 images -- most of a transcript's bytes) can be recognized and DISCARDED without ever becoming a string.

Two consumers:

- **`readSessionListingInfo`** (one record for the `/sessions` list). Counts every message from the head, and only parses user/assistant lines, which are the ones that can carry the preview or move `modified`. Whether an entry carries text cannot be answered from a bounded head (a thinking block can push the text block past it) and `modified` orders the whole sidebar, so those lines are parsed properly rather than probed.
- **`readTranscriptWindow`** (the history a client actually sees). TWO bounded passes, each bounded at BOTH ends. Pass 1 reads the whole file and materializes nothing (every tool result is behind the window by construction), which is what makes the header, the model (the LAST `model_change`, so only a full pass can know it) and the total authoritative. Pass 2 materializes only the window and STOPS as soon as it is full: without that upper bound a "load older" page near the START of a 60 MB transcript would build every message from there to EOF and then slice, so `history_page` would recreate this module's own problem in miniature (measured 87 MB transient for a deep page vs 16 MB for the tail; now equal). Everything except the messages therefore comes from pass 1, deliberately, since pass 2 stops early. A `toolResult` maps to exactly one history message, so one behind the window is counted from its head and dropped. This replaces three whole-file loads (two of them inside pi's `SessionManager.open`, which loads and parses the file twice, plus a full `HistoryMessage[]` of every entry -- base64 images included -- built only to slice the last 60 off the end).

What this buys is the VIEW path. `loadSession` (the AGENT-BUILD path) still holds the whole transcript, unavoidably: that is the live `SessionManager` the agent runs on, and it needs the full context. Opening a session to READ no longer pays for it.

One bad file must cost ONE session, never the listing: `runDiskScan` skips a transcript whose read throws (with a log line) instead of letting the rejection escape, because that scan promise is SHARED by every concurrent waiter for the view (`inFlightScans`) -- one unreadable file would otherwise 500 the whole dashboard.

Measured on the 2.0 GB corpus, built server, same methodology on both sides: startup peak RSS 990 MB -> 208 MB, settled 426 MB -> 208 MB (a bare server with an EMPTY sessions dir is 164 MB, so the corpus now costs ~44 MB rather than ~260 MB settled / ~825 MB peak). Opening the largest session (59 MB, 1,780 messages): 401 ms of BLOCKED event loop and ~130 MB of RSS growth per open, down to 71 ms non-blocking and a plateau -- 150 consecutive opens settle at ~340 MB peak with live heap flat at 39 MB, where 40 opens on the old path alone reached 825 MB. `server/test/bench/` holds the harnesses that produce these numbers; re-measure with them before trusting any change here.

Nothing in this module may become synchronous or whole-file again "just for one field": `registerCliSession` needed only the session id and was paying a full double load per CLI bridge registration for it (it now reads the header, 8 KB, and falls back to `SessionManager.open` only when there is no header to read).

### Session retention (`sessions.maxAgeDays` / `sessions.maxSessions`)

Listing limits, not deletion. Both are applied to a file's `stat` BEFORE its body is read, so an excluded session costs a `stat` and nothing else; both default to off. They bound the one cost that grows forever: on the author's corpus, `maxAgeDays: 14` takes a cold pass from 1,876 files / 2.4 s to 312 files / 0.7 s. Retention governs the LIST only -- `findDiskSessionByIdOrName` deliberately scans without it, so a deep link to an old session still resolves. The server prints a one-line hint at startup when it lists more than 1,000 sessions with neither limit set, and `wherever install` bakes `MemoryHigh=1G` / `MemoryMax=1500M` into the systemd unit so a memory problem can only ever take down that unit (which `Restart=on-failure` revives) rather than the machine.

### Session-list cost control (`/sessions` cache + `sessions_updated` throttle)

`GET /sessions` is the dashboard's list of every session on disk, and the web refetches it on every `sessions_updated` broadcast. Building it means reading and parsing session `.jsonl` bodies, which on a real sessions directory (measured: ~2,800 files / 1.1 GB / 341k JSON lines) is seconds of work. Three layers keep that from stalling the whole server, and all three must stay in place:

- **The scan is cached and incremental** (`scanDiskSessions` in `server/src/session-pool.ts`). Each file's listing info is read by the streaming reader above (never a whole-file parse) and cached against its `(mtimeMs, size)` stamp; a session `.jsonl` is only ever appended to, so an unchanged stamp means the cached info is still exactly right. The cache retains ~1.2 KB per session (4 MB for 3,727 of them), which `server/test/bench/retained-cache.mjs` measures; tests assert on `getSessionBodyReadCount()` rather than on an fs primitive, since the cheap per-folder header probe also opens files. Entries whose files disappear are evicted at the end of each pass, and a per-directory cwd probe (`dirCwdCache`) means the ignore/read-only folder pre-filter costs one header read per folder, ever. Cold pass ~6.9s (~2.4s since the streaming reader landed) -> warm pass ~90ms on that same directory. `previewText` FLATTENS the capped preview (`flattenString`, a Buffer round-trip): V8 would otherwise keep each preview as a SlicedString pinning the full first message, which cost ~33 MB of retained parents instead of ~3 MB.
- **The scan never blocks the event loop.** It is fully async (`fs.promises`) and yields (`setImmediate`) every few parsed files. This is the part that actually fixed "Loading session..." hanging: the old synchronous `readFileSync` loop pinned the single thread for ~7s per request, so the WebSocket could not deliver `session_created` / `message_history` for the session being opened, and the client's 12s load watchdog could fire. Concurrent requests for the same view share one pass (`inFlightScans`), and `SessionPool.initialize()` warms the cache in the background so the first dashboard load after a restart is warm.
- **Broadcasts are throttled** (`broadcastSessionsUpdated` in `server/src/index.ts`). It listens to `agent_end` only, NOT `message_end` (which fires per message, many times per turn), and is leading+trailing throttled at 2s so structural changes (attach/leave/create/delete) stay instant while a burst collapses into one broadcast. On the web side `fetchSessions()` debounces (150ms, 1s max-wait) and collapses mid-flight requests into exactly one trailing re-fetch.

Note the listing path deliberately does NOT use `SessionManager.listAll()` (pi's own helper) any more, for `/sessions` or for resolving a session by short ID/name: it re-reads and re-parses every session file on every call.

### Conversation search (`GET /search`, backed by the memonaut index)

Full-text search over everything ever said in any session, so a user can find a conversation from six weeks ago and jump straight into it. The text does NOT come from wherever: it comes from [memonaut](https://github.com/wighawag/memonaut) (npm `memonaut`), which indexes the same `~/.pi/agent/sessions` transcripts into one SQLite FTS5 file at `~/.local/share/memonaut/index.db`. Server side lives in `server/src/conversation-search.ts`; the panel is `web/src/lib/components/ConversationSearch.svelte` (a third sidebar view beside the main list and the read-only page), with the snippet/label helpers as a pure, unit-tested module (`web/src/lib/core/search-snippet.ts`).

**Endpoint.** `GET /search?q=<FTS5 expression>&view=default|readonly&limit=20`, behind the SAME token gate as the other API routes (it is in the `isApiRequest` prefix list in `server/src/index.ts`). HTTP, not a WS message, on purpose: a search is a request/response query owned by ONE client, debounced per keystroke and superseded by the next one (the web aborts the in-flight request, so a slow earlier response can never paint over a newer one). Nothing about it is pushed to other viewers or tied to `client.sessionId`, so it stays off the WS protocol entirely. `q` is an FTS5 MATCH expression (bare words ANDed, `"quoted phrases"`, `OR` / `NOT` / `NEAR`, trailing `*`); memonaut retries an unparseable query as quoted literal tokens and reports that as `quotedFallback`.

**Result shape.** `{status, query, usedQuery, quotedFallback, hits[], scanned, hiddenHits, index: {path, files, entries, newest}, message?}`. `status` is `ok` | `not-indexed` | `unavailable` | `error`, always with HTTP 200: a missing index is an ANSWER the dashboard explains ("run `recall index`"), not a failed request. Each hit is `{entryKey, role, kind, tool, ts, snippet, score, threads[], threadTotal, otherHits}`, and each thread is `{sessionPath, name, cwd, folderName, project, lastActivity, entryCount, seq, after, isRoot, readOnly}`. `snippet` keeps SQLite's raw `\u0001`/`\u0002` match markers (the web turns them into `<mark>` via `snippetSegments()`, never `{@html}`), so the server never has to know about markup.

**The join key is the PATH.** memonaut's `file.path` is the absolute transcript path, which is exactly what wherever identifies a session by, so `sessionPath` is run through the same `normalizeSessionFile()` (`path.resolve`) that `buildFolders` uses for `path` / `parentSessionPath`. A result is therefore byte-identical to the corresponding `FolderSessionInfo.path`, and a click is just `switchSession(sessionPath)`, the same call the sidebar makes: it lands in the existing session view (and the existing fork tree) with no extra resolution step.

**Forks are never collapsed.** A fork copies the whole shared prefix, so one matched entry is carried by every thread that inherited it. memonaut returns them most-recently-active first with per-thread `after` counts (how many entries that thread accumulated past the match, which is the only thing telling byte-identical siblings apart); the endpoint passes ALL of them through and the panel renders the most recent as the primary target with "carried by N sessions" expanding to the siblings, each independently clickable.

**Privacy: two independent axes, composed in ONE place** (`filterThreads()` in `server/src/conversation-search.ts`). memonaut's `ignore`/`private` govern what is INDEXED and what AGENTS may read; wherever's `sessions.ignore`/`sessions.readOnly` govern what the DASHBOARD shows and what may be written to. They are not the same question and must not be conflated, so search obeys both:

- memonaut `ignore` -> never indexed, invisible here by construction.
- memonaut `private` -> the endpoint NEVER passes `includePrivate`, so those transcripts are never returned. Search does not get to override the user's "do not hand this back" boundary.
- wherever `sessions.ignore` -> dropped on EVERY view. A session hidden from the dashboard must not be readable through search, or search becomes a way to see exactly what the user hid.
- wherever `sessions.readOnly` -> mirrors `/sessions` exactly: `view=default` drops them, `view=readonly` returns ONLY them (still minus `ignore`), tagged `readOnly: true`. One rule for both surfaces, so what you can see never depends on which one you used.
- Filtering is per THREAD, not per hit (one entry in shared history can be carried by both a visible and a hidden session), and `threadTotal` is RECOMPUTED from the survivors, so a hidden fork does not leak even as a count. A thread whose cwd is unknown is dropped (fail closed). A hit left with no visible thread is dropped and counted in `hiddenHits`. The matchers are compiled once per request, as `listSessions` does, not once per hit.
- Like the session list, the globs are matched against the RESOLVED (`path.resolve`) cwd, which does not follow symlinks: a cwd reached through a symlink matches (or fails to match) a pattern exactly as it does in `/sessions`. Consistency between the two surfaces is the property that matters; a search-only symlink resolution would be a way for the two to disagree.

**Never index on a request path.** `node:sqlite` is SYNCHRONOUS and so is memonaut's indexer: a full build is ~40 s of blocked event loop, which would freeze every WebSocket client (the same failure mode the `/sessions` cache exists to avoid). So the endpoint NEVER calls `index()`, and never calls `syncIfStale()` either (it opens the DB read-write and can itself trigger a full rebuild). Missing index -> `status: 'not-indexed'` naming the db path and `recall index`. Catch-up instead happens in a CHILD PROCESS (`maybeSpawnSync`: `node <memonaut>/dist/cli.js index`, TTL-gated at 60 s, at most one in flight, stdio ignored, never awaited), fired only AFTER the response is built, so a search is served from the index as it is and may be one sync behind. `conversationSearch.autoSync: false` in `~/.wherever/config.json` disables it; `conversationSearch.syncIntervalMs` changes the TTL.

**Not implemented (deliberately):** a result opens the SESSION, not the matched message. memonaut reports the match's `seq` within each thread, but wherever's history windowing is by message offset, so scrolling straight to the entry would need a seq -> offset mapping; that is a separate change and search is useful without it.

**What DOES run in-process** is one `search()` call against a cached read-only handle (`openDb(path, {readOnly: true})`, which also sets `PRAGMA query_only`; wherever never writes to the index). Measured on a real index (3,822 files / 464k entries): open ~0 ms, `indexStats` ~17 ms, `search()` 14-66 ms, end-to-end endpoint work ~100-120 ms. The same numbers are quoted in the module header, so keep the two in step if they are ever re-measured. That is the same order as a warm `/sessions` pass and only happens on a debounced human action, which is why it is acceptable in-process; anything heavier is not. The `memonaut` import is dynamic, so a server whose dependency is missing answers `status: 'unavailable'` instead of failing to boot.

### Queued steers are memory-only state (`queue_update` is a snapshot, not just an event)

A message sent while the agent is streaming is QUEUED by pi as a steer and injected at the next step boundary. Until that injection it exists ONLY in `AgentSession`'s in-memory queue: it is not in the session `.jsonl`, so `message_history` can never contain it. That makes the queue a piece of live state a client cannot reconstruct on its own, and it must be re-sent on every attach: `session_load` (the same handler serves a first load, a reload and a reconnect resync) replies with a `queue_update` snapshot built from `pool.getSteeringQueue()` (pi's `getSteeringMessages()`), after `message_history` / `session_ready`. CLI-bridge sessions have no readable queue, so they send no snapshot at all rather than asserting an empty one.

On the client, `queue_update` both replaces `pendingSteering` AND re-materializes any queued text with no matching user message (`withRestoredQueuedMessages`), because a snapshot alone would set a pending-steer set with nothing on screen to badge. Matching is by CONTENT with occurrence COUNTING (pi exposes no per-entry id), so a locally-sent optimistic steer is not duplicated and a text queued twice restores two bubbles. Restored bubbles are tagged `restoredFromQueue` and carry NO `delivery` state: they are already held by the server, so tracking them would arm a confirmation watchdog and offer a bogus "Retry". When pi finally injects one, the server's user echo (`message_end` role:user) reconciles ONTO the tagged bubble instead of appending a duplicate: content-matching only the LAST user message is not enough, since a queue of several is delivered oldest-first.

### Read-only is one verdict with THREE reasons (and a precedence between them)

`readOnly` is a per-CLIENT verdict the server owns and re-states authoritatively; the client mirrors it and never invents one. Three different things can produce it, and they are not interchangeable:

- **A configured read-only folder** (`sessions.readOnly` glob, `pool.isReadOnlyCwd`). A policy rule: observe-only by the user's own configuration. HARD, never lifted.
- **FOLDER MISSING**: the session's working folder does not exist on this machine. HARD, but CURABLE: restore the folder, then RELOAD the session.
- **A folder conflict**: another live session in the same folder. The only DISMISSIBLE one ("Continue anyway" -> `folder_conflict_continue`).

Precedence lives in ONE function, `hasHardReadOnly()` in `server/src/index.ts`: every site that would LIFT read-only (the continue handler, and the conflict resolving on its own in `resolveFolderConflictState`) asks it first, so the dismissible reason can never dismiss a hard one. A missing folder that ALSO matches a `sessions.readOnly` rule stays locked after a restore, as it must.

### A missing working folder is a first-class session state (`folder_missing`)

Transcripts and the folders they refer to travel separately: a transcript syncs across machines (syncthing, a backup, a new laptop), the git clone it talks about does not. Such a session used to load as if nothing were wrong -- the cheap header+history read never needed the folder, and pi's `SettingsManager.create()` and `DefaultResourceLoader.reload()` both SUCCEED against a nonexistent cwd, so the cold path happily built a live agent whose every file/bash tool then misbehaved for no stated reason.

- **Detection** is one `stat`, in `readSessionMeta` (`server/src/session-pool.ts`), beside the read-only verdict it already computes from the cwd, so the warm and the cold load branch share it. A path that exists but is not a directory counts as missing. Detection is **load-time only**: a folder that disappears UNDER a live session is deliberately out of scope (watching every session's cwd is a different mechanism), so a RESIDENT session is locked read-only for anyone loading it while its running agent is left alone.
- **A restore IN FLIGHT produces the same state.** `session_load` ORs the `stat` with "a restore job is `running` for this cwd" (`restoreJobs.get(cwd)`), because `git clone` creates the target directory in its first breath: for the whole of a multi-minute clone the existence check says "present", and a client loading in that window (a reconnect, a second device) would be handed a live agent pointed at a HALF-CLONED tree -- the same silent breakage this state exists to replace. So the state means "this folder is not usable as a working folder", with two producers (absent, or being materialised) and one remedy, one rendering, one frame. It is NOT a second state: forking a `folder_restoring` concept would double the client state and the UI branch for something whose cure and appearance are identical.
- **The cold path does NOT build the agent.** `session_load` paints `session_created` (`readOnly: true`, `folderMissing: true`, `pending: true`) + `message_history` + the new `folder_missing` frame, then STOPS: no `session_ready`, no agent, and the client is detached from whatever it was on (nothing was attached, so it must not keep a phantom viewer in the old folder). Since a live agent is a load-time decision, the cure is a restore plus a RELOAD.
- **Frames.** `session_created` carries `folderMissing?: boolean` (the flag), and `folder_missing { sessionId, cwd, job? }` states it authoritatively with the ABSOLUTE missing path so the UI can name what to restore. `job` is any restore job already running (or just finished) for that path, so a client arriving MID-CLONE repaints it instead of being offered a second one. Remote CANDIDATES deliberately do NOT ride on this frame (see below): resolving them can shell out to a provider CLI, and this frame is on the session-load path. The shared client mirrors it into `WhereverState.folderMissing` (`FolderMissingInfo`) plus `WhereverState.restore` (`RestoreInfo`), and the web dashboard replaces the composer with the restore panel.
- **Older clients degrade safely**: they simply do not render the notice or the panel. The protection is the SERVER's refusal -- a `message` from a client whose loaded session has a missing folder is refused by PATH (`client.folderMissingCwd`), before the attachment check that would otherwise drop it silently. The refusal names the folder, and says "still being restored" rather than "does not exist" while a job is running for it.

**Vocabulary, pinned:** the STATE is `folder missing` (frame `folder_missing`, flag `folderMissing`, `WhereverState.folderMissing`); `restore` names only the ACTIONS that cure it (cloning or creating the folder) and everything in that family is namespaced `restore*` -- the frames `restore_start` / `restore_cancel` / `restore_started` / `restore_rejected` / `restore_progress` / `restore_complete`, the state `WhereverState.restore`, the client methods `startRestore` / `cancelRestore`. Do not fork either term: `restore` already has an unrelated in-codebase meaning for re-materialising queued steers and saved drafts after a reload (`restoredFromQueue`), so a missing folder is never "unrestored", a queued steer is never "missing", and a frame about queued steers is never `restore_*`.

### Restore jobs are path-keyed and live in one standalone module (`server/src/restore-jobs.ts`)

A **restore job** materialises a missing working folder, either by CLONING a remote or by CREATING an empty folder (optionally `git init`ed). Both kinds are ONE state machine (`running` -> `done` / `failed` / `cancelled`) so a caller never drives two.

- **Keyed by the resolved absolute TARGET PATH**, never by socket, client or session (`docs/adr/0009`). That is what makes a clone survive a dropped phone socket, be shared by two tabs, and never be started twice for one folder. A second request for a path with a RUNNING job COALESCES: the result says `outcome: 'joined'` and carries the job INCLUDING the url it is really cloning, so a requester whose edited URL differs is told a clone of the other URL is in flight rather than silently answered as though its own was accepted. Terminal jobs are RETAINED briefly (`retainMs`, default 60s) so a late reconnect still learns the outcome, then reaped.
- **The module owns the observation seam.** `subscribe(targetPath, { onProgress, onSettled })` returns an unsubscribe function, and subscription is keyed by PATH (independent of any one job), because two independent consumers are coming: the WS broadcast to matching clients, and a per-folder existence-cache invalidation. Neither reaches into the registry's internals, and neither is wired through the other.
- **Progress is honest.** `git clone --progress` REWRITES one line in place, so frames are separated by CARRIAGE RETURNS inside a single newline-terminated chunk; `GitProgressParser` treats `\r` as a separator (a newline-only parser sees almost nothing during the receiving phase, which is where a long clone spends its time). Each frame carries a `phase`, a `scope` and either a `percent` or `indeterminate: true` (explicitly, never a fake 0). Submodules report under their OWN scope (their path relative to the target), never folded into one global percentage. Emission is throttled to ~5 fps, with a phase or scope change always emitted.
- **Safety, all refused before anything is spawned:** the target must resolve INSIDE the home directory (`isWithinHome`, mirroring the HTTP layer's guard in `index.ts`, resolved at CALL time), the leaf must be absent or empty (the parent is created), and the URL must match a SHAPE ALLOWLIST (scp-style SSH, `ssh://`, plus `file://` for fixtures) that rejects control characters, newlines and a leading dash. The clone runs through an argv ARRAY with no shell (`buildCloneArgs`), and that argv NEVER carries a relaxation of git's file-transport protection: the tests inject `protocol.file.allow` through their own `GIT_CONFIG_COUNT` environment instead.
- **SSH only, and the failure message is the deliverable** (`docs/adr/0010`). `buildCloneEnv` disables every interactive prompt (`GIT_TERMINAL_PROMPT=0`, no askpass, no `DISPLAY`, `ssh -o BatchMode=yes -o ConnectTimeout=10`) so an unprovisioned box fails FAST instead of hanging invisibly at zero percent, and `mapCloneFailure` names the cause (`no-key`, `unknown-host`, `not-found`, `network`, else verbatim) while keeping git's raw stderr underneath. Git's "correct access rights and the repository exists" trailer is deliberately NOT used as a signature: it is printed for a missing key AND a missing repo.
- **Cancel is AUTHORITATIVE**: the child is signalled and the job settles `cancelled` even if it happened to finish in the same breath, and the target directory is removed ONLY when the job created it.

### Remote candidates are advisory, SSH-only, and fetched on demand (`GET /remote-candidates`)

A **remote candidate** is a suggested SSH URL for the repository a MISSING folder probably is: it pre-fills the restore panel's editable URL field so a repo can be restored from a phone without typing one. It is ADVISORY and never an authority -- the restore job clones what it is finally GIVEN (after its own validation), not what was guessed. `server/src/remote-candidates.ts` resolves an ORDERED list from two sources, in decreasing confidence:

- **The provider PROBE**, when the folder matches a configured `remoteRepoRules` entry: the same provider CLI the create-session path uses (`detectRemoteRepo`) is asked whether the repository exists, and its SSH URL is taken. This covers what the configured account OWNS.
- **The PATH CONVENTION**, `<...>/<host-token>/<owner>/<repo>` read back into `git@host:owner/repo.git` from the LAST THREE segments. This is the load-bearing half, not a nicety: it covers repositories owned by SOMEONE ELSE, which the probe structurally cannot find, and those dominate the machine migration this feature exists for (one rule, one personal namespace, a tree full of other people's repos). Known tokens are `github`, `codeberg`, `gitlab`, plus any token that is ALREADY a dotted hostname (`git.example.com`); `gitea`/`forgejo` are absent on purpose (software, not a host). An unknown token or a too-shallow path yields NO candidate rather than a confidently wrong one, and an empty list is an honest answer.

**SSH only** (`docs/adr/0010`): no HTTPS candidate is ever synthesised, and a probe result that is not an SSH URL is dropped rather than offered. **A probe failure of any kind** (CLI missing, not authenticated, repository absent, a throw) degrades to the derived candidate instead of erroring, and a folder no rule covers is never probed at all. The probe function is INJECTED (`resolveRemoteCandidates(path, rules, probe?)`), so the module stays standalone like `restore-jobs.ts` and its tests never need a provider CLI installed or logged in.

**Placement:** `GET /remote-candidates?path=` sits beside `/check-remote-repo`, behind the same token gate (`isApiRequest`), and refuses a path outside the home directory as `/check-path` does. It is called ON DEMAND (the panel opening), never per keystroke and never on session load, because the probe shells out. Rule matching is now ONE implementation, `matchRemoteRepoRule`, shared by `/check-path`, `/check-remote-repo` and the resolver (`session-pool.ts` still has its own untilded copies; see `work/notes/observations/remote-repo-rules-untilded-in-session-pool.md`).

### The restore panel: path-addressed frames, DERIVED subscription, and a reload to go live

The user-facing half of the restore: in place of a folder-missing session's composer the dashboard renders `web/src/lib/components/RestorePanel.svelte` -- the missing path, an editable URL pre-filled from `GET /remote-candidates`, a Clone button, honest progress, a Cancel while it runs, and on success a RELOAD. The wiring lives in `server/src/index.ts` and drives `restore-jobs.ts`; nothing about the job moved into the WebSocket layer.

- **Frames** (all `restore_*`, all addressed by `targetPath`, never by session id, because the job's key IS the path). Client -> server: `restore_start { targetPath, action: 'clone' | 'create', url?, gitInit? }` and `restore_cancel { targetPath }`. Server -> client: `restore_started { targetPath, outcome: 'started' | 'joined', job }` and `restore_rejected { targetPath, reason, message }` (answers to THIS client's request, sent to it alone), plus `restore_progress { targetPath, job }` and `restore_complete { targetPath, job }` (broadcasts; `restore_complete` carries every terminal state -- read `job.state` for `done` / `failed` / `cancelled`). Each frame carries the whole `RestoreJobSnapshot`, so ONE frame is enough to repaint a panel from scratch.
- **Subscription is DERIVED, never registered.** `clientWatchesRestorePath()` matches the job path against each connected client's attached session cwd, its `pendingCwd` (a load painted but not yet attached) and its `folderMissingCwd` -- the last of which is the load-bearing one, since a folder-missing load deliberately attaches to NOTHING and clears `pendingCwd` with it. Because the match is evaluated per frame, a dropped phone leaves no bookkeeping behind and a reconnecting one is matched again for free. The server holds ONE registry subscription per observed path (`restoreObservers`), taken before the request (a request can settle synchronously) and released inside `onSettled`, so an observer cannot outlive its job.
- **A second tap JOINS.** The registry coalesces on the path, and `restore_started` reports `outcome: 'joined'` with `job.url` = the url REALLY in flight. The client keeps its own `requestedUrl` beside it precisely so the panel can say "a clone of X is already running, your URL was not used" instead of silently answering as though the edited URL had won.
- **A rejection is not a job.** An unsafe target, a non-empty folder or a URL outside the allowlist is refused before anything is spawned, so there is no job, no id, and no completion coming: `restore_rejected` is a separate frame rather than a synthetic failed job, and the panel stays in its offer state.
- **Cancel is not authorised per client.** Any client watching the folder may cancel the job, including one that did not start it -- which is the point when the device that did is the one that went away. Safety comes from the registry's own guards (inside the home directory, empty leaf, URL allowlist, argv arrays), the same layer that protects `session_new`.
- **Progress rendering is honest** (story 8): a phase, a scope, and either a real percentage or an explicit indeterminate bar with the words "no percentage". Submodules render under their own scope with a standing note that each is counted separately, so there is never a single fake global percentage.
- **TWO remedies, ONE state machine, and the second one is SECONDARY.** Beside Clone the panel offers CREATE (`action: 'create'`), for a folder that was never a clone: it makes the directory and any missing parents, optionally `git init`s it, and lands in the SAME running / ready / failed states and the same reload ending, because it is the same path-keyed job with the same guards (inside the home directory, empty leaf). Create sits behind a disclosure ("This folder was never a clone? Create it instead") with a secondary button, deliberately: it is the rare case, and an accidental tap makes an EMPTY folder that then LOOKS restored while the non-empty guard refuses the clone that should have happened. The panel is kind-aware (`job.kind`) for its wording, and drops the submodule note and the scope label for a create, which has exactly one scope.
- **The git-init checkbox is the CONFIGURED default, not a second one.** It seeds from `gitInitDefault` (`GET /config` -> `gitInitDefaultStore`), the same value the new-session dialog reads, so a user who turned it off gets no surprise repository here either; the user's own tick then wins for that panel. The panel refreshes `/config` itself when it opens for a folder (beside the candidates call, same token gate) rather than depending on the session browser having fetched it, and the choice travels EXPLICITLY as `gitInit` in both states so no default is re-decided server-side.
- **It ends in a RELOAD** (`client.reloadSession()` -> a fresh `session_load` of the same file). Whether a session has a live agent is a load-time decision and the load that found the folder missing built none, so re-loading is the actual remedy, not a refresh hint. The NEW-SESSION path cannot do this (there is no session to reload until the clone lands) and continues into creation itself instead; see `docs/adr/0009`.

### Message routing authority (the client-stamped sessionId is authoritative)

Every WS `message` (and `abort`) carries the `sessionId` of the session the client is actually viewing (`{ type: 'message'; message; sessionId }`). The server treats that stamp as AUTHORITATIVE: in `server/src/index.ts` the `message`/`abort` handlers resolve `msg.sessionId` through the pool and verify it resolves to the SAME `TrackedSession` this connection is attached to (`client.sessionId`). On a mismatch the message is REFUSED with a `session_error` (the client surfaces it as a recoverable, retryable failure via its delivery watchdog + Retry) instead of being delivered to whatever `client.sessionId` currently points at. This closes a switch/reconnect/resync race: `client.sessionId` is per-connection and is only (re)attached when a `session_load` completes (for a cold load, seconds later inside the async agent-build block; a reconnected socket starts with `client.sessionId = null`), so it could be stale relative to the session the client had already painted and targeted, silently misrouting a message into another session's agent. Never route a `message`/`abort` by `client.sessionId` alone without validating it against the client-stamped `msg.sessionId`.

### Version reporting (frontend build id + server version)

The two halves of the app version independently and can drift: the web build carries the short git commit baked in at build time (`web/svelte.config.js` sets `kit.version.name` from `git rev-parse --short HEAD`, plus a `-dirty` suffix), while the server is an installed npm package (`wherever-dev`) whose version is read at runtime from its own `package.json` (`getVersion()` in `server/src/index.ts`). A stale server behind a fresh frontend looks exactly like a frontend bug, so BOTH are surfaced: the `connected` WS message carries `serverVersion`, the client stores it in `WhereverState.serverVersion` (null until connected, and for servers old enough not to send it), and the connection panel renders `v<build> / srv <version>`.

## Current Status

✅ **Completed:**

- Core extension with HTTP/WebSocket server
- Reference client implementation
- Complete API documentation
- Package configuration
- Git repository initialized
- Initial commit made

⏳ **Next Steps:**

1. Install dependencies and test locally
2. Push to GitHub
3. ✅ Build web frontend (mobile-friendly)
4. ✅ Build marketing site (GitHub Pages)
5. Add more example clients
6. Consider publishing to npm as pi package

## Usage Commands

```bash
# Development
cd /home/wighawag/dev/github/wighawag/wherever
pnpm install
pnpm run build

# Test the extension
pi --extension ./dist/index.js --remote-port 31415 --remote-token test123

# Test the client
pnpm run client -- --url ws://localhost:31415 --token test123

# Push to GitHub
git remote add origin git@github.com:wighawag/wherever.git
git push -u origin main
```

## Security Considerations

⚠️ **Important:**

- Always use `--remote-token` for remote access
- Default binding is localhost only (`127.0.0.1`)
- For remote access, use SSH tunneling:
  ```bash
  ssh -L 31415:localhost:31415 user@remote-machine
  ```
- If binding to `0.0.0.0`, ensure strong authentication
- Consider adding rate limiting for production use

## Mobile Usage (Original Motivation)

The extension was created to enable mobile control of pi without relying on SSH clients. Options:

1. **Simple Web Interface** - Build a mobile-friendly web UI (not yet implemented)
2. **WebSocket Apps** - Use existing mobile WebSocket clients
3. **SSH Tunnel + Local Connect** - Tunnel to mobile, connect via localhost

## File Structure

```
wherever/
├── src/
│   ├── index.ts          # Main extension (server)
│   └── client.ts         # Reference client
├── docs/
│   └── USAGE.md          # Complete API docs
├── web/                  # SvelteKit dashboard app (mobile-friendly)
├── site/                 # Standalone marketing/info website (GitHub Pages)
├── vscode/               # VS Code Companion extension (Sidebar Chat GUI)
├── client/               # Isomorphic TS Client module
├── server/               # Multi-session standalone server
├── package.nix           # the derivation, a plain function of `pkgs` (consumer interface)
├── flake.nix             # `nix develop` (toolchain) + `nix build`, a wrapper over package.nix
├── nix/                  # pnpmDepsHash update + staleness-check scripts
├── .github/
│   └── workflows/
│       └── deploy-gh-pages.yml  # CI/CD for marketing site
├── package.json          # Dependencies + pi config
├── tsconfig.json         # TypeScript config
├── README.md             # Quick start
├── CONTEXT.md            # This file
├── LICENSE               # AGPL-3.0
└── .gitignore
```

## Key Design Decisions

1. **WebSocket-first** - Real-time streaming is essential for agent interaction
2. **HTTP fallback** - Simple REST API for programmatic access
3. **Optional auth** - Token-based, easy to disable for local dev
4. **Event broadcasting** - All clients receive same events (multi-client support)
5. **Message queuing** - Messages queued if no client connected (up to 100)
6. **Separate web UI** - Dashboard (`web/`) and marketing site (`site/`) are independent SvelteKit apps
7. **GitHub Pages** - Marketing site deployed via GitHub Actions to `github.com/wighawag/wherever`

## Agent Guidelines

⚠️ **Important for AI Agents:**
Please review **`AGENTS.md`** in the root of the project before completing any work. It contains essential guidelines, including the requirement to **always create a changeset** with a good description when done.

## Known Limitations

- No rate limiting (add for production use)
- No connection persistence/reconnection logic (client responsibility)
- Single active WebSocket for broadcasting (all clients get same stream)
- No extension UI dialog forwarding (confirmations happen on server side)

## Future Enhancements

Potential additions:

- [ ] Multiple WebSocket rooms/sessions
- [ ] Rate limiting middleware
- [ ] WebSocket reconnection logic
- [ ] Extension UI dialog forwarding to remote clients
- [ ] Custom tool registration via API
- [x] File transfer capabilities (upload via `/session/upload`; download via `/session/download`, surfaced as a download button + inline image preview on `read` tool cards plus the `attach_file` tool for explicit/"give me the X" deliverables)

## Related Pi Documentation

- [Pi Extensions](https://pi.dev/docs/extensions.md) - Extension API reference
- [Pi RPC Mode](https://pi.dev/docs/rpc.md) - Alternative integration method
- [Pi SDK](https://pi.dev/docs/sdk.md) - Programmatic usage

## Contact & Contributing

- Repository: `github.com/wighawag/wherever`
- License: AGPL-3.0-only
- Contributions welcome!

## Conventions

Standing per-change rules agents must follow in this repo.

- **Always create a changeset when done** (`pnpm changeset`, or a hand-written
  `.changeset/*.md`). See `AGENTS.md` §1 for the full rule. Package-mapping:
  - **web** and **server** changes → `"wherever-dev": <bump>`.
  - **extension** changes (`extension/`) → `"@wherever-dev/pi": <bump>`.
  - Never use `"@wherever-dev/web"` — the `web` package is private and its built
    artifacts ship inside `wherever-dev`.
- **Never stage/commit** unless explicitly asked; leave changes unstaged.
- **Never revert / do destructive git ops** without explicit confirmation.
- Enforcement, if wanted, belongs in the `dorfl.json` `verify` gate (e.g.
  `changeset status --since=main`) — not injected automatically.

## The work/ contract

This repo is onboarded onto the file-based **`work/` contract** (defined by the
docs in `work/protocol/`, synced by the `setup` skill; `dorfl.json` carries the
`verify` gate and `harness`). Layout — status is the FOLDER an item lives in,
never a frontmatter field; the folder is the index (no hand-maintained lists):

- `work/notes/{observations,ideas,findings}/` — capture buckets. `observations`
  = spotted/unverified; `ideas` = proposed; `findings` = verified **external**
  ground-truth, each with a `source:` (our own architecture goes in this
  `CONTEXT.md` / `docs/`, never in `findings/`).
- `work/tasks/{backlog,ready,…}/` — the build board (`backlog` = staging,
  `ready` = the pool).
- `work/specs/{proposed,ready,…}/` — the spec lifecycle (`proposed` = staging,
  `ready` = the pool). The three specs in `specs/ready/` were migrated here from
  the old `work/briefs/ready/`.
- `work/questions/` — the "what needs me?" queue. `work/protocol/` — the synced
  contract reference docs (protocol-owned; re-synced, never hand-edited).

Architectural rationale lives in `docs/adr/` (decisions); product framing in
`work/specs/`.

---

**Note:** This document is meant to provide full context when moving to a new conversation/session. All essential project information should be here.
