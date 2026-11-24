---
title: Group the session list by owner (orchestrations as one tree)
slug: session-list-by-owner-view
taskedAfter: [session-list-live-strip, closed-sessions]
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + `CONTEXT.md` + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Problem Statement

An orchestrator session spawns workers, typically each in its own worktree. In the folder-grouped sidebar the orchestrator sits in one folder and each worker in another, so one piece of work is split across several folder groups. The only hints today are "↳ spawned by X" on a child and a row of child chips under the owner. The user cannot see an orchestration as one unit: how many workers it has, which are still running, which are done.

## Solution

A **view toggle** in the main session list, **By folder** (today's layout, the default) / **By owner**. In "By owner", every root session heads a group, and the sessions it spawned nest under it, transitively, regardless of folder; hand-made forks nest under the session they were forked from, as they do today. The folder becomes a small tag on each row. A group can be collapsed, and when collapsed it shows a summary of its members' states ("5 sessions · 2 running · 1 waiting for you"). The toggle is remembered per device.

## User Stories

1. As a user, I want a "By folder / By owner" toggle at the top of the main session list (not the read-only page), so that I can switch between project-centric and orchestration-centric views.
2. As a user, I want "By folder" to remain the default and unchanged, so that nothing moves for users who do not use shipmates.
3. As a user, in "By owner" I want each root session to head a group with the sessions it spawned nested under it, so that an orchestration reads as one unit.
4. As a user, I want nesting to be transitive (a worker that spawned sub-workers nests them under itself), so that deep orchestrations are represented faithfully.
5. As a user, I want a fork I made by hand (a session nobody spawned) to nest under the session it was forked from, at whatever depth that session sits, so that "By owner" keeps the fork structure the folder view shows, including a fork of a worker staying inside that worker's orchestration.
6. As a user, I want each row in "By owner" to show its folder as a tag, so that I still know where each session lives.
7. As a user, I want each group collapsible, collapsed groups showing a state summary (counts of running, waiting for you, waiting on a session, idle), so that I can scan many orchestrations quickly.
8. As a user, I want groups ordered by the latest activity anywhere in the group, so that the orchestration that is moving now is on top even if its head has been quiet.
9. As a user, I want a group containing a session that waits for me highlighted on its head, even when collapsed, so that attention propagates up.
10. As a user, I want a spawned session whose owner is not listed (deleted, ignored, read-only, not on this machine) to become a root with "spawned by (not listed)", so that nothing disappears from the view.
11. As a user, I want the sidebar filter box to work in "By owner": a matching session shows with its ancestors as context (dimmed if they do not match), and a group containing a match is shown expanded while the filter is non-empty (without changing its saved collapsed state), so that filtering never hides or orphans its own matches.
12. As a user, I want clicking any row to open that session as in the folder view, and the open session to be marked, so that navigation is identical.
13. As a user, I want the row actions (star, close, delete) available in "By owner" as in the folder view, so that I do not have to switch views to act.
14. As a user, I want my view choice and each group's collapsed state remembered on this device, so that the sidebar stays how I left it.
15. As a user, I want the "By owner" toggle hidden when shipmates is unavailable (`shipmatesStore.available` false) or when no listed session has an owner; if my saved choice is "By owner" at that moment, the list shows "By folder" and keeps my saved preference, so that it never offers or shows an empty mode.
16. As a user, I want closed sessions handled as in the folder view: hidden unless "Show closed" (then dimmed), a closed row kept as dimmed context when it has a visible descendant, and a group whose members are all closed hidden entirely.
17. As a user, I want a malformed ownership record (a cycle) never to make sessions disappear, so that the view is always complete.
18. As a maintainer, I want the grouping computed by a pure, unit-tested function, so that the tree logic is not buried in Svelte markup.

### Autonomy notes

- **`humanOnly`:** omitted.
- **`needsAnswers`:** omitted. All launch and review questions are resolved (below).
- **`taskedAfter: [session-list-live-strip, closed-sessions]`:** this spec reuses the strip's `sessionLiveState` helper and renders closed rows; all three edit `SessionBrowser.svelte`, so its tasks are serialized after the last sibling tasks touching it: `live-strip-names-the-session-waited-on`, `closed-sessions-in-the-sidebar` and `closed-sessions-cascade-and-undo` (the close row action brings the cascade prompt and undo banner).

## Resolved decisions

1. **Ownership first, forks inside it.** The tree is built from two edges with a precedence. A session with a listed owner (`ownerSessionPath`) nests under its owner. A session with NO owner whose fork parent (`parentSessionPath`) is listed nests under its fork parent, at whatever depth that parent sits (so a hand-made fork of a worker stays in the worker's orchestration, and two unowned sessions where one forked the other form one group, as in the folder view). An owned session's fork parent is ignored for placement, and so is the fork parent of a session whose owner is set but NOT listed (it is a root with "spawned by (not listed)", story 10). Among siblings with the same direct owner, a sibling whose fork parent is another such sibling becomes that sibling's child node (a real tree edge); a fork parent outside the sibling set is ignored. Fork nesting inside a group may span folders.
4. **Nest first, hide closed after.** The tree is built over the FULL listing, closed sessions included; closed visibility is applied only after nesting. A closed owner or fork parent with a visible descendant stays as dimmed context, so its children never become roots.
2. **Unrelated sessions are groups of one, interleaved.** A session that has neither a listed owner, nor a listed fork parent, nor children is a group of one, and all groups share one list ordered by latest activity anywhere in the group. No separate "Other sessions" section.
3. **Cycles never hide sessions.** Sessions not reached from a root (a cycle in ownership or forks) are walked in recency order (`modified` desc, then path); each walk starts a group and the nodes it reaches join that group. A node already visited during a walk becomes a leaf.

> Tasked: the implementation and testing detail moved into the tasks `session-row-component`, `by-owner-view-tree-and-toggle` and `by-owner-view-collapse-summary-filter` (`work/tasks/`); the durable rationale is ADR `docs/adr/0026-the-by-owner-view-nests-by-ownership-first-and-forks-inside-it.md`.

## Out of Scope

- A message-flow timeline between an orchestration's sessions (separate idea).
- Bulk actions on a group other than what `closed-sessions` defines (close cascade).
- Changing the "By folder" view.
