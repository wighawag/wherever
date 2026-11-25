---
title: Desktop: « collapses the sidebar to a rail
slug: sidebar-desktop-rail
spec: sidebar-compact-layout
blockedBy: [sidebar-header-tabs-current-line, sidebar-filter-row-view-options]
covers: [19]
---

## What to build

On desktop (`md` and up), « in the sidebar header collapses the sidebar to a thin rail; » on the rail expands it. Remembered on this device (localStorage).

The rail shows: », the tab icons (Assistant, Needs you with its badge, Search, Read-only, same conditions and tooltips), + new session, and an amber dot when anything waits for you (the "anyone waits for you" helper from `state-dot-legend`). A tab or + on the rail expands the sidebar and then acts (+ opens the new-session form exposed by `sidebar-filter-row-view-options`). The phone drawer is unaffected.

## Acceptance criteria

- [ ] « / » collapse and expand, remembered per device; the chat column takes the freed width.
- [ ] The collapsed-state read / write helper is unit-tested.
- [ ] Rail icons work as described, including + opening the create form and the amber dot.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- sidebar-header-tabs-current-line: the header and tabs this extends (same part of `+page.svelte`).
- sidebar-filter-row-view-options: exposes opening the create form.

## Prompt

> Goal: spec `work/specs/tasked/sidebar-compact-layout.md` story 19 and resolved decision 2. Mockup: `desktop.png` shows the « button; the rail itself is not drawn, the spec defines it.
>
> Edit only `+page.svelte`; call the opener exposed by `sidebar-filter-row-view-options` without editing `SessionBrowser.svelte` (other sidebar tasks edit it in parallel). Where to look: the sidebar half of `web/src/routes/+page.svelte` (after `sidebar-header-tabs-current-line`), `sidebarOpen` and the `md:` classes on the sidebar container, the "anyone waits for you" helper from `state-dot-legend`, the create-form opener from `sidebar-filter-row-view-options`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/sidebar-desktop-rail-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.
