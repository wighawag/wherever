---
title: Compact chat (title top bar, ⋯ session menu, pill composer, full-width messages)
slug: chat-compact-layout
taskedAfter: [sidebar-compact-layout]
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + `CONTEXT.md` + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Resolved decisions (human, inbox `h_AaeffYeL` and `h_mH0GOtW1`, 2026-11-25)

1. Send button while the agent runs: an empty pill shows only ■ Stop; once there is text, ➤ (steer, today's Steer) appears and ■ stays beside it, so Stop is never hidden.
2. "Search in this chat" is left out of this redesign; captured as an idea note (`work/notes/ideas/search-in-this-chat.md`).
3. Also confirmed: Beep stays tri-state (Default / On / Off) in the ⋯ menu.

## Visual source of truth

The human-approved mockups in `docs/design/sidebar-and-chat-redesign/`:

- `phone.png` frames 2 and 3: the chat with the agent running, and while typing with the keyboard up; frame 4: the top-bar ⋯ session menu.
- `desktop.png`: the centered chat column, the desktop top bar (☆, connection state) and the pill composer.
- `live.png` bottom right: the top bar with the amber dot on ☰ and the open session's state dot in the subtitle.
- `current-chat-collapsed.png`, `current-chat-composer.png`, `current-chat-keyboard.png`: today's UI.

The mockup's "working 1m 12s" timer is DROPPED: no run start time exists client-side (only per-tool `startedAt`). Where a mockup and this spec disagree, this spec wins.

## Problem Statement

With the keyboard up on a phone, only about five lines of conversation are visible. The top bar spends its width on a folder label, a model dropdown and several buttons but never says which conversation this is. A settings strip (Hide thinking, Beep, Conversation, the context line, Cancel queued, Abort) sits permanently above the composer, and the composer adds its own row (Press Enter to send, Save draft, Drafts, Collapse). Assistant replies sit in bubbles that waste the right margin, and every tool call is a card.

## Solution

- A top bar with ☰, the session title (name, else first message) and "folder · model" under it, and ⋯. On desktop also ☆ and the connection state in the subtitle. ☰ carries an amber dot whenever anything waits for you; the subtitle starts with the open session's own state dot.
- A ⋯ session menu that gathers everything the top bar, the settings strip and the composer's extra row held: model, star, rename, copy link, close, the per-chat toggles (Beep, Conversation mode), the device settings (Hide thinking, Enter sends, voice settings), and context and versions as text.
- No settings strip. Context becomes a small ring with a percentage above the composer; Abort becomes the send button turning into ■ Stop while the agent runs.
- A one-line pill composer that grows with the text up to about 40% of the screen: ＋ (attach, save draft, drafts), the text, 🎤, and ➤ or ■.
- Messages: assistant text full width with no bubble, user messages as compact right-aligned bubbles, tool calls as one-line chips; on desktop a centered column of about 760px.

## User Stories

### Top bar

1. As a user, I want the top bar to show which conversation is open (its name, else its first message, truncated) with "folder · model" under it, so that I always know where I am.
2. As a user, I want the subtitle to start with the open session's state dot (the sidebar's legend; when the open session is not in the listing yet, running or idle from the streaming flag, as today's dot), so that I see at a glance whether it runs, waits for me, or is idle.
3. As a user on a phone, I want ☰ to carry an amber dot whenever any session waits for me (an open inbox question OR a session whose presence is waiting-for-human), keeping a tooltip and accessible label that say how many questions / sessions wait, so that the closed drawer never hides "needs you".
4. As a user on desktop, I want ☆ (star) in the top bar and the connection state ("connected", or the disconnected state) in the subtitle, so that the wide screen keeps its one-click star.
5. As a user, I want ⋯ at the right of the top bar to open the session menu, so that every per-session action has one home.
6. As a user with no session open, I want the top bar to keep today's status text ("Select a session from sidebar", "Search the web below…", "Not connected"), and ⋯ to hold only the "On this device" section (so Enter sends stays reachable on the home / web-search screen), so that the empty state still explains itself.
7. As a user viewing a read-only session, I want the read-only state shown in the top bar (the subtitle), so that I know why I cannot type.

### The ⋯ session menu

8. As a user, I want the ⋯ menu (bottom sheet on the phone, popover on desktop, the sidebar's menu primitive) to hold: Model (current model, opening the model list; text only on a read-only session or with no model list, as today), Star / Unstar, Rename, Copy link, Open in new tab (desktop), Close session (Reopen when closed; not on a read-only session), so that the session actions are together.
9. As a user, I want the ⋯ menu to keep the actions the top bar has only in some states: "Search the web" (when web search is configured), "Reset the assistant" (when viewing the assistant), so that nothing is lost.
10. As a user, I want the ⋯ menu to have a "This chat" section (Beep when done, Conversation mode) and an "On this device" section (Hide thinking, Enter sends, Voice settings…), so that the toggles are reachable without a permanent strip and say honestly what they apply to (this overrides the mockup's single "THIS CHAT" header: Hide thinking, Enter sends and the voice settings are device-wide today).
11. As a user, I want Beep to keep its three states (Default (on/off) / On / Off for this session, shown only on a drivable session as today) and Conversation mode to keep "for this conversation, following your default unless set", so that moving them changes where they are, not what they mean.
12. As a user, I want the voice settings that sit behind the composer's ⚙ (speech settings) reachable from the ⋯ menu, taking effect at once in the 🎤 button, with a speech error shown next to 🎤 in the pill (today it shows only inside the ⚙ popover), so that the composer can lose its extra controls.
13. As a user, I want the ⋯ menu to show the context usage ("Context 33.1% of 1.0M") and the versions ("v0.29.0 / srv 0.29.0") as text, so that the details are one tap away.
14. As a user, I want Rename in the ⋯ menu to rename the open session exactly like the sidebar's row Rename (the same prompt and the same refusals), so that I can name the conversation I am in.

### Composer

15. As a user, I want a one-line pill composer that grows with the text up to about 40% of the screen height and then scrolls, so that the conversation keeps most of the screen.
16. As a user, I want the pill to hold ＋, the text, 🎤 and the send button, so that everything I need while writing is inside it.
17. As a user, I want ＋ to open attach file, save as draft and the drafts list, so that those actions stop needing their own row.
18. As a user, I want "Drafts (N)" also as a small link above the pill when I have drafts, so that I see I have some.
19. As a user, I want the send button to turn into ■ Stop while the agent runs (with text in the pill, ➤ steers and ■ stays beside it, resolved decision 1), and on a read-only session, which has no composer, the read-only stub to keep a ■ Stop while the agent runs (today's Abort shows there too), so that Abort is where my thumb already is.
20. As a user, I want "Cancel queued (N)" to stay available while steers are queued, shown above the pill, so that I can still drop queued steers without aborting the turn.
21. As a user, I want a small context ring with its percentage above the pill (tooltip: tokens of window), so that context usage stays visible without a strip.
22. As a user, I want the Expand / Collapse button and the "Press Enter to send" row gone (Enter sends moves to the ⋯ menu; the placeholder says what Enter does on desktop), so that the composer is one element.
23. As a user, I want nothing the composer does today to regress: attachments and their upload chips (progress, pause, retry, cancel), queued steers, drafts (replace / append / cancel, offline list), voice input and conversation mode (hands-free), the "/" skill menu, the disconnected banner, and the web-search mode of the empty state (with its model picker), so that the redesign is visual only.
24. As a user on a phone, I want the pill to stay right above the keyboard while I type, with the conversation scrolled to the latest message, so that I see what I am answering.

### Messages

25. As a user, I want assistant text full width with no bubble and no wasted right margin, so that long answers read like a document.
26. As a user, I want my own messages as compact right-aligned bubbles, so that turns stay easy to tell apart.
27. As a user, I want each generic tool call as a one-line chip (status, tool name, short args, duration) that expands to today's arguments and output on tap, so that tool-heavy turns stop flooding the screen.
28. As a user, I want the tools that render content today (attached files, downloads, images, audio, video, spoken replies) to keep rendering their content, so that chips never hide a result I need to see.
29. As a user, I want every per-message action to stay reachable: on assistant messages Copy, raw / rendered markdown, and expand / collapse of a long reply in conversation mode; on my messages Fork (edit and resend), the "Sending" indicator, the "Queued" marker, Retry / Discard of an undelivered message, the skill-invocation chip and the attachment list; and the shipmates card message, so that losing the bubble loses nothing.
30. As a user on desktop, I want the messages in a centered column of about 760px, with the composer aligned to it, so that lines stay readable on a wide screen.
31. As a user, I want thinking blocks, the working indicators, "load more history" and timestamps to keep working as today, so that only the layout changes.

### Autonomy notes

- **`humanOnly`:** omitted. Ordinary UI work.
- **`needsAnswers`:** omitted. The human answered the open questions (see Resolved decisions).

> Tasked: the implementation and testing detail moved into the tasks with `spec: chat-compact-layout` (`work/tasks/`); the chat control map is in `chat-session-menu`; the rename write-path rationale goes to the ADR written by `rename-session-endpoint`.

## Out of Scope

- "Search in this chat" (resolved decision 2: idea note `work/notes/ideas/search-in-this-chat.md`).
- A run timer ("working 1m 12s"): needs a run start time the client does not have.
- The sidebar, the Live strip and the row menus (spec `sidebar-compact-layout`).
- Changing what Conversation mode, Beep or the voice settings do.
- Per-message steer cancel (pi's queue clear is all-or-nothing, see `ChatMessageList`).

## Further Notes

- Known risks: the growing composer with the mobile keyboard (nothing may regress: attachments, upload chips, queued steers, drafts, voice, conversation mode); full-width assistant messages must keep Copy / raw / Fork / Retry reachable; moving settings into menus must lose nothing (the table above is the checklist).
