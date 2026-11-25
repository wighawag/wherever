---
title: Close a question's system notification when it is answered anywhere
slug: close-answered-system-notifications
spec: notifications-compact
blockedBy: [question-toasts-and-bar, update-toasts-and-list]
covers: [21]
---

## What to build

Resolved decision 1: closed by code on the device, from any open wherever page; no extra pushes.

- On each RECEIVED `shipmates_update` with `available: true` and WITHOUT `inboxError` (from `web-push-question-payload`; never the initial empty store state), the page lists `registration.getNotifications()`, picks those whose tag is `shipmates-<itemId>` for an item not in the inbox AND whose send time (`n.timestamp ?? n.data.sentAt`) is older than the snapshot minus a few seconds (keep a notification with neither), and closes them. The time guard only covers the race with a just-arrived push; the `inboxError` flag covers failed reads.
- On load and on becoming visible, act only on a snapshot received AFTER that moment on the current connection (never the cached store from before the socket dropped).
- The selection is a pure, unit-tested helper; the browser call is a thin wrapper that tolerates no service worker / no permission.

## Acceptance criteria

- [ ] The stale-tag helper is unit-tested: an `inboxError` snapshot closes nothing, a notification with no timestamp and no `sentAt` is kept, open item kept, answered item closed, non-shipmates tags ignored, a notification newer than the snapshot kept, no action before the first real snapshot.
- [ ] Manual check: with the PWA in the background, answering a question on another device closes the system notification on this one (when the page is alive), or at the next open.
- [ ] Web and server checks and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour (Web Push, shipmates notifications, foreground notifications).

## Blocked by

- question-toasts-and-bar, update-toasts-and-list: edit the same page-side push and shipmates wiring and the same `CONTEXT.md` section; serialised.

## Prompt

> Goal: spec `work/specs/tasked/notifications-compact.md` story 21. Mockups: `docs/design/sidebar-and-chat-redesign/notifications.png` (source `notifications.html`) and `current-notifications.png` (today). (fourth panel).
>
> Where to look: `parseShipmatesUpdate` and `emptyShipmatesState` in `web/src/lib/core/shipmates.ts`, used by `shipmatesStore` in `web/src/lib/session-store.ts`, the service-worker registration in `web/src/lib/core/service-worker/index.ts`, the tag format from `web-push-question-payload`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/notifications-compact.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/close-answered-system-notifications-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

Recorded in `work/notes/observations/close-answered-system-notifications-decisions.md`:
1. The closer is fed from the frame handler, not the store.
2. The safety window is 5 s.
3. A snapshot's time is when this page received it.
4. Frames are coalesced: it acts on the newest after 1 s of quiet. This guards against stale frames that arrive in a burst after the page was frozen.
5. "On load and on becoming visible" is handled through `noteVisible()`.
6. With no service worker or permission, it silently does nothing.
7. Limit of the manual check: the real two-device case could not be exercised here and is still open.
