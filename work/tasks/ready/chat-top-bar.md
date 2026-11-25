---
title: Chat top bar: session title, state dot and folder · model, ☰ amber dot, read-only Stop
slug: chat-top-bar
spec: chat-compact-layout
blockedBy: [state-dot-legend, sidebar-desktop-rail, chat-pill-composer]
covers: [1, 2, 3, 4, 6, 7, 19]
---

## What to build

Rework the top bar in `+page.svelte` (the main column only):

- ☰ (phone) with an amber dot whenever anything waits for you (the "anyone waits for you" helper from `state-dot-legend`: inbox item OR a session whose presence is waiting-for-human), keeping a tooltip and accessible label with the count.
- The session title: `sessionListLabel` of the open session's listing entry (name, else first message), truncated; the folder name when the session is not listed yet. Under it: the open session's state dot (shared legend; when not listed, running / idle from `appState.isStreaming`), folder · model, "read-only" when read-only, and on desktop the connection state ("connected" / disconnected).
- With no session open: today's status text unchanged.
- Keep, for now, the existing right-hand actions (web search 🔍, ↺ Reset assistant, ☆, ⊘ Close / ↺ Reopen, the model select) so nothing is lost; `chat-session-menu` moves them into ⋯. Move them to the right of the title block.
- The ☰ label's counts come from the "anyone waits for you" helper (open inbox items and waiting-for-human sessions).
- On a read-only session the read-only stub under the messages keeps a ■ Stop while the agent runs (today's Abort shows there via the settings strip; the server accepts abort from a read-only client). Then remove the strip's read-only Abort that `chat-pill-composer` kept (the read-only context label stays in the strip until `chat-session-menu`).

## Acceptance criteria

- [ ] Top bar matches `phone.png` frame 2, `desktop.png` and `live.png` ("Chat top bar and closed drawer").
- [ ] The amber ☰ dot appears for an inbox question and for a waiting-for-human presence; its label states the count.
- [ ] Title fallback and the subtitle dot fallback are unit-tested if extracted into helpers.
- [ ] Read-only sessions show ■ Stop while running and it aborts.
- [ ] No existing top-bar action is lost.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- state-dot-legend: dot and "anyone waits for you" helper.
- sidebar-desktop-rail: last sidebar task editing `+page.svelte`; serialised.
- chat-pill-composer: the settings strip's Abort is removed there; this adds the read-only Stop.

## Prompt

> Goal: spec `work/specs/tasked/chat-compact-layout.md` stories 1 to 4, 6, 7 and the read-only part of 19. Mockups: `phone.png` frame 2, `desktop.png`, `live.png` bottom right.
>
> Ownership: this task edits only the MAIN COLUMN of `web/src/routes/+page.svelte` (top bar, banners, read-only stub). Where to look: the "Top bar" block (the `=` menu button and its `shipmatesBadge` dot, `startSearch`, the status text, folder and model selector, `resetAssistant`, star, close / reopen, read-only badge), `currentListed` / `currentStarred` / `currentClosed`, the read-only stub before `ChatInput`, `abort` in `web/src/lib/wherever.ts`, `sessionListLabel` in `web/src/lib/core/live-sessions.ts`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/chat-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/chat-top-bar-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.
