# wherever is kenning's host for spawn and stop: sidebar sessions, waking its own children, deletes cascade as one undoable batch

**Status:** accepted (2026-11-18)

kenning's `session_spawn` and `session_stop` (its D23 to D31, ADRs 0007 and 0008) run inside a session and hand the work to the process's registered host, else to a terminal default (a zellij pane or a headless `pi -p`). wherever runs many sessions in one server process and shows them in a sidebar, so a session spawned from a wherever session should be a wherever session, under its owner, not a stray headless process.

We decided:

- **One host for the server process** (`WhereverKenningHost`, `server/src/kenning-host.ts`), registered at start on kenning's registry (`globalThis[Symbol.for('kenning.host')]`, shape `{version: 1, entries: [{host}]}`), written directly against that contract rather than through kenning's `registerHost`, so the server does not load kenning (and `node:sqlite`) for a user who does not use it. A test pins it against kenning's `currentHost()`. `kenning.enabled: false` registers nothing.
- **`spawn` creates a sidebar session and sends nothing into it.** `SessionPool.spawnSession` builds a live agent in the asked folder (a branch of another transcript with `fork`, written by pi's `SessionManager` into that folder's session dir, kenning D34), names it after kenning's `title`, and resolves with its file. kenning binds it and delivers the first prompt as a `spawn` message from the owner, origin `agent`, which wakes the idle session. wherever never emits a human-input mark for it.
- **`stop` aborts only that session's run** (`abortSession`): `stopped`, `not-running`, or `not-mine` for a session outside the pool. Nothing it owns is touched.
- **wherever wakes the children it spawned.** kenning wakes only its own headless children (D29). A server session the pool evicted while idle, or that a restart left unloaded, is loaded again when a message is pending for it that came after its last stop and it is not archived; kenning-pi then delivers. The spawned files are recorded in `<stateDir>/kenning-children.json`.
- **A terminal pi bridged to a server spawns on the server.** `@wherever-dev/pi` registers its own host while connected to a server that answers `kenning_host_info` with `available: true`, and removes it on disconnect, so kenning falls back to its terminal default exactly when no server can carry the spawn. Its `spawn` and `stop` go over `cli_request` (`kenning_spawn`, `kenning_stop`), and the server accepts them only on behalf of the session that connection REGISTERED.
- **The sidebar shows ownership** from the `/sessions` listing's `ownerSessionPath` (kenning's `ownerOf`, memoized until the next kenning change): a "spawned by" line on the child, and links to its children under the owner, across folders (a worktree child lives elsewhere).
- **Deleting a session that owns others cascades as ONE undoable batch** (kenning D24): `archive(session, {kind: 'deleted', by: 'web'})` marks it and its owned subtree; wherever hides every session in the batch, closes their resident agents, keeps the transcripts, and offers Undo for 7 days. Transcripts are removed only for marks kenning lists in `expiredArchives()` (checked at start, then hourly). A session that owns nothing is deleted at once, as before.

## Considered Options

- **Let kenning spawn a headless `pi -p` from a wherever session.** Rejected: an unseen process the web cannot open, steer or stop.
- **Register through kenning's `registerHost`.** Rejected for now: it loads kenning at server start for every user; the registry is a documented contract.
- **Keep owned children resident (never evict them).** Rejected: pinning does not exempt server sessions from idle eviction (only CLI bridges), and an orchestration can leave dozens of children idle for days; loading on a pending message costs nothing while idle.
- **Cascade every delete through kenning.** Rejected: it would change the delete of every session for users who never spawn anything.

## Consequences

- An evicted child whose transcript was never written (it never finished a turn) cannot be loaded again; in practice the owner's first message wakes it at once.
- `archived` (as opposed to `deleted`) has no wherever surface yet: wherever has no archive concept.
- A deep link to a session hidden by a cascaded delete still opens it.
