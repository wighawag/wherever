---
title: Chat messages: full-width assistant text, compact user bubbles, one-line tool chips, 760px column
slug: chat-message-layout
spec: chat-compact-layout
blockedBy: []
covers: [25, 26, 27, 28, 29, 30, 31]
---

## What to build

Rendering-only change in `ChatMessageList.svelte` (and the composer's outer width in `ChatInput.svelte`):

- Assistant messages: full width, no bubble chrome, no wasted right margin.
- User messages: compact right-aligned bubbles.
- Generic tool cards (already collapsed by default with a one-line header and an expand toggle) restyle into a one-line chip: status, tool name, short args (`smartTitleArgs`), duration; tap expands today's arguments and output. Keep: the ⬇️ download link and the inline image / audio / video previews (rendered outside the collapsed part), the `!command` auto-expand (`shouldAutoExpand`), the `hideTools` rendering. First-class tools (`isFirstClassTool`: `attach_file`, `say`) keep their cards.
- Per-message actions stay reachable: assistant Copy and raw / rendered toggle in an action row under the message, visible on hover / focus on desktop and on tap on touch (never only by long-press); the conversation-mode "show full / collapse" reply buttons stay inline; on user messages Fork stays (in the action row or beside the bubble), the "Sending" indicator, the "Queued" marker, "Not delivered: Retry / Discard", the skill-invocation chip and the attachment list stay; the shipmates card message stays.
- Desktop: messages in a centered column of about 760px; the composer aligned to the same column. Implement the width inside `ChatMessageList` and `ChatInput`, NOT in `+page.svelte` (the sidebar tasks edit that file).
- Thinking blocks, working indicators, "load more history" and timestamps unchanged.

## Acceptance criteria

- [ ] Message layout (not the composer) matches `phone.png` frames 2 and 3 and `desktop.png`.
- [ ] Every per-message action listed is reachable on desktop (hover / focus) and touch (tap); checked by hand and listed in the done record.
- [ ] Tool chips keep download links, inline media, `!command` auto-expand and `hideTools` behaviour.
- [ ] Any pure helper changed in `chat-message-helpers.ts` keeps or gains tests.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

None, can start immediately.

## Prompt

> Goal: spec `work/specs/tasked/chat-compact-layout.md` stories 25 to 31. Mockups: `docs/design/sidebar-and-chat-redesign/phone.png` frames 2 and 3, `desktop.png`; today: `current-chat-*.png`.
>
> Where to look (large files: grep, then read bounded ranges): `web/src/lib/components/ChatMessageList.svelte` (the `{#each}` over messages: `msg.role` branches for thinking, tool, user, assistant; `isExpanded` / `shouldAutoExpand`; `copiedMessageId`, `toggleRaw`; `replyCollapsed`; the fork button; `delivery` sending / failed; `$pendingSteering`), `web/src/lib/components/chat-message-helpers.ts` (`isFirstClassTool`, `shouldAutoExpand`, `toolDuration`). Do NOT touch the settings strip at the bottom of `ChatMessageList` (the composer task does).
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/chat-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/chat-message-layout-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.
