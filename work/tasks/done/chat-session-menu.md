---
title: Chat ⋯ session menu: actions, This chat and On this device settings; settings strip removed
slug: chat-session-menu
spec: chat-compact-layout
blockedBy: [chat-top-bar, speech-settings-panel-store, session-row-rename, folder-header-menu-and-close-all]
covers: [4, 5, 6, 8, 9, 10, 11, 12, 13, 14]
---

## What to build

Add ⋯ to the right of the top bar, using the shared menu primitive (bottom sheet on phone, popover on desktop), and move every remaining control into it:

- Session actions: Model (current model; opens the model list; text only on a read-only session or with no model list), Star / Unstar, Rename (the shared rename prompt from `session-row-rename`, same refusals), Copy link, Open in new tab (desktop), Close session / Reopen (not on read-only; through the existing close flow), Search the web (when configured, today's 🔍), Reset the assistant (when viewing the assistant).
- "This chat": Beep when done (tri-state Default (on/off) / On / Off as today, only on a drivable session), Conversation mode (per conversation, following the default unless set, as today).
- "On this device": Hide thinking, Enter sends (moved from the ＋ menu), Voice settings… (the panel from `speech-settings-panel-store`).
- Text: context ("Context 33.1% of 1.0M") and versions ("v… / srv …").
- With no session open, ⋯ shows only "On this device" (so Enter sends stays reachable on the home / web-search screen).
- The ⋯ Conversation mode item must call `unlockTts()` inside its click handler, as today's strip toggle does (`toggleConversationMode`): without it, mobile drops every spoken reply.
- Remove the ⚙ cog from `SpeechButton` (its panel now lives in ⋯ "Voice settings…").
- Note in the done record: with no session open, the Conversation default is edited in Connection Settings (today's strip toggle edited it there; ⋯ then shows only "On this device").
- Remove the settings strip entirely (including the read-only context label and anything `chat-pill-composer` kept for read-only) and the old top-bar buttons (🔍, ↺ Reset, ⊘, model select); keep ☆ in the top bar on desktop only.

### Control map (from the spec, the checklist for this task)

Every control today and its new home (some rows were done by earlier tasks; verify them all):

| Today | Where | New home |
| --- | --- | --- |
| ☰ (`=`) with the inbox dot | top bar | ☰, dot also on presence waiting-for-human |
| 🔍 Search the web (when configured, session open) | top bar | ⋯ menu "Search the web" |
| "Select a session…" / "Search the web below…" / "Not connected" | top bar | unchanged (no session open) |
| 📁 folder | top bar | subtitle |
| 🤖 model with working dot, model `<select>` | top bar | subtitle (model name) + state dot; ⋯ "Model" opens the list |
| ↺ Reset (assistant) | top bar | ⋯ menu (when viewing the assistant) |
| ☆ / ★ star | top bar | ⋯ menu; desktop also ☆ in the top bar |
| ⊘ Close / ↺ Reopen | top bar | ⋯ menu (not on read-only) |
| "Read-only" badge | top bar | subtitle |
| Hide Thinking | settings strip | ⋯ "On this device" (also still in Connection Settings) |
| Beep: Default / On / Off | settings strip | ⋯ "This chat", tri-state kept |
| Conversation: On / Off | settings strip | ⋯ "This chat" |
| 🧠 context label | settings strip | ring above the pill; text in ⋯ |
| Cancel queued (N) | settings strip | above the pill while steers are queued |
| Abort | settings strip | send button as ■ Stop while running; ■ Stop in the read-only stub |
| "Reconnecting and syncing…" / "Preparing the session agent…" | main column | kept |
| banner stack (interrupted, notice, folder conflict, error, retired, read-only) | main column | kept |
| Send / Steer / Search | composer | ➤ / ■ in the pill (Search label kept in search mode) |
| 📎 attach | composer | ＋ menu |
| 🎤 speech button | composer | in the pill |
| Speech settings (⚙), speech error | composer (speech button) | ⋯ "On this device" "Voice settings…"; error next to 🎤 |
| Press Enter to send | composer row | ⋯ "On this device" "Enter sends" (⋯ exists with no session too) |
| 💾 Save draft | composer row | ＋ menu |
| 🗂 Drafts (N) | composer row | ＋ menu, and a "Drafts (N)" link above the pill |
| Collapse ▽ / Expand ▲ | composer | removed (the pill grows) |
| "Shift+Enter to send" hint | composer row | the placeholder on desktop |
| search-mode Model select | composer | kept above the pill in search mode |
| disconnected / connecting banner | composer | kept |
| Copy, raw toggle | assistant message | message action row (hover on desktop, tap on touch) |
| Show full / collapse reply | assistant message | kept inline |
| Fork | user message | message action row |
| Queued marker; Not delivered: Retry / Discard | user message | kept under the bubble |
| versions (v / srv / pi) | sidebar | ⋯ menu text (also the sidebar's ▾) |

## Acceptance criteria

- [ ] Menu matches `phone.png` frame 4 (with the spec's split into This chat / On this device) and works as a popover on desktop.
- [ ] Every control in the control map above is reachable; checked by hand against the table and listed in the done record.
- [ ] The settings strip is gone; Beep keeps three states; Conversation mode semantics unchanged.
- [ ] Rename from ⋯ renames the open session and shows refusals.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- chat-top-bar: the top bar this extends (same part of `+page.svelte`).
- speech-settings-panel-store: the movable voice settings.
- session-row-rename: the shared rename prompt.
- folder-header-menu-and-close-all: the menu primitive.

## Prompt

> Goal: spec `work/specs/tasked/chat-compact-layout.md` stories 5, 8 to 11, 13, 14 (resolved decisions: Beep tri-state; no "Search in this chat", see `work/notes/ideas/search-in-this-chat.md`). Mockup: `phone.png` frame 4.
>
> Where to look: the top bar in `web/src/routes/+page.svelte` (after `chat-top-bar`), the settings strip at the bottom of `web/src/lib/components/ChatMessageList.svelte` (`updateConfig({hideThinking})`, `cycleBeep` / `beepOverride` / `setBeepSessionOverride`, `toggleConversationMode`, `contextLabel`), `enterToSend` in `web/src/lib/components/ChatInput.svelte` (localStorage `wherever-enter-to-send`; move it to a small shared store: the menu lives in `+page.svelte` and `enterToSend` is local state in `ChatInput`), `changeModel`, `setSessionStarred`, `closeSession` / `setSessionClosed`, `resetAssistant`, `startSearch`, the copy-link helper from `session-row-menu`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/chat-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/chat-session-menu-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

All are in `work/notes/observations/chat-session-menu-decisions.md`, along with the browser check for the done record. The ones you are most likely to want to change:
1. **Item order:** Search the web and Reset the assistant come after Close. The mockup has no place for them.
2. **Toggles are check boxes, not switches:** the shared menu already draws check boxes, so I used them instead of the mockup's switches. Beep shows its three states as text on the right.
3. **Model list and voice settings open inside the menu** rather than in a second popup.
4. **Read-only sessions also lose Rename and Beep:** this matches the sidebar row and the old strip. Conversation mode stays.
5. **No session open:** ⋯ shows only "On this device", with no context or versions line, and its label becomes "Settings on this device".
6. **Context and versions share one line:** it now includes the pi version, and the "v" is dropped for a dev build whose id isn't a version number.
7. **"Enter sends" is its own small store,** placed next to the speech settings store.
8. **☆ is desktop-only** in the top bar.
9. **Copy link's logic is copied** from the row menu rather than shared.
10. **The phone sheet has no header,** since the top bar right above it already shows the title.
