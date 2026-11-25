---
title: Human device pass: chat on a real phone (keyboard, composer, menus)
slug: chat-phone-device-pass
spec: chat-compact-layout
humanOnly: true
blockedBy: [chat-session-menu]
covers: []
---

## What to build

A short check by the human on a real phone after the chat tasks land: the growing pill with the keyboard up (pill stays above the keyboard, list scrolled to the latest message), attachments and upload chips, drafts, voice and conversation mode, Stop / steer while running, the ⋯ sheet, message actions by tap, tool chips. File follow-up tasks for what is wrong.

## Acceptance criteria

- [ ] The human has used the chat on a real phone and either signed it off or filed follow-up tasks.

## Blocked by

- chat-session-menu: the last chat task.

## Prompt

> This task needs a human with a phone. Checklist: type a long message (pill grows to about 40%, then scrolls; the context ring stays visible with the keyboard up); attach a photo and watch the chip; save and load a draft; dictate with 🎤; toggle conversation mode in ⋯; send while the agent runs (steer) and stop it; open ⋯ and every item in it; tap an assistant message to reveal Copy; expand a tool chip. Record findings in `work/notes/observations/chat-phone-device-pass.md`.
