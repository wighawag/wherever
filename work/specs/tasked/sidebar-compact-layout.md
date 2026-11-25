---
title: Compact sidebar and drawer (icon tabs, one-line headers, row menu, state-dot legend, rename)
slug: sidebar-compact-layout
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + `CONTEXT.md` + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Resolved decisions (human, inbox `h_AaeffYeL`, 2026-11-25)

1. The sidebar's current-session "Close Session" button (which only leaves the open chat, `handleShowMainScreen`) is relabelled "Leave session", behaviour unchanged, so it is not confused with "⊘ Close session" (mark done).
2. The desktop rail (« collapses the sidebar) shows: » expand, the tab icons (with the Needs-you badge), + new session, and an amber dot when anything waits for you; collapsed state remembered per device. The rail's + expands the sidebar and opens the new-session form (it lives in `SessionBrowser`).
3. Also confirmed: "Only starred" filters the folder / By-owner list but not the Live strip; Rename is not offered on read-only rows; a CLI session whose wherever extension is too old to rename is refused with a message, never written directly.

## Visual source of truth

The human-approved mockups in `docs/design/sidebar-and-chat-redesign/`:

- `phone.png` frame 1: the phone drawer (icon tabs, filter row, Live strip, one-line folder headers, row ⋯, a row swiped left to reveal "⊘ Close").
- `desktop.png`: the pinned sidebar on desktop (« collapse, hover ⊘ beside ⋯, the row popover).
- `sidebar.png`: today's sidebar beside the proposal, the row ⋯ bottom sheet, the ☰ view options and the folder ⋯ menu. Superseded on two points: the tabs are icons only (no text under them), and the header shows only the logo (no "Wherever" text).
- `live.png`: the Live strip (expanded and collapsed) and the state-dot legend.
- `current-sidebar.png`: today's UI, for comparison.

