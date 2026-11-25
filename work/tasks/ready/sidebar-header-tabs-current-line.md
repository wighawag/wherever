---
title: Sidebar header with logo only, one-line current session, icon tabs, wider phone drawer
slug: sidebar-header-tabs-current-line
spec: sidebar-compact-layout
blockedBy: [state-dot-legend]
covers: [11, 12, 13, 14, 15, 16, 17, 18]
---

## What to build

Rework the top of the sidebar in `+page.svelte` (the sidebar half only):

- Header: the wherever logo only (`web/static/logo.svg`, no "Wherever" text), keeping its click (`handleShowMainScreen`), then the instance badge (`appearanceLabel`, only when set), ⚙ (Connection Settings) and ✕ (phone only, closes the drawer). The ⚙ settings mode keeps its "Connection Settings ◀ Back" header. (« on desktop comes with the rail task.)
- Current session on ONE line: state dot (the shared legend, for the open session), folder name, model, ▾. ▾ expands: app and server versions (with today's tooltip incl. pi version) and the "Leave session" button (today's "Close Session", same `handleShowMainScreen` behaviour, relabelled). With no session open the line shows the connection dot and "Connected", with ▾ for the versions. When disconnected, the line says so in red and `appState.error` shows under it without expanding. The line shows on desktop too.
- The four navigation rows become a row of icon-only tabs: Assistant (a gradient four-point sparkle ✦), 🙋 Needs you (with the count badge, amber when a question blocks), 🔎 Search, 👁 Read-only. Long-press or hover shows the label (tooltip; accessible name). Conditions kept: Assistant only when the assistant is active (timezone in its tooltip, disabled while disconnected, highlighted while viewing the assistant; it is an action that opens the assistant and closes the drawer, not a view); Needs you only when shipmates is available.
- The tabs show the active view (inbox, search, read-only) and replace the "Back to …" rows: tapping the active tab returns to the main list, except search opened from the read-only page, which returns to the read-only page (today's "Back to read-only sessions"). On the read-only page, a "🔎 Search these conversations" link stays at the top of the list, rendered in `+page.svelte` above the read-only `SessionBrowser` (do not edit `SessionBrowser.svelte`; other tasks edit it in parallel).
- Phone drawer about 86% of the screen width (today `w-72`); desktop keeps `w-72`. The overlay to the right still closes the drawer on tap.

## Acceptance criteria

- [ ] Header, current-session line, tabs and drawer match `phone.png` frame 1 and `desktop.png` (with the spec's later decisions: icons only, logo only).
- [ ] Every behaviour of the old rows is reachable: assistant (with its conditions), inbox, search, read-only, search of read-only conversations, back to the list.
- [ ] Leave session, versions, connection state and the connection error are reachable as described, with and without an open session.
- [ ] Any pure helper extracted (for example the tab state from the view model) is unit-tested.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- state-dot-legend: the current-session line uses its dot.

## Prompt

> Goal: spec `work/specs/tasked/sidebar-compact-layout.md` stories 11 to 18. Mockups: `docs/design/sidebar-and-chat-redesign/phone.png` frame 1, `desktop.png`, `sidebar.png` (superseded on tabs and header text, see the spec).
>
> Ownership: this task edits only the SIDEBAR half of `web/src/routes/+page.svelte` (the chat spec owns the top bar and main column). Where to look in it: the sidebar `<div>` (header, the "Connection status" block, the "Sidebar navigation" block, `sessionView` `main | inbox | search | readonly`, `openSearch`, `searchReadOnly`, `openAssistant`, `assistantActive`, `viewingAssistant`, `shipmatesBadge`, `appearanceLabel`, `handleShowMainScreen`). The state dot comes from task `state-dot-legend`; the open session's listing entry is found the way the top bar finds `currentStarred` / `currentClosed`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/sidebar-header-tabs-current-line-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.
