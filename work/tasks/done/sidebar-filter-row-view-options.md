---
title: Filter row with ☰ view options (incl. Only starred) and + new session
slug: sidebar-filter-row-view-options
spec: sidebar-compact-layout
blockedBy: [state-dot-legend, live-strip-two-line-rows]
covers: [20, 21, 22, 23, 24, 44]
---

## What to build

In `SessionBrowser.svelte`, replace the filter row and its option row, and the "Create New Session" row:

- One row: the filter input, ☰, and + (main list only).
- ☰ opens a small popover holding: By folder / By owner (today's toggle, with its `showToggle` rule), Show closed (today's checkbox and storage key), a NEW "Only starred" checkbox, and Refresh (today's ↻, with its spinning state).
- "Only starred": device-local (a new localStorage key beside `SHOW_CLOSED_KEY`), applied in the pure list builders (the folder list view in `core/closed-sessions.ts` and the By-owner tree in `core/owner-tree.ts`), NOT in the Live strip. While on, folders with no starred shown session are hidden; in By owner, keep the existing context rule (an ancestor of a match is shown dimmed). The ⚙ panel's "Refresh Session List" stays.
- + opens today's create form (folder path with completion, model, git init and remote options), the same state as the "Create New Session" row it replaces; expose a way for the page to open it (the desktop rail will; the rail expands the sidebar first, so the opener must work right after the list is shown again, e.g. a store flag the browser reads on mount).
- The "🔎 Search all conversations for …" link under the filter stays.
- Read-only page: ☰ holds Refresh and Only starred; no +, no Show closed, no By owner (as today).

## Acceptance criteria

- [ ] The filter row matches `sidebar.png` (fourth panel) and `phone.png` frame 1.
- [ ] Only starred is unit-tested in both list builders (folder view hides folders with no starred session; By owner keeps dimmed context ancestors) and is remembered per device.
- [ ] + opens the full create form; creating a session works as before.
- [ ] By folder / By owner, Show closed, Refresh and the search-all link behave as before.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- state-dot-legend, live-strip-two-line-rows: both edit the session list around `SessionBrowser.svelte`; serialised to avoid merge conflicts.

## Prompt

> Goal: spec `work/specs/tasked/sidebar-compact-layout.md` stories 20 to 24 and the read-only filter row of story 44. Mockups: `sidebar.png` (fourth panel, ☰ view options), `phone.png` frame 1, `desktop.png`.
>
> Where to look: `web/src/lib/components/SessionBrowser.svelte` (the filter row, `refresh`, `showClosedSetting` / `toggleShowClosed`, `viewState` / `setView`, `createFormOpen` and the create form, `onSearchAll`), `web/src/lib/core/closed-sessions.ts` (`folderListView`, `isSessionShown`, `SHOW_CLOSED_KEY`), `web/src/lib/core/owner-tree.ts` (`ownerTree`, the `matched` / dimmed context rule). The popover can be a simple local one; the shared bottom-sheet / popover menu primitive arrives in `folder-header-menu-and-close-all` and may later replace it.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/sidebar-filter-row-view-options-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

Recorded in `work/notes/observations/sidebar-filter-row-view-options-decisions.md`, with the browser check notes for the done record. The ones you might want to reverse:
1. **Folder list hides unstarred parents instead of dimming them.** The task only asked for the dimmed-ancestor rule in By owner. A starred fork of an unstarred session shows on its own at the top level, so "Delete All" (and the coming "Close all in folder") only ever act on starred rows.
2. **In By owner, Only starred does not change the group counts or force groups open.** The counts still cover the whole group, as they do with the text filter, and only the text filter forces a group open.
3. **One saved setting for both pages.** The main list and the read-only page share the `wherever-only-starred` key.
4. **A blue dot on ☰ while Only starred or Show closed is on.** This isn't in the mockups; I added it so a filtered list behind a closed popover doesn't look like missing sessions. It's easy to drop.
5. **"No starred sessions"** is shown when Only starred leaves the list empty.
6. **The create form stays inside the scrolling list** and + scrolls to it, so on a phone with the keyboard up the Create button stays reachable.
7. **The rail opener is a store flag** that only the main list reads.
8. **The popover stays open** after Refresh or a checkbox change, so you see the result.
9. **The chips listing sessions a row spawned are not filtered by Only starred.**
