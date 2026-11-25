---
title: Human device pass: notifications on a real phone
slug: notifications-phone-device-pass
spec: notifications-compact
humanOnly: true
blockedBy: [update-toasts-and-list, close-answered-system-notifications]
covers: []
---

## What to build

A short check by the human on a real phone after the notification tasks land: a question toast while chatting (answer by chip, Open, ✕, swipe up), the 8 s hide and the slim bar, an update toast and the updates list, the short system notification in the background, its replacement on a re-push, and its closing after answering elsewhere.

## Acceptance criteria

- [ ] The human has checked notifications on a real phone and either signed them off or filed follow-up tasks.

## Blocked by

- update-toasts-and-list, close-answered-system-notifications: the last notification tasks.

## Prompt

> Precondition: an active assistant with this phone subscribed to push in the wherever settings (without it nothing is pushed). This task needs a human with a phone and a second session that asks questions (`human_ask`) and sends `assistant_notify`. Record findings in `work/notes/observations/notifications-phone-device-pass.md`.
