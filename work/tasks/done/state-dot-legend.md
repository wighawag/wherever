---
title: One state-dot legend for every session surface (amber means waiting for you)
slug: state-dot-legend
spec: sidebar-compact-layout
blockedBy: []
covers: [1, 2, 3, 4]
---

## What to build

Replace today's row dot (amber pulse = working, green = resident, grey) with ONE legend used by every session surface: the folder rows and By-owner rows (`SessionRow`), the By-owner group summaries, and (in the Live strip task) the strip.

- A pure helper maps a listed session (+ its shipmates presence + its closed flag) to a dot state: `waiting-for-human` (amber with a halo), `waiting-for-session` (purple), `running` (blue, pulsing), `idle` (loaded but idle: green, today's `isActive`), `not-loaded` (grey), `closed` (hollow ring; the row is already dimmed). Precedence: live states > closed > idle > not loaded. The three live states come from the existing `sessionLiveState` (core `live-sessions.ts`), the single source of live state; a closed session reopens on activity (ADR 0025), so a live closed session must show its live colour.
- Each state has a human label ("waiting for you", "waiting on another session", "running", "loaded, idle", "not loaded", "closed") used as tooltip (hover) and accessible name; on touch a long-press shows it.
- The dot sits inside the row link (and the Live strip row link): a long-press on the DOT must show its label instead of the browser's link menu (for example `-webkit-touch-callout: none` and a `contextmenu` preventDefault on the dot only); a long-press elsewhere on the row stays native.
- A small `StateDot` component renders it; `SessionRow` uses it instead of its inline dots.
- The By-owner group's collapsed summary (today text from `ownerGroupSummaryText`) shows its live-state counts as coloured dots (only the three live states, as in the collapsed Live strip: `OwnerGroupSummary` has a single idle bucket; keep the session count as text, keep the amber head highlight when something waits for you).
- A second pure helper, "anyone waits for you": returns the COUNTS (open inbox items, from the same source as `shipmatesBadge`, and listed sessions whose presence is `waiting-for-human`) plus a boolean that is true when the inbox has an open item (today's `shipmatesBadge` source) OR any listed session's presence is `waiting-for-human`. Export it for the chat top bar (later task); nothing renders it yet beyond tests.

## Acceptance criteria

- [ ] The dot-state helper is unit-tested for every state and the precedence (including closed + running, closed + waiting-for-human, closed + loaded idle).
- [ ] "Anyone waits for you" is unit-tested (inbox only, presence only, both, neither).
- [ ] Folder rows and By-owner rows show the new dots; amber no longer means working anywhere in the session list.
- [ ] By-owner collapsed summaries show per-state count dots.
- [ ] Hover and long-press on a dot show its label; the dot has an accessible name.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

None, can start immediately.

## Prompt

> Goal: the state-dot legend of spec `work/specs/tasked/sidebar-compact-layout.md` (stories 1 to 4). Mockup: `docs/design/sidebar-and-chat-redesign/live.png` ("State dots everywhere").
>
> Where to look: `web/src/lib/core/live-sessions.ts` (`sessionLiveState`, the `LiveSessionLike` shape), `web/src/lib/core/shipmates.ts` (`ShipmatesPresence`, `stateLabel`, `presenceByFile`), `web/src/lib/components/SessionRow.svelte` (the inline working / active / grey dots), `web/src/lib/components/SessionBrowser.svelte` (By-owner summary rendering, `ownerGroupSummaryText` in `web/src/lib/core/owner-tree.ts`), `web/src/routes/+page.svelte` (`shipmatesBadge`, the inbox count) for the "anyone waits for you" inputs. `SessionInfo` has `isWorking`, `isActive`, `closed`.
>
> Seams to test: the pure helpers in `web/src/lib/core/` with vitest, mirroring `live-sessions.test.ts`. Do not change the Live strip's layout here (the next task does); only make it possible to reuse the dot there.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/state-dot-legend-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

These are recorded in `work/notes/observations/state-dot-legend-decisions.md`:
1. The helper takes the row's `closed` flag as an argument rather than reading it off the session, to match what `SessionRow` already shows as closed.
2. In the dot legend, `idle` means "loaded, idle" (green), and a session that is not loaded is `not-loaded` (grey). This is narrower than `idle` in the presence states, where it means "not live".
3. The long-press label is a bubble shown for about 1.8 seconds, after a 450ms press or a context-menu event. As a side effect, right-clicking a dot on desktop shows the label instead of the link menu.
4. `anyoneWaitsForYou` takes the whole shipmates state plus the listed sessions, and only listed sessions count.
5. `liveCountDots` (with the order "waiting for you, waiting on a session, running") is exported so the Live strip task can reuse it.
6. The brighter "not loaded" grey described above.
