---
title: Human device pass: sidebar on a real phone (swipe, sheets, drawer)
slug: sidebar-phone-device-pass
spec: sidebar-compact-layout
humanOnly: true
blockedBy: [session-row-swipe-to-close, sidebar-desktop-rail]
covers: []
---

## What to build

A short check by the human on a real phone (Android Chrome and, if available, iOS Safari) after the sidebar tasks land: row swipe vs vertical scroll, the threshold feel, the bottom sheets, long-press on rows and dots and tabs, the 86% drawer and the overlay tap. Tune the swipe constants or file follow-up tasks for what is wrong.

## Acceptance criteria

- [ ] The human has used the drawer on a real phone and either signed it off or filed follow-up tasks.
- [ ] Swipe thresholds tuned if needed (changeset if code changed).

## Blocked by

- session-row-swipe-to-close, sidebar-desktop-rail: the last sidebar tasks.

## Prompt

> This task needs a human with a phone; an agent can only prepare a checklist. Checklist: swipe a row left slowly and quickly; scroll the list vertically starting on a row; tap a row; long-press a row (native link menu); open the row sheet and the folder sheet; long-press a tab and a state dot; open and close the drawer with the overlay. Record findings in `work/notes/observations/sidebar-phone-device-pass.md`.
