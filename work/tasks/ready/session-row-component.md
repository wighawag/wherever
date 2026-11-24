---
title: Extract the sidebar session row into a reusable component (no behaviour change)
slug: session-row-component
spec: session-list-by-owner-view
blockedBy: [live-strip-names-the-session-waited-on, closed-sessions-in-the-sidebar, closed-sessions-cascade-and-undo]
covers: []
---

## What to build

A pure refactor that prepares the "By owner" view (spec `session-list-by-owner-view`). Today each session row in `SessionBrowser.svelte` is inline markup inside the folder loop's `buildForkTree` iteration (link, working dot, name/preview, "↳ spawned by" hint, presence line, star / close / delete buttons, owned-children chips, fork indentation). Move it into a `SessionRow.svelte` component that the folder view renders, with NO visible or behavioural change.

The component receives what it needs as props, including:
- the session, its depth (indentation), whether it is the open session, `readOnly` (hides delete and close, as today);
- two separate flags: `closed` (marked closed, offers Reopen) and `dimmed` (visual only; the By-owner filter will dim non-matching ancestors that are not closed);
- the nesting marker kind for depth > 0: `fork` (today's "↳" titled "Forked from the session above", the default) or `spawned` (for the By-owner view);
- callbacks for open (plain-click intercept; modifier-click keeps the native link), star, close / reopen (including the cascade prompt), and delete;
- the presence;
- an **owner-hint label** prop (the folder view passes today's text; the By-owner task will pass "(not listed)" for an unlisted owner);
- a flag to show or hide the owned-children chips (the folder view shows them).

## Acceptance criteria

- [ ] The folder view renders every row through `SessionRow.svelte`; the markup, classes, hrefs, click behaviour and row buttons are unchanged (compare before and after by hand in the browser, and record what was checked).
- [ ] No logic moves into the component that is not already in a pure helper; any helper touched keeps its tests green.
- [ ] Web checks (`svelte-check` / lint) and tests pass.
- [ ] Changeset (`"wherever-dev": patch`).

## Blocked by

- live-strip-names-the-session-waited-on, closed-sessions-in-the-sidebar, closed-sessions-cascade-and-undo: the last tasks editing the row markup, `SessionBrowser.svelte` and the strip wiring. Extracting after them avoids rewriting a moving target.

## Prompt

> Goal: a behaviour-preserving extraction of the sidebar row, the first step of spec `work/specs/tasked/session-list-by-owner-view.md`. Do not add the By-owner view here.
>
> Where to look: `web/src/lib/components/SessionBrowser.svelte` (the `{#each buildForkTree(folder.sessions)}` loop and its row markup, `sessionLabel`, `handleSessionClick`, star / close / delete handlers, the owned chips, the cascade confirm), `web/src/lib/components/LiveStrip.svelte` for how the strip already receives callbacks as props.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): the row may have gained or lost elements since this was written; extract what is there. If the row is already a component, close the task as done-by-drift with a note.
>
> RECORD non-obvious in-scope decisions (prop names, what stayed in the parent) in `work/notes/observations/session-row-component-decisions.md` and end your final report with a `## Decisions` block linking it. Never write em dashes.