Where a mockup and this spec disagree, this spec wins (it records the human's later decisions).

## Problem Statement

On a phone, the session list starts about halfway down the drawer. Above it sit a four-line connection block with a "Close Session" button, four full-width navigation rows, a filter row with a second row of options, a "Create New Session" row, and two-line folder headers with their full path. Every session row carries three equal-weight buttons (☆ ⊘ ✕), so a mistap can delete. The Live strip crams label, folder, badge, status and owner onto one truncated line. The state dot means "working" in amber, so amber cannot also mean "this needs you", which is the one thing the user most wants to see. There is no way to rename a session from wherever, to copy a link to it, or to close a whole folder of finished sessions at once.

## Solution

A compact sidebar where the session list starts at about a quarter of the drawer's height:

- A header with only the wherever logo, the server pill, ⚙, and ✕ (on desktop «, which collapses the sidebar to a rail).
- The current session on ONE line (state dot, folder, model, ▾); ▾ expands the versions and the leave button.
- A row of four icon-only tabs: Assistant (a gradient four-point sparkle ✦), 🙋 Needs you (with its count badge), 🔎 Search, 👁 Read-only. Long-press or hover shows the label.
- A filter row: the filter input, ☰ (view options: By folder / By owner, Show closed, a new "Only starred", Refresh), and + (new session).
- The Live strip with two-line rows and a collapsed form that still shows the counts.
- One-line folder headers (name and count) with a ⋯ menu (path, New session here, a new "Close all in folder", Delete all).
- Session rows with ONE ⋯ (Close, Star, Rename, Copy link, Open in new tab, then Delete… apart and in red). A bottom sheet on the phone, a popover on desktop, where hovering a row also shows a one-click ⊘. On the phone, swiping a row left closes it.
- One state-dot legend everywhere, with amber reserved for "waiting for you".
- Rename a session, written by whichever process owns its file.

## User Stories

### State dots (one legend everywhere)

1. As a user, I want one state-dot legend used by the Live strip, the folder rows, the By-owner rows and the By-owner group summaries, so that a colour means the same thing wherever I see it: amber with a halo = waiting for you; purple = waiting on another session; blue, pulsing = running; green = loaded but idle; grey = not loaded; a hollow ring with the row dimmed = closed.
2. As a user, I want amber to stop meaning "working", so that amber only ever means "this needs me".
3. As a user, I want a long-press (touch) or hover (mouse) on any state dot to show its label, so that I can learn the legend in place.
4. As a user, I want a By-owner group's collapsed summary to show its per-state counts as coloured dots, the same as the collapsed Live strip, so that the legend reads the same in both places.

### Live strip

5. As a user, I want each Live strip row on two lines (the label on top; under it "folder · (waiting on <session>, else the status line) · ↳ <owner>", each part only when present, truncated at the end), so that nothing important is truncated away.
6. As a user, I want short state badges in the strip (`you`, `session`, `running`), so that the badge never eats the row.
7. As a user, I want a "waiting for you" row to have an amber wash, so that it reads first.
8. As a user, I want the strip's order, open-session highlight, cap of 6 with "+N more", per-device collapsed state, and position (under the filter row, main list only) to stay as today, so that only the row layout changes.
9. As a user, I want the strip header (expanded or collapsed) to show the count per state as coloured dots instead of today's "Live · 4 · 1 waiting for you" text, and the collapsed strip to be just that one ~30px line, so that "1 waiting for you" is never hidden.
10. As a user, I want strip rows to have no ⋯ menu, so that the strip stays a shortcut (each session is also in its folder, with its menu).

### Header, current session, tabs

11. As a user, I want the sidebar header to show only the wherever logo (the same `logo.svg` as the website, no "Wherever" text), then the instance badge (`appearanceLabel`, shown only when set, as today), ⚙ and ✕ (on desktop «), with the logo keeping today's click (back to the main screen / new session) and the ⚙ settings mode keeping its own "Connection Settings ◀ Back" header, so that the header takes one short line.
12. As a user, I want the current session on one line (its state dot, folder, model, ▾), with ▾ expanding the app and server versions and the "Leave session" button (today's "Close Session", which leaves the open chat); with no session open the line shows the connection dot and "Connected", with ▾ for the versions; the line shows on desktop too (`desktop.png` omits it), so that it costs one line until I need it.
13. As a user, I want the disconnected state and its error to stay visible in the sidebar without expanding anything, so that a dead connection is never hidden behind ▾.
14. As a user, I want the four navigation rows replaced by a row of icon-only tabs (✦ Assistant, 🙋 Needs you with its count badge, 🔎 Search, 👁 Read-only), each showing its label on long-press or hover, so that navigation takes one row.
15. As a user, I want the tabs to show which view I am in and to bring me back to the session list (tapping the active tab, or the list's own way back), so that I never need the old "Back to sessions" rows.
16. As a user, I want the tabs that only exist under conditions to keep those conditions (Assistant only when the assistant is active, its timezone in the tooltip, disabled while disconnected and highlighted while I view the assistant session; Needs you only when shipmates is available, amber badge when a question blocks), so that nothing appears that does nothing.
17. As a user on the read-only page, I want a way to search the read-only conversations, as "Search these conversations" does today, so that the read-only search is not lost.

### Phone drawer and desktop sidebar

18. As a user on a phone, I want the drawer slightly wider (about 86% of the screen), with the strip of chat on its right still closing it on tap, so that rows have more room and I keep the easy way out.
19. As a user on desktop, I want « in the header to collapse the sidebar to a thin rail (and » to expand it again), remembered on this device, so that I can give the chat the whole width.

### Filter row and view options

20. As a user, I want the filter row to hold the filter input, ☰ and +, so that the list options and the new-session action sit on one line.
21. As a user, I want ☰ to open view options holding By folder / By owner, Show closed, a new "Only starred", and Refresh, so that the options do not take a permanent row.
22. As a user, I want "Only starred" to show only starred sessions in the folder list and the By-owner view (remembered on this device; the Live strip is not filtered by it), so that the star has a purpose next to Close: star = important, close = done.
23. As a user, I want + to open the same new-session form "Create New Session" opens today (folder path with completion, model, git init and remote options), so that creating a session loses nothing.
24. As a user, I want the "Search all conversations for …" link under the filter to stay, so that I can still jump from the filter to full-text search.

### Folder headers

25. As a user, I want each folder header on one line (name and session count), with the "Missing" badge kept, so that headers stop taking two lines.
26. As a user, I want a folder ⋯ menu holding the folder's path, "New session here", a new "Close all in folder", and "Delete all" (red, asking again), so that folder actions are one tap away but not in the way.
27. As a user, I want "Close all in folder" to close the open sessions among the folder's shown rows (the same rows "Delete all" acts on, so the text filter and "Only starred" apply; closed rows are skipped; owned sessions elsewhere are not cascaded) as ONE close with one Undo (which also restores the stars the close removed, ADR 0025) and a banner "Closed N sessions in <folder>", so that I can clear a folder of finished work and take it back if I was wrong.

### Session rows

28. As a user, I want each session row's ☆ ⊘ ✕ replaced by a single ⋯, with a small ★ in the second line only when the session is starred, so that rows are calm and a mistap cannot delete.
29. As a user, I want the row ⋯ to hold, in order: Close (saying "and N owned" when the close would cascade, N fetched from `/sessions/owned` when the menu opens, no hint until it answers; every close entry point, menu, hover ⊘ and swipe, still goes through the existing close flow with its cascade prompt and Undo), Star / Unstar, Rename, Copy link, Open in new tab (desktop only), then a separator and Delete… in red, which asks again, so that the common action is first and the destructive one is last and guarded.
30. As a user, I want a closed row's ⋯ to offer Reopen instead of Close, so that "Show closed" still lets me take a session back.
31. As a user on the read-only page, I want the row ⋯ to hold only what read-only allows today plus the harmless new actions (Star / Unstar, Copy link, Open in new tab), so that read-only stays read-only.
32. As a user on a phone, I want the row ⋯ as a bottom sheet headed by the session's label and "folder · age · messages", so that it is easy to hit with a thumb.
33. As a user on desktop, I want the row ⋯ as a popover, and hovering a row to show a one-click ⊘ beside ⋯ (↺ Reopen on a closed row; nothing on a read-only row), so that closing is one click with a mouse.
34. As a user, I want rows to stay real links, so that long-press, middle-click, Ctrl/Cmd-click and "open in new window" keep working.
35. As a user, I want everything else a row shows today kept: the fork / spawned nesting, "↳ spawned by", the presence line, the client count, the owned-session chips, the "Closed" marking, so that the redesign removes buttons, not information.
36. As a user, I want "Copy link" to copy the full URL that opens this session, so that I can paste it into another device or a message.
37. As a user on a phone, I want to swipe a row left to reveal "⊘ Close", and releasing past the button to close the session (with the usual Undo banner; no swipe on closed or read-only rows), so that closing done work is one gesture.
38. As a user on a phone, I want a vertical scroll and a tap on the strip right of the drawer to keep doing what they do today (there is no drawer swipe today and none is added; any gesture that is not a row swipe is left to the browser), so that the row swipe never steals another gesture.

### Rename

39. As a user, I want Rename in the row ⋯ to let me type a new name (prefilled with the current name, empty allowed only as "cancel"), so that I can label sessions myself.
40. As a user, I want a rename to be written by the process that owns the session file (the server's own agent for a session it runs; the terminal pi through the bridge for a CLI-bridged session; a plain append for a session that only exists on disk), so that wherever never writes a file another live process owns.
41. As a user, I want a rename that cannot be done safely (for example a CLI session whose wherever extension is too old) to be refused with a clear message, so that it fails visibly rather than corrupting a transcript.
42. As a user, I want the new name to show at once in the sidebar, the Live strip and every other open dashboard (conversation search catches up when memonaut next indexes), so that a rename is not a private illusion.
43. As a user, I want Rename refused with a message on a session that has no message yet (pi writes nothing to the file before the first exchange), so that a rename never silently vanishes.
44. As a user on the read-only page, I want the filter row's ☰ to hold Refresh and "Only starred", with no + (no create there), and the folder ⋯ to hold only the path, so that read-only stays read-only.
45. As a user, I want a row's second line to read "age · messages · owns N · ★" (owns and ★ only when they apply), with the owned-session chips kept under the row, so that the row matches the mockup without losing the chips.

### Autonomy notes

- **`humanOnly`:** omitted. Ordinary UI work plus one server/protocol addition.
- **`needsAnswers`:** omitted. The human answered the open questions (see Resolved decisions).

> Tasked: the implementation and testing detail moved into the tasks with `spec: sidebar-compact-layout` (`work/tasks/`); the chat control map is in `chat-session-menu`; the rename write-path rationale goes to the ADR written by `rename-session-endpoint`.

## Out of Scope

- The chat top bar, the ⋯ session menu, the composer and the message layout (spec `chat-compact-layout`).
- Changing what the inbox, search or read-only views contain beyond their navigation.
- Row actions in the Live strip.
- Renaming folders.
- Multi-select of rows.

## Further Notes

- Background: specs `session-list-live-strip`, `closed-sessions`, `session-list-by-owner-view` (all in `work/specs/tasked/`), ADRs 0025 and 0026, and `CONTEXT.md` "Starred sessions", "Closed sessions".
- Known risk: the row swipe must be told apart from vertical scrolling and the drawer gesture; a short human device pass follows the build.
