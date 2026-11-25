---
title: Pill composer that grows, ■ Stop / ➤ steer, context ring, settings strip slimmed
slug: chat-pill-composer
spec: chat-compact-layout
blockedBy: [chat-message-layout]
covers: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
needsAnswers: false
---

## What to build

Re-lay out `ChatInput.svelte` as a one-line pill and move the run controls out of the settings strip:

- The pill: ＋, the textarea, 🎤 (the existing `SpeechButton`), and the send button. The textarea auto-grows with its content up to about 40% of the viewport height, then scrolls. Remove Expand / Collapse (`isCollapsed`) and the "Shift+Enter to send" hint (the desktop placeholder says what Enter does).
- ＋ opens a small menu: Attach file (today's 📎, same conditions), Save as draft (today's 💾, same disabled rules), Drafts (opens today's drafts panel). "Drafts (N)" also shows as a small link above the pill when there are drafts. Keep "Enter sends" reachable inside the ＋ menu FOR NOW (the session-menu task moves it to ⋯).
- Send button states (a pure helper decides; ■ Stop follows only `streaming`, like today's Abort `disabled={!streaming}`, not the `canSend` rule): idle with no text = disabled ➤; text = ➤ send; agent running with empty text = ■ Stop (calls the existing `abort`); agent running with text = ➤ steer (today's Steer) with ■ Stop beside it; search mode = today's Search label.
- Above the pill: a small context ring with the percentage, visible in EVERY state (idle, typing, keyboard up, pill grown to its cap, agent running; above or inside the pill; `phone.png` frame 3 wrongly drops it, spec story 21 wins) (tooltip: tokens of window, today's `contextLabel` source), "Drafts (N)", and "Cancel queued (N)" while steers are queued (today's `cancelSteer`).
- Remove from the settings strip: the context label, Cancel queued and Abort (now above / in the pill), EXCEPT on a read-only session (`$isReadOnly`): `ChatInput` is not mounted there (the read-only stub is), so the strip keeps Abort and the context label for read-only sessions until `chat-top-bar` (Stop) and `chat-session-menu` (context) take them.
- Do NOT add the mockup's "working 1m 12s" timer (out of scope: no run start time on the client). Hide thinking, Beep and Conversation stay in the strip until `chat-session-menu`.
- Nothing regresses: attachments and upload chips (progress, pause, retry, cancel), queued steers, drafts (replace / append / cancel, offline list), voice and conversation mode (hands-free), the "/" skill menu, the disconnected banner, the search mode of the empty state (its model picker stays above the pill).
- Phone keyboard: there is no `visualViewport` handling today (the layout is `fixed inset-0`); do not make it worse; the pill must stay above the keyboard as today, with the list scrolled to the latest message.

## Acceptance criteria

- [ ] The send-button state helper and the context-ring helper are unit-tested.
- [ ] Composer matches `phone.png` frames 2 and 3 and `desktop.png`; auto-grow caps at about 40% and scrolls.
- [ ] Every composer feature listed works (checked by hand, listed in the done record), including uploads, drafts, voice, skill menu, search mode, Stop and steer while running, Cancel queued.
- [ ] The context ring and percentage stay visible in every composer state, including with the phone keyboard up and the pill grown to its cap (checked by hand at a phone width with a tall message; listed in the done record).
- [ ] The settings strip no longer holds context, Cancel queued or Abort.
- [ ] Web checks (`svelte-check`, lint) and all tests pass; changeset added; `CONTEXT.md` updated where it describes the changed behaviour.

## Blocked by

- chat-message-layout: edits `ChatMessageList.svelte` (and the composer width) just before; serialised.

## Prompt

> Goal: spec `work/specs/tasked/chat-compact-layout.md` stories 15 to 24 (story 19's read-only Stop is done in `chat-top-bar`; resolved decision 1 sets the Stop / steer rule). Mockups: `phone.png` frames 2 and 3, `desktop.png`; today: `current-chat-composer.png`, `current-chat-keyboard.png`.
>
> Where to look (large files: grep, then read bounded ranges): `web/src/lib/components/ChatInput.svelte` (`isCollapsed`, `enterToSend` / `toggleEnterToSend`, `saveCurrentAsDraft`, `toggleDrafts`, `draftsOpen`, `showAttach`, `handleFileChange`, `canSend`, `streaming`, `searchMode`, `submitLabel`, the skill menu, attachments and upload chips), `web/src/lib/components/ChatMessageList.svelte` (the bottom settings strip: `contextLabel`, `cancelSteer`, `abort`, `$pendingSteering`), `abort` in `web/src/lib/wherever.ts`, `web/src/lib/core/compose-send.ts`, `drafts.ts`, `upload-chip.ts`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/chat-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/chat-pill-composer-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

Recorded in `work/notes/observations/chat-pill-composer-decisions.md`:
1. An attachment counts as content, so a running pill holding only a file shows ➤ steer with ■ Stop beside it.
2. ■ Stop is never blocked by the send rules, and Enter can never stop the agent.
3. The phone placeholder while running is "Steer the agent..." so the empty pill stays one line; desktop keeps the longer wording plus the Enter hint.
4. The ring reads "33% of 1.0M" (the desktop mockup's wording, also on the phone). It turns amber from 70% and red from 90%, and sits in its own row above the pill.
5. "Cancel queued (N)" always shows the count, even for one steer.
6. The "Draft saved" confirmation moved to the row above the pill, since the menu closes on tap.
7. The ＋ menu always opens, so the offline drafts list stays reachable.
8. The mic keeps its ⚙ (now smaller) until the session-menu task.
9. The scroll fix in `ChatMessageList` described above.
10. No new glossary terms: "steer" keeps its existing meaning, and "Stop" is the label for the existing `abort()`.

## Decisions (continued run, 2026-11-25)

- The task's build decisions (all from the earlier attempt) are in `work/notes/observations/chat-pill-composer-decisions.md` and linked from the done record. I made no new ones.
- The server flake is recorded in `work/notes/observations/server-suite-flakes-under-host-load.md`.
