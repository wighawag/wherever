---
title: Foreground questions: one compact toast that answers, folding into a slim bar
slug: question-toasts-and-bar
spec: notifications-compact
blockedBy: [web-push-question-payload, chat-session-menu]
covers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22]
---

## What to build

Replace today's foreground card for questions with the compact toast and the slim bar:

- The page receives the posted push with `data.kind` / `data.itemId` (from `web-push-question-payload`). A question is looked up by `itemId` in `shipmatesStore`; if absent, wait up to 5 s for a `shipmates_update` carrying it (the push is sent before the throttled flush, default 2 s). Drop it only if a snapshot RECEIVED after the push (without `inboxError`) lacks it or shows it closed; if no snapshot arrives within 5 s (socket down or stale), show a fallback toast from the push's (now short) title and body with Open, so the question is never shown nowhere.
- "Needs you is open" means `sessionView === 'inbox'` AND the sidebar is visible (phone: `sidebarOpen`; desktop: not collapsed to the rail); `sessionView` alone stays `'inbox'` after the drawer closes. "Open ›" without a session and the bar's View must open the drawer or expand the rail, not just set the view. A question suppressed because Needs you is open does NOT enter the bar (the user is looking at it).
- A pure, unit-tested model (core) owns: the queue (one toast at a time, "+N more"), the 8 s auto-hide (paused while touched / hovered, while an answer is sending, or while an error shows), folding into the bar, suppression (no toast while the Needs you panel is open; a question from the session on screen skips the toast but enters the bar), ✕ / swipe-up dismissal (removes it from the toast AND the bar; it stays in Needs you), removal when the item leaves the inbox (answered anywhere), and device-local persistence of the bar's questions (localStorage, ids only, pruned against the inbox on each received `shipmates_update` with `available: true` and no `inboxError`; removal on answer is skipped for an `inboxError` snapshot too).
- The toast (dark, amber accent, under the chat top bar, overlaying the conversation, never the composer): "<from> asks", the question clamped to 2 lines, the options as chips that answer through `answerShipmatesItem` (as `ShipmatesInbox.svelte` does: chips disabled while sending, the error shown in the toast), "Open ›" (the asking session via its `sessionId`, else the Needs you panel), ✕, swipe up to dismiss. A free-text question shows "Open ›" and "Answer in Needs you" (opens the panel).
- The slim bar under the top bar: "N questions for you · View" (amber), View opens Needs you. Leave room for the updates part (next task).
- Remove `Notifications.svelte` and its `+layout.svelte` mount (its `{body}.` is the doubled ".."); keep update pushes working with a minimal interim render until `update-toasts-and-list` (for example reuse the new toast shell with the push title and body and `openNotificationTarget` on tap), so no notification is lost between tasks.

## Acceptance criteria

- [ ] The model is unit-tested with fake time: queue and +N, 8 s hide and pauses, suppression rules, dismissal, removal on answer, persistence round trip and pruning.
- [ ] Toast and bar match `notifications.png` panels 2 and 3 at phone and desktop widths; never over the composer.
- [ ] Answering by chip works and shows errors; Open goes to the session or the inbox; ✕ and swipe up dismiss.
- [ ] No toast while Needs you is open; a question from the session on screen goes straight to the bar.
- [ ] The old white card is gone and update pushes still show (interim) and open their target.
- [ ] Web and server checks and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour (Web Push, shipmates notifications, foreground notifications).

## Blocked by

- web-push-question-payload: the `kind` / `itemId` data this reads.
- chat-session-menu: the last chat task editing the top bar and main column of `+page.svelte` where the toast and bar live.

## Prompt

> Goal: spec `work/specs/tasked/notifications-compact.md` stories 1 to 11 and 22 (resolved decision 2 defines the bar). Mockups: `docs/design/sidebar-and-chat-redesign/notifications.png` (source `notifications.html`) and `current-notifications.png` (today).
>
> `web/src/lib/core/notifications/notifications.test.ts` tests the service being reshaped; keep or migrate it. There is no swipe helper yet (`session-row-swipe-to-close` adds one for rows, possibly in parallel): do not depend on it. Where to look: `web/src/lib/core/service-worker/index.ts` (`navigator.serviceWorker.onmessage` adding `push-notification`s), `web/src/lib/core/notifications/` (the store, `openNotificationTarget`, `Notifications.svelte`), `web/src/routes/+layout.svelte` (its mount), `web/src/routes/+page.svelte` main column (the top bar from `chat-top-bar`, `sessionView` for "Needs you open", the open session), `shipmatesStore` and `answerShipmatesItem` (`web/src/lib/session-store.ts`, `web/src/lib/wherever.ts`), `web/src/lib/components/ShipmatesInbox.svelte` (answer and open-asker behaviour to mirror), `web/src/lib/core/shipmates.ts` (`ShipmatesInboxItem`).
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/notifications-compact.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/question-toasts-and-bar-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.
