# closed-sessions-in-the-sidebar: decisions (2026-11-24)

In-scope choices made while building task `closed-sessions-in-the-sidebar`, for the reviewer and the human to ratify or reverse.

1. **Text filter first, then tree, then prune.** `folderListView` (`web/src/lib/core/closed-sessions.ts`) applies the sidebar text filter, builds the fork tree over the matched sessions, then prunes closed rows with no shown descendant. So with a query typed, a closed session that matches can still appear as dimmed context above an open matching fork. Alternative: build the tree over the full folder even with a query (would change today's query behaviour, where unmatched parents are not shown). Touches only the folder list.
2. **Folder count excludes context rows.** The number beside a folder name is `shownCount`, the shown sessions only, not closed context rows. Alternative: count all rendered rows.
3. **The read-only page always lists closed sessions (dimmed) and has no close control.** "Show closed" is a main-list setting; on the read-only page there is no way to close or reopen, so hiding there would make a closed session unreachable from that page. Alternative: apply the toggle there too. Touches `SessionBrowser` with `readOnly`.
4. **No top bar close toggle for a read-only session**, matching the row control being main-list only.
5. **"Delete All" on a folder deletes the rows it shows** (including dimmed context rows), never closed sessions hidden by the toggle. Before, without a query, it deleted every session of the folder. Alternative: keep deleting every listed session, including hidden ones (surprising: deleting what you cannot see).
6. **Icons:** ⊘ for Close, ↺ for Reopen (row and top bar); a closed row's Reopen is always visible, Close is hover-revealed like delete. The toggle is a "Show closed" checkbox under the filter box.
7. **Key name:** `wherever-show-closed`, `'1'` when on (removed when off), mirroring `wherever-live-strip-collapsed`.
