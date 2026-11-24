---
title: Close and reopen sessions from the sidebar and top bar, hidden unless "Show closed"
slug: closed-sessions-in-the-sidebar
spec: closed-sessions
blockedBy: [closed-sessions-store-and-endpoint, closed-sessions-auto-reopen, live-strip-in-session-list, live-strip-names-the-session-waited-on]
covers: [1, 2, 4, 5, 6, 7, 11, 14, 16]
---

## What to build

The web side of closing ONE session (cascade and undo are a later task).

- A close button on each row beside star and delete (main list only, like delete), and a close/reopen toggle in the top bar for the open session, both through `setSessionClosed` (optimistic, rolls back on refusal).
- Closed sessions are hidden from the main FOLDER LIST (and so from its filter results) unless a "Show closed" toggle (in `localStorage`, `wherever-` prefixed key) is on; then they render dimmed and marked closed, with a Reopen action.
- A folder that has at least one session and whose sessions are ALL closed disappears while "Show closed" is off (`/sessions` deliberately keeps empty folders; leave those as they are).
- The owned-children chips under an owner row follow the same rule as rows: closed children are hidden unless "Show closed" is on, then dimmed.
- **The closed rule lives only in the folder-list path.** The shared text-match helper and `liveSessions` stay closed-agnostic, so a working closed session still appears in the Live strip with or without a query typed.
- **Fork tree:** build the tree over the FULL folder (`buildForkTree` unchanged), then prune closed rows that have no visible descendant, and render the remaining closed rows as dimmed context. Filtering closed rows out first would turn their open children into roots.
- **Live strip:** `liveSessions` computes over the full listing, closed included, so a closed session that is working still appears in the strip.

## Requeue 2026-11-24

Prior run finished the build and committed (3288380) but the post-commit fetch hit a transient SSH 'Permission denied (publickey)'. The work is complete on this branch: verify it against the acceptance criteria, fix only what is missing, and let the gate run.

## Acceptance criteria

- [ ] Pure helpers (unit-tested): visibility given `closed` and the toggle; folder hiding; fork-tree pruning that keeps a closed ancestor of an open child as dimmed context and drops a closed leaf.
- [ ] A closed working session still appears in the Live strip (unit test on `liveSessions`).
- [ ] The folder list's filter results skip closed sessions unless "Show closed"; a working closed session still appears in the strip with a query typed (unit tests).
- [ ] Owned chips hide closed children unless "Show closed" (pure-helper test).
- [ ] Close from a row and from the top bar; Reopen from a dimmed row; the toggle persists across reloads.
- [ ] Web checks and tests pass; changeset (`"wherever-dev": minor`); `CONTEXT.md` "Closed sessions" gains the web behaviour.

## Blocked by

- closed-sessions-store-and-endpoint (the `closed` flag and `setSessionClosed`).
- closed-sessions-auto-reopen (close must not ship without auto-reopen: nothing that needs the user may silently disappear).
- live-strip-in-session-list (serialized: both edit `SessionBrowser.svelte`, and this task changes the strip's membership).
- live-strip-names-the-session-waited-on (serialized: both edit `live-sessions.ts`, its tests and the strip wiring).

## Prompt

> Goal: as above. The decisions are in this task body and ADR 0025; user stories in `work/specs/tasked/closed-sessions.md`.
>
> Where to look: `web/src/lib/components/SessionBrowser.svelte` (row buttons for star and delete, folder rendering, the `buildForkTree` loop, the filter now shared from `web/src/lib/core/`), the top bar star toggle in `web/src/routes/+page.svelte`, `web/src/lib/core/fork-tree.ts` (+ test), `web/src/lib/core/live-sessions.ts`, `setSessionClosed` in `web/src/lib/session-store.ts`. The web package has vitest but no component-testing library: put logic in pure functions.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED). If the strip or the store landed differently, adapt to what landed or route to needs-attention if a premise broke.
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/closed-sessions-in-the-sidebar-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.

## Decisions

All recorded in `work/notes/observations/closed-sessions-in-the-sidebar-decisions.md`:
1. **Order:** the text filter runs first, then the fork tree is built, then closed rows are pruned. So with a query typed, a closed session that matches can still show as dimmed context above an open fork that matches.
2. **Folder count:** counts only shown sessions, not dimmed context rows.
3. **Read-only page:** always lists closed sessions dimmed and has no close control.
4. **Top bar:** no close toggle for a read-only session.
5. **"Delete All" changed:** it now deletes only the sessions the folder shows, never closed ones hidden by the toggle. Before, with no filter typed, it deleted every session in the folder.
6. **Look:** ⊘ for Close and ↺ for Reopen, and the toggle is a checkbox.
7. **Storage value:** the "Show closed" setting is stored as `'1'` when on and removed when off, the same way the Live strip's collapsed state is.
