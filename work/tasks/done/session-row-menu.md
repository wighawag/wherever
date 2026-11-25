---
title: Session rows: one ⋯ menu (sheet / popover), hover ⊘, ★ and owns N in the second line, Copy link
slug: session-row-menu
spec: sidebar-compact-layout
blockedBy: [folder-header-menu-and-close-all]
covers: [28, 29, 30, 31, 32, 33, 34, 35, 36, 45]
---

## What to build

Rework `SessionRow.svelte`:

- Remove ☆ ⊘ ✕. Add one ⋯ (always visible on touch; on desktop visible on hover / focus and for the open row) and, on desktop hover, a one-click ⊘ beside it (↺ Reopen on a closed row; nothing on a read-only row).
- The row stays an `<a href="#<id>">` with today's plain-click intercept (long-press, middle-click, Ctrl/Cmd-click, open in new window keep working).
- Second line: "age · N msgs · owns N · ★" (owns and ★ only when they apply). Everything else stays: nesting marker, "↳ spawned by", presence line, client count, owned-session chips, "Closed" marking.
- Row ⋯ (the shared menu primitive from `folder-header-menu-and-close-all`; on phone a bottom sheet headed by the label and "folder · age · messages"):
  - Close, with "and N owned" when it would cascade (N fetched from `/sessions/owned` when the menu opens; no hint until it answers), or Reopen on a closed row;
  - Star / Unstar;
  - Rename (added by the next task; leave room, do not add a dead item);
  - Copy link (the full URL that opens this session: origin + base path + `#<session id>`, through the clipboard helper, with a "Copied" confirmation);
  - Open in new tab (desktop only);
  - separator, then "Delete…" in red, which asks again before deleting.
- Read-only page: Star / Unstar, Copy link, Open in new tab only.
- Every close entry point (menu, hover ⊘, and later swipe) goes through the existing close flow (`closeSession`: cascade prompt, Undo banner). The parent keeps owning the cascade prompt and the delete confirmation (see `work/notes/observations/session-row-component-decisions.md`).

## Acceptance criteria

- [ ] Rows match `desktop.png` (hover ⊘, popover) and `sidebar.png` third panel (sheet).
- [ ] A pure helper builds the menu items from `{readOnly, closed, desktop}` and is unit-tested (stories 29 to 31).
- [ ] The copy-link URL builder is unit-tested (with and without a base path).
- [ ] Close (with the owned hint), Reopen, Star, Copy link, Open in new tab and Delete… (with second confirmation) work; a one-tap delete is impossible.
- [ ] Modifier clicks and long-press on rows behave as native links; the folder view and By-owner view both use the new row.
- [ ] Read-only rows expose only Star, Copy link, Open in new tab.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- folder-header-menu-and-close-all: provides the menu primitive and edits `SessionBrowser.svelte` just before.

## Prompt

> Goal: spec `work/specs/tasked/sidebar-compact-layout.md` stories 28 to 36 and 45. Mockups: `desktop.png` (popover, hover ⊘), `sidebar.png` (third panel, bottom sheet), `phone.png` frame 1.
>
> Where to look: `web/src/lib/components/SessionRow.svelte` and its props, `web/src/lib/components/SessionBrowser.svelte` (callbacks it passes: `toggleStar`, `toggleClosed`, `handleDeleteSession`, `confirmingDelete`), `web/src/lib/session-store.ts` (`closeSession`, `setSessionClosed`), `web/src/lib/core/close-flow.ts` (injects the owned-count fetch) and `closeApi.owned` in `web/src/lib/session-store.ts` (not exported today: export an owned-count fetch for the menu), `web/src/lib/core/clipboard.ts` (`copyText`), `web/src/lib/core/session-row.ts` (row text helpers, `ownedChipLabel`, `relativeTime`), `web/src/lib/core/shipmates.ts` (`ownedChildren`).
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/session-row-menu-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

Recorded in `work/notes/observations/session-row-menu-decisions.md`. The ones you are most likely to want to reverse:
1. "Open in new tab" counts as desktop when the screen is at least the `md` width (where the shared menu becomes a popover), checked when ⋯ is tapped.
2. On desktop the row's buttons take no space until hover, focus or an open menu, so titles use the full width at rest.
3. A closed row's dimming moved from the whole row to its content, because dimming the whole row would also fade the menu inside it. As a result, ⋯ and ↺ are not dimmed.
4. "owns N" counts the owned sessions the sidebar lists, while "and N owned" comes from the server's `/sessions/owned`, so the two numbers can differ.
5. The ★ gets a "·" before it, as the spec words it; the mockups draw it without one.
6. Copy link uses the page's origin and path plus `#<id>`. The query string is dropped because it may carry the auth token.
7. "Copied" shows inside the menu, which then closes. If copying fails, the link is shown in the menu to copy by hand.
