# by-owner-view-tree-and-toggle: decisions (2026-11-24)

Task `by-owner-view-tree-and-toggle` (spec `session-list-by-owner-view`, ADR 0026). Pure tree in `web/src/lib/core/owner-tree.ts`, rendered by `SessionBrowser.svelte` through `SessionRow.svelte`.

## Drift check

`SessionRow.svelte` (with `nestKind`, `ownerHint`, `showOwned`, `closed`, `rowTitle`), the closed helpers (`isSessionShown`, `folderListView` in `core/closed-sessions.ts`) and `ownedChildren` landed as the task expects. Nothing broke. `SessionRow` had no folder-tag prop, so one was added (`folderTag`, unset in the folder view, so that view is unchanged).

## Decisions

1. **"↳ spawned by X" is hidden on a row nested directly under its owner** (`ownerRowHint`). The row above IS the owner and the `spawned` "↳" marker ("Spawned by the session above") already says so; repeating it on every worker was noise. It still shows when the row's parent is not its owner (a sibling fork under rule 4, whose parent row is the sibling, or the root of a cycle walk), and "(not listed)" shows under rule 2. Alternative: always show it, as the folder view does. Touches only the By-owner view.
2. **Node shape gains `edge` and `ownerNotListed`** beside the task's `{session, folderName, children, closed}`: `edge` (`'spawned' | 'fork' | null`) picks the row's `nestKind`, `ownerNotListed` drives the "(not listed)" hint. Both are derived in the pure function so the markup stays logic-free.
3. **Ordering inside a group** follows the fork tree: siblings by the most recent `modified` in their kept subtree, then own `modified`, then path. The task only fixed group order (story 8); this keeps sibling order consistent with the folder view.
4. **`latestActivity` counts only kept nodes** (after closed pruning). A hidden closed session's activity would otherwise lift a group whose visible rows are all quiet.
5. **A path listed in two folders is taken once, from the first folder.** Guarantees "every listed session exactly once" (and unique Svelte keys) even if the listing ever repeats a path.
6. **Toggle state lives in `owner-tree.ts`** (`parseSessionListView`, `sessionListViewState`, `SESSION_LIST_VIEW_KEY = 'wherever-session-list-view'`), not in `core/view-mode.ts`, because that module is about the chat area's top-level state (search vs session) and the name would mean two things. "Has an owner" means a listed session with `ownerSessionPath` set (listed or not), closed sessions included, since `/sessions` lists them. The toggle is never shown on the read-only page.
7. **Placement of the toggle:** a small "By folder | By owner" segmented control on the "Show closed" line under the filter box, so the top of the list keeps one control row.
8. **Empty "By owner" list** says "Loading sessions..." while loading, else "No sessions found". While this task ignores the filter, "No sessions match your filter" never shows in this view.
