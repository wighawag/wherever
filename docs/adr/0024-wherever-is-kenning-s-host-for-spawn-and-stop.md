# wherever is shipmates' host for spawn and stop: sidebar sessions, waking its own children, deletes cascade as one undoable batch

**Status:** accepted (2026-11-18)

shipmates' `session_spawn` and `session_stop` (its D23 to D31, ADRs 0007 and 0008) run inside a session and hand the work to the process's registered host, else to a terminal default (a zellij pane or a headless `pi -p`). wherever runs many sessions in one server process and shows them in a sidebar, so a session spawned from a wherever session should be a wherever session, under its owner, not a stray headless process.

We decided:

- **One host for the server process** (`WhereverShipmatesHost`, `server/src/shipmates-host.ts`), registered at start on shipmates' registry (`globalThis[Symbol.for('shipmates.host')]`, shape `{version: 1, entries: [{host}]}`), written directly against that contract rather than through shipmates' `registerHost`, so the server does not load shipmates (and `node:sqlite`) for a user who does not use it. A test pins it against shipmates' `currentHost()`. `shipmates.enabled: false` registers nothing.
- **`spawn` creates a sidebar session and sends nothing into it.** `SessionPool.spawnSession` builds a live agent in the asked folder (a branch of another transcript with `fork`, written by pi's `SessionManager` into that folder's session dir, shipmates D34), names it after shipmates' `title`, and resolves with its file. shipmates binds it and delivers the first prompt as a `spawn` message from the owner, origin `agent`, which wakes the idle session. wherever never emits a human-input mark for it.
- **`stop` aborts only that session's run** (`abortSession`): `stopped`, `not-running`, or `not-mine` for a session outside the pool. Nothing it owns is touched.
- **wherever wakes the children it spawned.** shipmates wakes only its own headless children (D29). A server session the pool evicted while idle, or that a restart left unloaded, is loaded again when a message is pending for it that came after its last stop and it is not archived; @shipmates/pi then delivers. The spawned files are recorded in `<stateDir>/shipmates-children.json`. Since then widened to every server session the pool unloaded, not only children: @shipmates/pi delivers only in a loaded session, so a plain sidebar session told something after its idle eviction sat on the message until the human opened it. Such a session is loaded again under the rule its own delivery would have applied (waking off, `waiting-for-human` admitting only a human-origin message, what was pending at unload stays held), recorded as it leaves the pool in `<stateDir>/shipmates-unloaded.json`; see CONTEXT.md.
- **A terminal pi bridged to a server spawns on the server.** `@wherever-dev/pi` registers its own host while connected to a server that answers `shipmates_host_info` with `available: true`, and removes it on disconnect, so shipmates falls back to its terminal default exactly when no server can carry the spawn. Its `spawn` and `stop` go over `cli_request` (`shipmates_spawn`, `shipmates_stop`), and the server accepts them only on behalf of the session that connection REGISTERED.
- **The sidebar shows ownership** from the `/sessions` listing's `ownerSessionPath` (shipmates' `ownerOf`, memoized until the next shipmates change): a "spawned by" line on the child, and links to its children under the owner, across folders (a worktree child lives elsewhere).
- **Deleting a session that owns others cascades as ONE undoable batch** (shipmates D24): `archive(session, {kind: 'deleted', by: 'web'})` marks it and its owned subtree; wherever hides every session in the batch, closes their resident agents, keeps the transcripts, and offers Undo for 7 days. Transcripts are removed only for marks shipmates lists in `expiredArchives()` (checked at start, then hourly). A session that owns nothing is deleted at once, as before.

## Considered Options

- **Let shipmates spawn a headless `pi -p` from a wherever session.** Rejected: an unseen process the web cannot open, steer or stop.
- **Register through shipmates' `registerHost`.** Rejected for now: it loads shipmates at server start for every user; the registry is a documented contract.
- **Keep owned children resident (never evict them).** Rejected: pinning does not exempt server sessions from idle eviction (only CLI bridges), and an orchestration can leave dozens of children idle for days; loading on a pending message costs nothing while idle.
- **Cascade every delete through shipmates.** Rejected: it would change the delete of every session for users who never spawn anything.

## Consequences

- An evicted child whose transcript was never written (it never finished a turn) cannot be loaded again; in practice the owner's first message wakes it at once.
- `archived` (as opposed to `deleted`) has no wherever surface yet: wherever has no archive concept.
- A deep link to a session hidden by a cascaded delete still opens it.

Rename note (2026-11-22): this ADR was written when shipmates was called kenning (packages `kenning` and `kenning-pi`, now `shipmates` and `@shipmates/pi`; shipmates spec D38). Its text now uses the new names throughout: the `shipmates:human-input` events, `Symbol.for('shipmates.host')`, the `shipmates_*` frames and bridge ops, the `shipmates-*.json` state files and the `shipmates.enabled` switch were all `kenning` before. The decision itself did not change.
