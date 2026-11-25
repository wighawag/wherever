---
title: Foreground updates: blue toast above the composer, folding into the bar, persisted list
slug: update-toasts-and-list
spec: notifications-compact
blockedBy: [question-toasts-and-bar]
covers: [12, 13, 14, 15, 16, 17]
---

## What to build

- Non-question pushes (`data.kind: 'update'`, or no kind from an older server) show as the dark toast with a blue accent, above the composer pill (at the bottom of the main column when there is no composer: read-only session, empty state): title and 2 lines of body; tap opens its target (`openNotificationTarget`, as today's "ok"; a `navigate` of `/#` with an empty session id means the main screen); ✕ dismisses.
- Auto-hide after 6 s unless touched; it then folds into the slim bar, which becomes combined: "2 questions for you · 1 update" (questions part opens Needs you, updates part opens the updates list).
- The updates list (the shared menu primitive: sheet on phone, popover on desktop): each update with title, short body, time, Open and Dismiss, plus Clear all. Opening or dismissing removes it.
- Updates persist device-locally (localStorage, a capped list, newest first) until opened or dismissed; the list holds only updates that arrived while wherever was on screen (background pushes stay system notifications).
- Extend the pure model from `question-toasts-and-bar`; replace its interim update render.

## Acceptance criteria

- [ ] Model tests cover the update queue, 6 s hide, fold, list operations (open, dismiss, clear all), persistence and cap.
- [ ] Toast, combined bar and list match `notifications.png` panel 3 (with the human's correction that updates persist).
- [ ] Web and server checks and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour (Web Push, shipmates notifications, foreground notifications).

## Blocked by

- question-toasts-and-bar: the model, the toast shell and the bar this extends.

## Prompt

> Goal: spec `work/specs/tasked/notifications-compact.md` stories 12 to 17. Mockups: `docs/design/sidebar-and-chat-redesign/notifications.png` (source `notifications.html`) and `current-notifications.png` (today).
>
> Where to look: the model and components added by `question-toasts-and-bar` (read its done record), `openNotificationTarget` in `web/src/lib/core/notifications/index.ts`, the menu primitive from `folder-header-menu-and-close-all`, the composer position from `chat-pill-composer`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/notifications-compact.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/update-toasts-and-list-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.
