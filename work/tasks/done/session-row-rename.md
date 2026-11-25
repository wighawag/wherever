---
title: Rename from the row ⋯ menu (shared rename prompt)
slug: session-row-rename
spec: sidebar-compact-layout
blockedBy: [session-row-menu, rename-session-endpoint]
covers: [39]
---

## What to build

- A reusable rename prompt (a small dialog or an inline field in the sheet / popover): prefilled with the current name (empty when the session has none), Enter or Save confirms, Escape or an empty value cancels, the error from the endpoint is shown in place (old bridge, empty session, handoff in progress). The chat ⋯ menu reuses it.
- Add "Rename" to the row ⋯ (after Star) on the main list only, calling the store's `renameSession` from `rename-session-endpoint`.
- The new name appears through the normal `sessions_updated` relist (no optimistic rename needed; if you add one, roll it back on error).

## Acceptance criteria

- [ ] Renaming a server session, a CLI-bridged session (new extension) and an on-disk session from the row menu shows the new name in the folder list and the Live strip.
- [ ] Refusals show their message and leave the name unchanged.
- [ ] Not offered on read-only rows.
- [ ] Any pure helper (prompt validation) is unit-tested.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- session-row-menu: the row ⋯ this adds to.
- rename-session-endpoint: the endpoint and store function.

## Prompt

> Goal: spec `work/specs/tasked/sidebar-compact-layout.md` story 39 (stories 40 to 43 are the server side, already done by `rename-session-endpoint`). Mockups: `desktop.png`, `sidebar.png` third panel (Rename item).
>
> Where to look: the row ⋯ in `web/src/lib/components/SessionRow.svelte`, the menu primitive from `folder-header-menu-and-close-all`, `renameSession` in `web/src/lib/session-store.ts` (from `rename-session-endpoint`), and that task's done record for the error texts. Build the prompt as its own component so `chat-session-menu` can reuse it. Do NOT edit `web/src/routes/+page.svelte` here (the chat tasks serialise on it): mount it from the session list (or have the row menu own it); `chat-session-menu` mounts its own instance.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/session-row-rename-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

These are in `work/notes/observations/session-row-rename-decisions.md`, which also holds the full browser-check record for the done record:
1. **Modal dialog, not a field inside the menu.** It uses the browser's own `<dialog>`, which floats above the page so the phone drawer can't clip it, and the chat ⋯ can reuse the same component. It sits 15% from the top so a phone keyboard doesn't cover it.
2. **The row owns its prompt** and shows it only while it is open. `SessionBrowser` turns Rename off on the read-only page, and the menu helper leaves it out there too.
3. **An unchanged name cancels**, so nothing is written. The client cleans the name the same way the server does but does not check the 200-character limit; the server's message covers a name that is too long.
4. **A refusal keeps the prompt open** with what was typed. A reply that arrives after the prompt was closed is ignored.
5. **Wording:** the title is "Rename session", with the row's label under it and the hint "An empty name cancels." The mockups show only the menu item, not the prompt.
6. **Clicks and keys stop at the dialog**, so Escape or a click inside it doesn't also reach the row or the page.
