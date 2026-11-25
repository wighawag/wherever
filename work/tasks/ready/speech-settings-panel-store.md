---
title: Extract the speech settings panel behind a shared store
slug: speech-settings-panel-store
spec: chat-compact-layout
blockedBy: [chat-pill-composer]
covers: [12]
---

## What to build

Today `engine` and `locale` are local state in `SpeechButton.svelte`, read from localStorage only on mount, and the speech error shows only inside its ⚙ popover. Make the voice settings movable:

- A shared store for the speech settings (engine, locale; Direct send already maps to the conversation-mode `autoSendOnSpeechEnd` knob, keep that mapping), persisted as today (same localStorage keys, so existing users keep their choices).
- Extract the Speech Settings panel into its own component that reads and writes the store; `SpeechButton` reads the store, so a change anywhere takes effect at once.
- Show the speech error next to 🎤 in the pill (a small tooltip or line), not only inside the panel.
- Until `chat-session-menu` mounts the panel in ⋯, the existing ⚙ on the speech button keeps opening it.

## Acceptance criteria

- [ ] Changing a setting in the extracted panel takes effect in the 🎤 button without a reload; existing stored settings are read.
- [ ] The store (persistence, defaults) is unit-tested.
- [ ] The speech error is visible from the pill.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- chat-pill-composer: re-lays out the pill that holds the speech button; serialised.

## Prompt

> Goal: spec `work/specs/tasked/chat-compact-layout.md` story 12 (the move into ⋯ happens in `chat-session-menu`).
>
> Where to look: `web/src/lib/components/speech/SpeechButton.svelte` (its `engine`, `locale`, `directSend`, `speechError` state, the `onMount` localStorage read, the ⚙ "Speech Settings" popover), `web/src/lib/core/conversation-mode.ts` / `hands-free.ts` (the `autoSendOnSpeechEnd` knob).
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/chat-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/speech-settings-panel-store-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.
