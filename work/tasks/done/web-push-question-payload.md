---
title: Web Push: short per-item question notifications with a tag and kind / itemId data
slug: web-push-question-payload
spec: notifications-compact
blockedBy: [folder-header-menu-and-close-all]
covers: [18, 19, 20]
---

## What to build

Server side of the compact notifications:

- `shipmatesNotification` (`server/src/shipmates-service.ts`) also returns the raw `question` text. The shipmates notifier in `server/src/index.ts` (which today passes only `{title, body, source, navigate, question: {options}}` and drops `itemId`) passes `question: {options, itemId, text}` on the `ChannelNotification` (`server/src/assistant-channels.ts`).
- The Web Push channel (`webPushPayload` in `server/src/web-push.ts`) shapes its own payload:
  - a question: title "<source> asks", body = the question text only (no "Options: …", no blocking line, no "Answer in the wherever inbox."), `tag: shipmates-<itemId>`, `data: {kind: 'question', itemId}`;
  - anything else: today's title and body, `data: {kind: 'update'}` and a unique `tag` per notification.
  - `data` and `tag` go inside `notification` (`DeclarativePushPayload`); the service worker already forwards `notif.data` (merging `navigate`) and `notif.tag`, and posts them to a focused page.
- Telegram's wording is unchanged (it keeps the options and the inbox line). The new `question` fields (`itemId`, `text`) are optional on `ChannelNotification`, so existing Telegram tests that build `question: {options}` stay valid.
- The question payload's `data` also carries `sentAt` (server ms), for `close-answered-system-notifications` (where `Notification.timestamp` is missing on some browsers).
- Failed inbox reads become distinguishable: `ShipmatesService.snapshot()` today answers `{available: true, inbox: []}` when the read fails, which the page cannot tell from "everything answered". Add `inboxError: true` to that snapshot (catch path), and mirror it in the web's `ShipmatesState` / `parseShipmatesUpdate` (`web/src/lib/core/shipmates.ts`), so later tasks skip such snapshots.

## Acceptance criteria

- [ ] Server tests cover the question payload (title, body exactly the question, tag, data) and the update payload (kind, unique tag), and that the Telegram text is unchanged.
- [ ] Tests cover `inboxError` on a failed read (server) and its parsing (web `shipmates.test.ts`), and `data.sentAt` on the question payload.
- [ ] A manual check with a subscribed device shows the short question notification, and a second push for the same item replaces it instead of adding one.
- [ ] Tests isolate the state dir (web-push subscriptions, shipmates notified file) in temp folders and assert the real ones are untouched.
- [ ] Web and server checks and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour (Web Push, shipmates notifications, foreground notifications).

## Blocked by

- folder-header-menu-and-close-all: also edits `server/src/index.ts` (after `rename-session-endpoint`); serialised to avoid conflicts.

## Prompt

> Goal: spec `work/specs/tasked/notifications-compact.md` stories 18 to 20. Mockups: `docs/design/sidebar-and-chat-redesign/notifications.png` (source `notifications.html`) and `current-notifications.png` (today). (fourth panel; the OPEN / LATER buttons are illustrative and out of scope).
>
> Where to look (large files: grep, then read bounded ranges): `server/src/shipmates-service.ts` (`ShipmatesNotification`, `shipmatesNotification`), `server/src/index.ts` (the `dispatcher.notify({ ... question: { options: n.options } })` call of the shipmates notifier), `server/src/assistant-channels.ts` (`ChannelNotification.question`), `server/src/web-push.ts` (`DeclarativePushPayload`, `webPushPayload`, `notify`), `server/src/telegram-channel.ts` (must keep its wording), `web/src/service-worker/index.ts` (`DeclarativePushNotification`, `handlePush`: check it forwards `data` and `tag` as expected). Existing tests: `server/test/` web-push and shipmates notification tests.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/notifications-compact.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/web-push-question-payload-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

Seven small choices are recorded in `work/notes/observations/web-push-question-payload-decisions.md`, all easy to reverse:
1. A push is treated as a question only when `question.itemId` is set.
2. An empty source gives the title "Question for you".
3. A missing `text` falls back to the full body.
4. Update tags are `update-<uuid>`, one per notify, so every device gets the same tag for the same notification.
5. `sentAt` is on question pushes only.
6. `inboxError` is sent only when true, never as `false`.
7. There is no `renotify`, so a replaced notification doesn't alert again.
