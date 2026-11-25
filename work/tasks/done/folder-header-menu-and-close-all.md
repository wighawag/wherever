---
title: One-line folder headers with a ⋯ menu, and Close all in folder
slug: folder-header-menu-and-close-all
spec: sidebar-compact-layout
blockedBy: [sidebar-filter-row-view-options, rename-session-endpoint]
covers: [25, 26, 27, 44]
---

## What to build

- Build the shared menu primitive used by every ⋯ in the redesign: a bottom sheet below the `md` breakpoint (handle, optional header, items, separators, a red destructive item), an anchored popover at and above it; closes on outside tap, Escape and after an action; keyboard reachable. Later tasks (row ⋯, chat ⋯) reuse it. Also switch the filter row's ☰ view-options popover (built locally by `sidebar-filter-row-view-options`) to this primitive.
- Folder headers on one line: ▸, folder name, session count, the "Missing" badge (kept), and ⋯ (path moves into the menu and the tooltip).
- Folder ⋯ menu: the full path (text), "+ New session here" (today's per-folder picker), "⊘ Close all in folder" (NEW), then "Delete all…" in red, asking again (today's confirm). On the read-only page the menu holds only the path.
- Close all: closes the OPEN sessions among the folder's shown rows (the same `folder.rows` "Delete all" uses, so the text filter and Only starred apply; closed rows skipped; no cascade to owned sessions elsewhere) as ONE batch with one Undo:
  - server: `/sessions/close` also accepts `sessionFiles: string[]` (length-capped in `validateCloseInput`), closing them in one batch via `closeSessions(files)` and clearing their stars as a single close does (ADR 0025), answering `{batch, sessions}`; undo by `{batch, closed:false}` is unchanged and restores the stars;
  - web: the close banner gets a folder variant ("Closed N sessions in <folder>", Undo), and the optimistic patch handles many files.

## Acceptance criteria

- [ ] Folder headers are one line with ⋯; the menu matches `sidebar.png` (fourth panel) on phone (sheet) and desktop (popover).
- [ ] Server tests: multi-file close is one batch, clears stars, rejects an over-long list and paths outside the sessions dir, and undo reopens all and restores stars. State dirs isolated in temp folders, real ones untouched.
- [ ] Web: the banner text helper's folder variant is unit-tested; Undo works end to end.
- [ ] New session here and Delete all (with confirm) work as before.
- [ ] The menu primitive is reusable (props / slots documented in its header comment).
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour. `docs/USAGE.md` documents `/sessions/close` (single, cascade, batch undo, and the new `sessionFiles` form); it does not document it today.

## Blocked by

- sidebar-filter-row-view-options: edits `SessionBrowser.svelte` just before; serialised.
- rename-session-endpoint: edits the same regions of `server/src/index.ts`, `web/src/lib/session-store.ts`, `docs/USAGE.md` and `CONTEXT.md`; serialised.

## Prompt

> Goal: spec `work/specs/tasked/sidebar-compact-layout.md` stories 25 to 27 and the read-only folder menu of story 44; plus the shared menu primitive (this task owns it).
>
> Where to look: `web/src/lib/components/SessionBrowser.svelte` (folder header button, `newSessionPicker` / `openNewSessionPicker`, `handleDeleteAllFolderSessions`, `confirmingDeleteFolder`, the close banner markup, `folder.rows`), `web/src/lib/session-store.ts` (`setSessionClosed`, `closeSession`, `closeBannerStore`, `undoLastClose`), `web/src/lib/core/close-flow.ts` (`closeBannerText`, `CloseBanner`), `server/src/index.ts` `/sessions/close` (grep, read a bounded range), `server/src/session-closed.ts` (`validateCloseInput`, `closeSessions`), the existing close endpoint tests in `server/test/`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/folder-header-menu-and-close-all-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

Recorded in `work/notes/observations/folder-header-menu-and-close-all-decisions.md`. In short:
- `sessionFiles` only closes, never reopens, and never cascades.
- The list is capped at 1,000.
- One bad path rejects the whole request.
- "Close all" skips the question about owned sessions.
- The item shows the count it would close and is disabled at 0.
- "Delete all…" asks again inside the menu.
- The phone sheet stays inside the drawer instead of covering the whole screen. Moving it to the page root would break Svelte's click handlers.
- The popover opens upward when there is no room below, but can still be cut off by the sidebar's scroll area in rare cases.
- The ☰ checkboxes keep the menu open; Refresh closes it and no longer shows its spinner.
