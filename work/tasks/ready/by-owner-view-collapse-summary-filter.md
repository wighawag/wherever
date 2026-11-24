---
title: By-owner groups collapse with a state summary, surface "waiting for you", and filter with context
slug: by-owner-view-collapse-summary-filter
spec: session-list-by-owner-view
blockedBy: [by-owner-view-tree-and-toggle]
covers: [7, 9, 11, 14]
---

## What to build

On top of the "By owner" view:

- **Collapse:** each group can be collapsed; collapsed state per group persists in `localStorage` (`wherever-` prefixed key, keyed by the root's session path), alongside the view mode saved by the previous task.
- **Inputs:** `ownerTree` gains the filter text and the presence map; nodes gain `matched`, groups gain `summary`, `hasWaitingForHuman` and `hasMatch`.
- **Summary:** counted over the members VISIBLE after closed pruning (closed rows kept only as dimmed context are not counted). A collapsed group's head shows "N sessions · 2 running · 1 waiting for you" counted with the Live strip's exported `sessionLiveState` (one state per session: waiting-for-human, waiting-for-session, running, idle). Group shape gains `summary` and `hasWaitingForHuman` (= `summary.waitingForHuman > 0`).
- **Attention:** a group with `hasWaitingForHuman` highlights its head (amber, as the Live strip), even when collapsed.
- **Ordering:** groups ordered by latest activity anywhere in the group (built in the previous task, story 8; keep it under collapse).
- **Filter:** closed visibility is applied FIRST; only visible nodes can match (a closed session hidden by "Show closed" off never makes a group appear). Then the sidebar filter (the shared text-match helper extracted by the Live strip task) marks matching nodes; a non-matching ancestor of a match is kept as dimmed context; groups without a match are hidden (`hasMatch` false); non-matching ancestors render through the row's `dimmed` flag (not `closed`); a group containing a match is shown EXPANDED while the filter is non-empty, without changing its saved collapsed state.

## Acceptance criteria

- [ ] Pure tests: summary counts per state; `hasWaitingForHuman`; filter marks matches, keeps ancestors as context, hides groups with no match, and reports `hasMatch`.
- [ ] Effective-expanded rule as a pure helper (saved state OR filter-with-match), tested; typing a filter never rewrites the saved collapsed state.
- [ ] Collapsed state survives reload.
- [ ] Web checks and tests pass; changeset (`"wherever-dev": minor`); `CONTEXT.md` "By owner view" note updated.

## Blocked by

- by-owner-view-tree-and-toggle (the tree, the toggle and the group list).

## Prompt

> Goal: as above (spec for the user stories: `work/specs/tasked/session-list-by-owner-view.md`).
>
> Where to look: `web/src/lib/core/owner-tree.ts` (from the previous task), `sessionLiveState` and the shared filter helper in `web/src/lib/core/` (from `live-strip-in-session-list`), how `SessionBrowser.svelte` forces folders open while filtering (`isFolderExpanded` / `searchExpanded`) for the analogous rule. Pure functions carry the logic.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED); use the helpers under the names that actually landed.
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/by-owner-view-collapse-summary-filter-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.
