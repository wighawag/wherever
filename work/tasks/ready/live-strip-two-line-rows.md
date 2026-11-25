---
title: Live strip: two-line rows, short badges, count dots, amber wash
slug: live-strip-two-line-rows
spec: sidebar-compact-layout
blockedBy: [state-dot-legend]
covers: [5, 6, 7, 8, 9, 10]
needsAnswers: true
---

## What to build

Re-lay out the Live strip (`LiveStrip.svelte`) per `live.png`:

- Each row on two lines: the label on top (unchanged rule: first shipmates role, else the row label); under it "folder · (waiting on <session>, else the presence status line) · ↳ <owner>", each part only when present, truncated at the end. The state dot (the shared legend) leads the row.
- Short badges on the right: `you` (waiting for you), `session` (waiting on a session), `running`.
- A "waiting for you" row gets an amber wash.
- The header (expanded AND collapsed) shows per-state count dots (only the states present) after "LIVE" instead of today's `liveStripHeader` text; collapsed, the strip is just that one ~30px line.
- Unchanged: ordering (waiting for you, waiting on a session, running), the open-session highlight, the cap of 6 with "+N more", the per-device collapsed state (`LIVE_STRIP_COLLAPSED_KEY`), the position (under the filter row, main list only), no row menu, rows are real links (plain click intercepted, modifier clicks native).

## Acceptance criteria

- [ ] Rows render on two lines with the second line composed as described; long text truncates at the end.
- [ ] Badges read `you` / `session` / `running`; the waiting-for-you row has an amber wash.
- [ ] The header shows count dots expanded and collapsed; collapsed is one line.
- [ ] The pure helpers that compose the second line and the counts are unit-tested (extend `live-sessions.test.ts`).
- [ ] Order, cap, highlight, collapse memory and link behaviour unchanged.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- state-dot-legend: provides the dot component and legend this strip uses.

## Prompt

> Goal: spec `work/specs/tasked/sidebar-compact-layout.md` stories 5 to 10. Mockup: `docs/design/sidebar-and-chat-redesign/live.png` (left and middle panels).
>
> Where to look: `web/src/lib/components/LiveStrip.svelte`, `web/src/lib/core/live-sessions.ts` (`liveSessions`, `LiveSessionRow.stateText`, `waitingOnText`, `liveStripHeader`, `LIVE_STRIP_CAP`), the `StateDot` component and helper from task `state-dot-legend`. The strip's owner label comes from the `labelOf` prop. Keep the change inside the strip and its pure helpers; touch `SessionBrowser.svelte` only to pass props if needed.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/live-strip-two-line-rows-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.
