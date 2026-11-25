---
title: Compact notifications (question toasts that answer, folding updates, short system notifications)
slug: notifications-compact
taskedAfter: [chat-compact-layout]
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + `CONTEXT.md` + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Resolved decisions (human)

1. Closing a question's system notification once it is answered elsewhere (`h_GqATSGFx`): closed from any open wherever page on that device only (instant when a tab or the PWA is alive, otherwise at the next open); no extra "close" pushes.
2. Which questions the slim bar counts (`h_XAcw85Tm`, the human agreed with the recommendation A): only questions that showed as a toast on this device (or skipped it because they came from the session on screen) and are still open, persisted on the device like updates; ✕ on the toast removes the question from the bar (it stays in Needs you); answering anywhere removes it.


## Visual source of truth

- `docs/design/sidebar-and-chat-redesign/notifications.png` (source `notifications.html`): today, the compact question toast, after it hides (the slim bar and an update toast), and the system notifications in the background.
- `docs/design/sidebar-and-chat-redesign/current-notifications.png`: the human's screenshot of today's notifications.

Where the mockup and this spec disagree, this spec wins. The mockup shows updates vanishing after their toast hides; the human corrected that: they fold into the bar and persist (stories 13 to 15).

## Problem Statement

When wherever is open and a push arrives, the service worker hands it to the page, which shows a white card with the FULL push body. That body was written for Telegram and the OS: it repeats the options, says "Answer in the wherever inbox", and ends in a doubled "..". Cards stack, cover the chat and the composer, never hide, and offer "ok" (which actually opens), "dismiss" and ✕. To answer, the user must leave the conversation for the inbox. In the background, the system notification carries the same long text, has no tag (a rare re-push would duplicate it), and stays after the question is answered elsewhere.

## Solution

- A question arrives as ONE compact dark toast under the top bar, built from the inbox item (not the push text): who asks, the question in two lines, the options as chips that answer directly, and "Open ›". One at a time, "+N more" for the rest. It hides after 8 s unless touched and folds into a slim bar under the top bar ("2 questions for you") that stays until they are answered.
- Other notifications (assistant_notify, a lane finished) use the same dark toast with a blue accent, above the composer, two lines, hiding after 6 s; they also fold into the bar ("1 update") and stay listed until opened or dismissed.
- No toast when the inbox is open or when the question comes from the session on screen; a toast and its bar entry vanish when the item is answered elsewhere.
- System notifications in the background: a short title "X asks" and the question only, one per item (a re-push replaces it), closed when the item is answered.

## User Stories

### Question toasts (app in the foreground)

1. As a user, I want a question pushed while wherever is on screen to appear as one compact dark toast under the top bar, overlaying the conversation but never the composer, so that I see it without losing my place.
2. As a user, I want the toast built from the inbox item (sender "X asks", the question clamped to 2 lines, the options) rather than from the push text, so that it is short and never repeats instructions meant for Telegram.
3. As a user, I want the question's options as chips that answer it directly (the same path as answering in Needs you), so that I can answer without leaving the conversation. While an answer is sending, the chips are disabled; an error (not connected, timeout, already closed) shows inside the toast; the toast does not auto-hide while sending or showing an error.
4. As a user, I want "Open ›" on the toast to open the asking session (or Needs you when the question has no session), so that I can read the context first.
5. As a user, I want a free-text question (no options) to show "Open ›" and a way to the inbox to type the answer, so that every question can be answered.
6. As a user, I want only one question toast at a time, with "+N more" when several are waiting, so that toasts never stack over the chat.
7. As a user, I want to dismiss a toast with ✕ or a swipe up, the question staying in Needs you, so that dismissing never loses it.
8. As a user, I want a question toast to hide after about 8 s unless I am touching or hovering it, so that it does not sit on my conversation.
9. As a user, I want hidden questions (those that toasted on this device, or skipped the toast because they came from the session on screen; not the ones I dismissed with ✕) to fold into a slim bar under the top bar ("N questions for you · View") that stays until they are answered, persisted on this device across reloads, alongside the amber dot on ☰, so that a hidden question is never forgotten.
10. As a user, I want no question toast while the Needs you panel is open, or when the question comes from the session on screen (it is already in the chat), so that I am not told twice. (Its tool call is in the chat, as a collapsed chip without answer controls, so a question from the session on screen skips the toast but still enters the slim bar, resolved decision 2.)
11. As a user, I want a toast and its bar entry to vanish when the question is answered anywhere else (Telegram, a terminal, another device, the session itself), so that I never answer a closed question.

### Other notifications (updates)

12. As a user, I want other notifications (assistant_notify, a lane finished, any non-question push) as the same dark toast with a blue accent, above the composer, the title and two lines of body (at the bottom of the main column when no composer is shown: a read-only session, the empty state), so that updates look like the rest of the app.
13. As a user, I want an update toast to hide after about 6 s unless touched and then fold into the slim bar ("N updates"), not vanish, so that I can read it later.
14. As a user, I want "View" on the updates part of the bar to list the updates, each with Open (its target) and Dismiss, plus Clear all, so that I can go through them when I have time.
15. As a user, I want updates to stay listed on this device until I open or dismiss them, including across reloads, so that a reload does not lose them. (The list holds the updates that arrived while wherever was on screen; pushes that arrive in the background are system notifications only.)
16. As a user, I want tapping an update toast to open its target, as today's "ok" button does, so that the shortcut keeps working.
17. As a user, I want one combined slim bar when both kinds wait ("2 questions for you · 1 update"), where the questions part opens Needs you and the updates part opens the updates list, so that the bar costs one line.

### System notifications (app in the background)

18. As a user, I want a question's system notification to have a short title ("X asks") and the question only as its body (the options, the blocking line and "Answer in the wherever inbox" are intentionally dropped from it), so that it reads at a glance on the lock screen.
19. As a user, I want the Telegram message for a question to keep its options and "Answer in the wherever inbox" lines, so that Telegram still says how to answer there.
20. As a user, I want each question's system notification to carry its own tag, so that a re-push replaces it instead of adding a duplicate.
21. As a user, I want a question's system notification to close automatically once the question is answered anywhere (resolved decision 1: by any open wherever page on that device), so that my notification shade only holds open questions.
22. As a user, I want the doubled ".." at the end of notification bodies gone, so that text ends cleanly.

### Autonomy notes

- **`humanOnly`:** omitted. Ordinary UI, service-worker and server work.
- **`needsAnswers`:** omitted. The human answered both questions (Resolved decisions).

> Tasked: the implementation and testing detail moved into the tasks with `spec: notifications-compact` (`work/tasks/`).

## Out of Scope

- Answering from OS notification action buttons.
- Changing which events push, or the Telegram wording beyond keeping it.
- Notification sounds or vibration patterns.
- Action buttons on system notifications (the mockup's OPEN / LATER are illustrative; the service worker ignores `actions`).

## Further Notes

- Toasts and system notifications need an active assistant with a subscribed device (the Web Push channel exists only then); with shipmates but no assistant there are no pushes, as today.
- Builds on spec `chat-compact-layout` (top bar, composer pill, the amber dot on ☰) and the menu primitive of `sidebar-compact-layout` (for the updates list).
