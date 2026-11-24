---
title: A Live strip at the top of the session list shows running and waiting sessions across folders
slug: live-strip-in-session-list
spec: session-list-live-strip
blockedBy: []
covers: [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
---

## What to build

A "Live" section pinned at the top of the main session list (not the read-only page) listing every session that is live right now, whatever folder it is in, ordered by how much it needs the human: waiting for you, then waiting on a session, then running; within a group, most recently modified first. Each row shows a label (first shipmates role, else the usual sidebar label), the folder as a small tag, a state badge, the presence status line, and "↳ <owner>" for a spawned session. A plain click opens the session exactly like a folder row; a modifier-click opens a new tab. The open session is marked. The header shows counts ("Live · 4 · 1 waiting for you"), is collapsible (remembered on the device), and the whole strip is hidden when nothing is live. At most 6 rows, then "+N more". The sidebar filter applies with the same rule as the list. Updates live from data the client already has; no server change in this task.

Liveness rule, as an exported pure helper the sibling spec `session-list-by-owner-view` will reuse:

```ts
// precedence, first match wins
sessionLiveState(session, presence):
  presence?.state === 'waiting-for-human'   -> 'waiting-for-human'
  presence?.state === 'waiting-for-session' -> 'waiting-for-session'
  session.isWorking || presence?.state === 'running' -> 'running'
  otherwise -> 'idle'   // live = not idle; an idle presence alone is NOT live
```

## Acceptance criteria

- [ ] A pure `sessionLiveState` implements the precedence above (unit tests for each case, including `isWorking` with an `idle` presence, and `isWorking` with `waiting-for-human`).
- [ ] A pure `liveSessions(folders, presence, query)` returns rows `{session, folderName, state, label}` with the membership and ordering above; a presence whose session is not in the listing is dropped; label is `roles[0]` else the sidebar label (unit tests).
- [ ] The sidebar's filter rule (name, first message, folder name) is extracted from `SessionBrowser.svelte` into `web/src/lib/core/` and used by BOTH the folder list and the strip; existing filter behaviour unchanged (unit tests).
- [ ] `LiveStrip.svelte` renders under the filter box in the main list only; rows use the same href as folder rows (`#` + `encodeURIComponent(session.id)`) and the same plain-left-click intercept.
- [ ] "Waiting for you" uses amber text like the presence line; the running badge is not amber text (the working dot already is).
- [ ] Collapsed state persists in `localStorage` under a `wherever-` prefixed key; strip hidden when empty; 6-row cap with "+N more".
- [ ] Works with shipmates unavailable (working sessions appear as running).
- [ ] Strip rows are single-line and truncate on the narrow sidebar; the mobile menu badge stays `inboxBadge` / `inboxCount` only (strip state does not feed it).
- [ ] A row's label never falls back to labels of sessions no longer in the listing (the sidebar's `seenLabels`): label = `roles[0]`, else name, else first-message preview, else "Empty session" like folder rows.
- [ ] `pnpm` web checks and tests pass; changeset (`"wherever-dev": minor`); `CONTEXT.md` gains a short "Live strip" note.

## Blocked by

- None, can start immediately.

## Prompt

> Goal: implement the Live strip described in "What to build"; the design is in this task's body and acceptance criteria (spec, for the user stories: `work/specs/tasked/session-list-live-strip.md`). Do not re-open it. The "waiting on <session>" label (story 3) is a SEPARATE task (`live-strip-names-the-session-waited-on`); here, a `waiting-for-session` row just says "waiting on a session".
>
> Where to look: `web/src/lib/components/SessionBrowser.svelte` (the folder list, `matchesFilter`, `sessionLabel`, `handleSessionClick`, the inline row markup inside the `buildForkTree` loop, the existing presence line and working dot), `web/src/lib/core/shipmates.ts` (`ShipmatesPresence`, `presenceByFile`, `presenceLine`, `stateLabel`), `shipmatesStore` and the session stores in `web/src/lib/session-store.ts` (`isWorking` is kept live by `session_working` frames via `setSessionWorking`). `sessionLabel` and `handleSessionClick` are private closures: pass them to the new component as props (`onOpen(path)`, `labelOf(path)`, `currentSession`, `rows`). Put the pure logic in a new `web/src/lib/core/live-sessions.ts`; the web package has vitest but no Svelte component-testing library, so test the pure functions (prior art: `shipmates.test.ts`, `fork-tree.test.ts`).
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code and the spec? If a premise no longer holds (e.g. `isWorking` is no longer in the listing), route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/live-strip-in-session-list-decisions.md` and end your final report with a `## Decisions` block written as the done-record section, linking that file.
>
> `CONTEXT.md` is long: targeted edits only; check `git diff --stat -- CONTEXT.md` before finishing. Never write em dashes.

## Decisions

Recorded in `work/notes/observations/live-strip-in-session-list-decisions.md`:
1. **Placement:** the strip sits outside the scroll area, between the filter box and the folders, so it stays visible while you scroll. The alternative was putting it inside the scroll area, where it would scroll away.
2. **Status text:** a row shows only the presence's own `status`. The full presence line would repeat the role and state, which the row already shows as label and badge.
3. **Badge colours:** "waiting for you" is amber, "running" is brand blue and "waiting on a session" is brand purple. I didn't use emerald for running because emerald is already the folder row's "active" dot.
4. **Extra prop:** `LiveStrip` takes a `presence` prop besides `rows`, `currentSession`, `onOpen` and `labelOf`. This keeps the row shape exactly `{session, folderName, state, label}` for the by-owner view to reuse.
5. **"+N more":** expanding isn't remembered. Only the collapsed state is stored in `localStorage`.
6. **Label and filter helpers:** both live in core now. The folder rows' inline label markup was left as it is. The filter treats a missing `firstMessage` as empty instead of throwing, which gives the same result on any valid listing.
7. **Ties:** an unparsable `modified` sorts as oldest, and equal keys keep listing order.
