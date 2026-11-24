---
title: A "By owner" view groups each orchestration into one tree across folders
slug: by-owner-view-tree-and-toggle
spec: session-list-by-owner-view
blockedBy: [session-row-component]
covers: [1, 2, 3, 4, 5, 6, 8, 10, 12, 13, 15, 16, 17, 18]
---

## What to build

A "By folder / By owner" toggle at the top of the main session list (not the read-only page). "By folder" stays the default and unchanged. "By owner" renders groups from a pure `ownerTree`, each row through `SessionRow.svelte` with its folder as a small tag. Collapse, summaries, attention highlight and the filter come in the next task; here every group is expanded and ordered by latest activity anywhere in it (story 8). Until the next task lands, "By owner" IGNORES a non-empty sidebar filter (the folder view keeps filtering as today). View-mode persistence is here; collapsed-state persistence (the rest of story 14) is in the next task.

**Placement rules** (pure `web/src/lib/core/owner-tree.ts`, `ownerTree(folders: FolderWithSessions[], {isVisible}) -> OwnerGroup[]`, where `isVisible` is the closed-sessions visibility predicate (closed + "Show closed"); nodes `{session, folderName, children, closed}`; groups `{root, latestActivity}`. The next task adds the filter and presence inputs. Build over the FULL listing, closed included):

1. A session whose `ownerSessionPath` is listed nests under its owner (transitively, across folders).
2. A session whose `ownerSessionPath` is set but NOT listed is a root, with owner hint "(not listed)"; its fork parent is ignored.
3. A session with NO owner whose fork parent (`parentSessionPath`) is listed nests under that parent, at whatever depth the parent sits (so a hand-made fork of a worker stays in the worker's orchestration; two unowned sessions where one forked the other form one group).
4. Among siblings with the same direct owner, a sibling whose fork parent is another such sibling becomes that sibling's child node; a fork parent outside the sibling set is ignored. Rule 4 is the ONLY exception to rule 1, and it applies only when the shared owner is LISTED: sessions under rule 2 (owner set but unlisted) never use it and stay roots.
5. Anything else with no parent is a root; a root with no children is a group of one. All groups share one list ordered by latest activity in the group (`modified` desc, then path).
6. Cycles never hide sessions, and no session is emitted twice: sessions not reached from a root are walked in recency order (`modified` desc, then path), each walk starting a group; an edge to an already-visited node is dropped. (This differs from `buildForkTree`'s safety net, which appends unreached sessions flat in input order.)
7. Closed: apply only after nesting, using the closed-sessions visibility predicate (closed + "Show closed"). Prune a closed node with no visible descendant, keep the rest dimmed, hide a group whose members are all closed. (Do NOT reuse the folder view's flat fork-row pruning.)

Rendering: nested rows use the `spawned` marker kind for an ownership edge and `fork` for a fork edge; owned-children chips hidden in this view; row actions (star, close incl. cascade prompt, delete) work as in the folder view; open session marked. The toggle is hidden when `shipmatesStore.available` is false or no listed session has an owner; if the saved choice is "By owner" then, show "By folder" and keep the saved preference. View mode persists in `localStorage` (`wherever-` prefixed key).

## Acceptance criteria

- [ ] `ownerTree` unit tests: flat sessions; one orchestration across folders; transitive nesting; unowned fork of a worker nests under the worker; two unowned forks form one group; an owned fork nests under its owner, not its fork parent; same-owner sibling forked from another sibling becomes its child; owner set but not listed -> root even with a listed fork parent; a rootless cycle (nothing vanishes, deterministic grouping); a session that owns itself; EVERY listed session appears exactly once (no duplicate paths, which would also break Svelte's keyed each); two roots sharing an unlisted owner stay roots even if one forked the other; ordering by latest activity in group; closed pruning (open child of a closed owner keeps it as dimmed context; all-closed group hidden).
- [ ] Toggle visible only when meaningful; fallback to "By folder" keeps the saved preference (pure-helper test).
- [ ] "By folder" is unchanged.
- [ ] Web checks and tests pass; changeset (`"wherever-dev": minor`); `CONTEXT.md` gains a short "By owner view" note with the placement rules.

## Blocked by

- session-row-component (rows render through the extracted component).

## Prompt

> Goal: as above; the placement rules here are the design, and ADR `docs/adr/0026-the-by-owner-view-nests-by-ownership-first-and-forks-inside-it.md` is their rationale (spec for the user stories: `work/specs/tasked/session-list-by-owner-view.md`). Do not re-open them. Whether "↳ spawned by X" still shows on a row already nested under its listed owner is yours to decide (record it).
>
> Where to look: `ownedChildren` in `web/src/lib/core/shipmates.ts`, `parentSessionPath` / `ownerSessionPath` on the session type in `web/src/lib/session-store.ts`, `web/src/lib/core/fork-tree.ts` for the recency tie-break (the nesting itself is new: `buildForkTree` is per folder and flat, and its unreached-sessions fallback is NOT the rule 6 behaviour), the closed visibility helper from `closed-sessions-in-the-sidebar`, `SessionRow.svelte`, `SessionBrowser.svelte`. Prior art for tests: `fork-tree.test.ts`, `shipmates.test.ts`. The web package has vitest but no component-testing library.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): if the row component, the closed helpers or the live-strip helpers landed under different names, use what landed; if a premise broke, route to needs-attention.
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/by-owner-view-tree-and-toggle-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.

## Decisions

Recorded in `work/notes/observations/by-owner-view-tree-and-toggle-decisions.md`:
- **"↳ spawned by X" is hidden on a row nested directly under its owner**, because the row above is the owner and the marker already says so. It still shows when the row's parent is not its owner (a sibling fork, or the root of a cycle), and "(not listed)" shows for an owner that isn't listed.
- **Two extra node fields, `edge` and `ownerNotListed`**, so the markup stays free of logic.
- **Siblings inside a group are ordered like the fork tree**: by the newest activity in their subtree, then their own date, then path.
- **A group's latest activity counts only the rows still shown** after closed sessions are pruned.
- **A path listed in two folders appears once**, under the first folder.
- **The toggle logic lives in `owner-tree.ts`, not `core/view-mode.ts`**, because that name already means the chat area's view state.
- **The toggle sits on the "Show closed" line**, and an empty "By owner" list says "Loading sessions..." or "No sessions found".
