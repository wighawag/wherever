---
title: Phone: swipe a session row left to close it
slug: session-row-swipe-to-close
spec: sidebar-compact-layout
blockedBy: [session-row-rename]
covers: [37, 38]
---

## What to build

On touch devices (main list, open rows only; not closed rows, not read-only rows), swiping a row left reveals "⊘ Close" behind it; releasing past the button's width closes the session through the existing close flow (cascade prompt, Undo banner); releasing before it snaps back; tapping the revealed button also closes.

- A pure gesture classifier decides from the first movement: a row swipe only when the movement is leftward, past a small slop, and clearly more horizontal than vertical; anything else is left to the browser (vertical scroll). Once decided, the decision holds for the whole gesture. There is no drawer swipe today and none is added; the overlay tap still closes the drawer.
- The row link must not open on a swipe release; a plain tap still opens it.
- Only one row is revealed at a time.

## Acceptance criteria

- [ ] The gesture classifier is unit-tested (left swipe, right swipe, vertical scroll, diagonal, under the slop, decision locking).
- [ ] Swipe-to-close works in a phone-sized browser with touch emulation; vertical scrolling of the list is unaffected; a tap still opens the row; no swipe on closed or read-only rows.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- session-row-rename: last task editing `SessionRow.svelte` before this one; serialised.

## Prompt

> Goal: spec `work/specs/tasked/sidebar-compact-layout.md` stories 37 and 38. Mockup: `phone.png` frame 1 (the second row swiped). A human device pass follows (`sidebar-phone-device-pass`), so keep thresholds as named constants that are easy to tune.
>
> Where to look: `web/src/lib/components/SessionRow.svelte`, `closeSession` in `web/src/lib/session-store.ts`. There are no touch or swipe handlers in `web/src` today (`pointerdown` appears only in `speech/SpeechButton.svelte` and as document-level unlock listeners in `core/speak.ts` and `core/service-worker/utils.ts`); use pointer events with `touch-action: pan-y` on the row so vertical scrolling stays native.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/session-row-swipe-to-close-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

These are recorded in `work/notes/observations/session-row-swipe-to-close-decisions.md`, which also holds the full browser-check record:
1. **A third release outcome, which goes beyond the task's wording.** The task says a release short of the button snaps back, but it also says the revealed button can be tapped. With only close and snap-back, the button shows only while your finger is down, so it could never be tapped. So a release between half the button and the full button leaves it showing. Setting `SWIPE_KEEP_REVEALED_PX = SWIPE_CLOSE_PX` gives the literal two-outcome behaviour if you prefer that.
2. **Touch only, at any width**, so a touch tablet in the desktop layout also swipes. Mouse and pen don't.
3. **Classifier values:** 8px slop and a 1.5 horizontal-to-vertical ratio; once decided, the decision holds.
4. **`pan-y pinch-zoom` instead of plain `pan-y`**, so a pinch that starts on a row still zooms.
5. **Hiding the button:** a tap on the revealed row only hides it. A tap elsewhere hides it and then does its normal job, so tapping another row opens that row.
6. **The slide effect only applies while a swipe is showing.** Otherwise it would trap the ⋯ phone sheet inside the row and cut off the desktop popover. A swipe can't start while the row's ⋯ menu is open.
7. **"One revealed row at a time"** is a single value shared by every row in the folder and By-owner views, so no new prop or store was needed.
