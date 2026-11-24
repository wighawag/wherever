# session-row-component: decisions (2026-11-24)

Task `session-row-component` (spec `session-list-by-owner-view`). Behaviour-preserving extraction of the sidebar row into `web/src/lib/components/SessionRow.svelte`.

## Drift check

The task names `buildForkTree(folder.sessions)`; the loop now iterates `folder.rows` from `folderListView` (core/closed-sessions.ts). The row markup itself matched the task's element list (plus the "Closed" badge and the Close / Reopen button added by the closed-sessions tasks), so it was extracted as is. The row was not yet a component.

## Decisions

1. **Props.** `session`, `depth`, `current`, `readOnly`, `closed`, `dimmed`, `rowTitle`, `nestKind` (`'fork' | 'spawned'`, default `'fork'`), `presence`, `ownerHint`, `ownedChildren`, `showOwned` (default `true`), `confirmingDelete`, and callbacks `onOpen`, `onStar`, `onToggleClosed`, `onAskDelete`, `onCancelDelete`, `onDelete`. Callback naming follows `LiveStrip.svelte` (`onOpen`). Alternative considered: a single `onDeleteConfirm(path | null)`; three explicit callbacks read clearer.
2. **Delete-confirm state stays in the parent.** `SessionBrowser` keeps the single `confirmingDelete` path and passes a boolean, so only one row can be in its confirm state at a time (today's behaviour). Moving it into the row would allow several at once. The By-owner task should reuse the same parent state.
3. **The close cascade stays in the parent / store.** The row only calls `onToggleClosed(path, closed)`; `SessionBrowser.toggleClosed` calls `closeSession` (which drives `CloseCascadePrompt` and the undo banner) or `setSessionClosed(path, false)`.
4. **Which chips show stays in the parent.** The parent passes `ownedChildren` already filtered with `shownSessions(owned.get(path), showClosed)`; the row does no closed filtering. `showOwned` hides the chips entirely (By-owner will likely pass `false`, since children are nested rows there).
5. **`rowTitle` is passed in.** The closed tooltip depends on "Show closed" ("Closed" vs "Closed (shown because a fork of it is open)"), which is list context, so the parent words it. The By-owner view can word its own dimmed-context reason.
6. **`ownerHint` replaces the inline `sessionLabel(ownerSessionPath)`.** The hint line renders when `ownerHint` is non-empty (the folder view passes it only when `ownerSessionPath` is set); its tooltip still shows `Spawned by <ownerSessionPath>`. The By-owner task passes "(not listed)" for an unlisted owner.
7. **`closed` vs `dimmed`.** Both give `opacity-50`; only `closed` shows the "Closed" badge and flips the Close button to Reopen. The folder view passes `closed={!!session.closed}` and never sets `dimmed`.
8. **`nestKind: 'spawned'` wording** is "Spawned by the session above" / "Spawned session" (new text, unused by the folder view; the By-owner task may reword it in `rowNestMarker`).
9. **Text logic moved to a pure, tested helper.** `formatRelative` (inline in `SessionBrowser`, only used by the row) became `relativeTime` in `web/src/lib/core/session-row.ts`, with `ownedChipLabel` (chip fallback "session") and `rowNestMarker`. The row title uses the existing `sessionListLabel` (core/live-sessions.ts), which is the same expression the row had inline.

## Before / after check

No browser was driven. Instead the old inline row markup (from `HEAD`) and the new `SessionRow` were both server-rendered (Svelte `render` via Vite SSR) over a fixture of six sessions (forks, owned, an unlisted owner, closed, working, active, starred, client count, presence waiting-for-human and running, long and empty first messages), across showClosed on/off, readOnly on/off, three open-session values and three delete-confirm values: 36 cases, identical HTML after stripping comments and collapsing whitespace. Click handlers are the same code paths (same modifier checks, row link checks button/ctrl/meta/alt/shift, chip link button/ctrl/meta, as before). The throwaway comparison files were deleted.
