---
title: Telegram conversation (messages in, routed streamed replies out, steer marker, /new /reset, stop, notifications)
slug: telegram-conversation
spec: assistant-session-and-channels
blockedBy: [telegram-token-and-pairing]
covers: [2, 4, 11, 15, 16, 18]
---

## What to build

Talk to the assistant from Telegram, end to end, over the paired channel.

- **Inbound.** A paired user's text goes to the controller with origin `telegram`. If the assistant session is idle it starts a turn; if mid-turn it STEERS (as the web composer does, ADR 0003), and Telegram shows that with a reaction on the user's message (`setMessageReaction`), falling back to a short "added to the current reply" note.
- **Refusals and commands.** Text starting with `!` or `!!` is refused with a short explanation and never reaches the pool's shell path. `/new` and `/reset` trigger the controller's reset (never sent to pi). `stop` / `/stop` aborts the running turn. Other `/` text (including `/skill:`) is passed through untouched; the origin rides the routing queue, never a text prefix.
- **Replies.** Assistant output whose current destination is `telegram` (`pool-per-message-routing`) is delivered: streamed with `sendMessageDraft`, falling back to `sendMessage` + `editMessageText`; split below Telegram's 4096-character limit. Output from web, terminal or scheduled messages is never sent to Telegram.
- **Notifications.** `assistant_notify` arrives as its OWN message prefixed `🔔 <source>: <title>` (body below, plus a link to the target session when the wherever public URL is configured), sent immediately even mid-exchange and never folded into a reply.
- **Dropped messages.** Messages dropped by a reset or an aborted settle are reported back on Telegram.

> FORWARD-POINTER (drive conductor, 2026-10-30): (1) when you record non-obvious decisions in a note, the done record must link it: end your final report with a `## Decisions` block (the runner copies that block verbatim into `work/tasks/done/<slug>.md`), written AS the done-record section itself, e.g. `The non-obvious in-scope decisions (...) are recorded in [work/notes/observations/<slug>-decisions.md](../../notes/observations/<slug>-decisions.md).` Do not address the reviewer in it. An unlinked note fails review. (2) Earlier tasks in this chain established conventions to build on (see the `## Decisions` links in `work/tasks/done/`): the assistant status has an `active` flag (configured AND this server holds the folder lock); anything that RUNS or WRITES assistant state (scheduler, channels, polling, keys, pointer) gates on `active`. Where THIS task says a tool is registered when `assistantFolder` is configured, keep that and make the tool return a clear lock-state error when not active. This task's own text and acceptance criteria always win over this note.

## Acceptance criteria

- [ ] A Telegram question gets its streamed answer on Telegram; a long answer is split under 4096 characters.
- [ ] A message sent mid-turn steers and shows the steer marker; output after the steer goes to Telegram.
- [ ] A scheduled or web-started turn sends nothing to Telegram; `assistant_notify` mid-exchange arrives immediately as a separate `🔔` message.
- [ ] `!` / `!!` refused; `/new` / `/reset` reset; `stop` aborts; `/skill:` still expands.
- [ ] Dropped queued messages are reported on Telegram; after a `stop` with a Telegram steer queued, the next Telegram message still routes its reply to Telegram.
- [ ] Tests cover the new behaviour with the Bot API mocked at the HTTP boundary and temp dirs.
- [ ] A changeset (`"wherever-dev"`); `CONTEXT.md` documents the Telegram behaviour.

## Blocked by

- telegram-token-and-pairing (which itself depends on the routing and channel tasks)

## Prompt

> Goal: a working Telegram conversation with the wherever assistant (spec `assistant-session-and-channels` in `work/specs/tasked/`). Read `docs/adr/0014` (routing per user message; only `assistant_notify` notifies) and ADR 0003 (steer on submit).
>
> Where to look: the Telegram adapter skeleton (`telegram-token-and-pairing`), the channel interface and `assistant_notify` (`channel-seam-notify-and-web-push`), the pool's routing destination and event fan-out (`pool-per-message-routing`), the controller's `send` and reset. Port streaming, splitting and `stop` from the MIT `badlogic/pi-telegram` `index.ts`. Seams: inbound handling (start vs steer, refusals, commands) against a controller fake; reply delivery from a recorded event stream; the Bot API mocked at HTTP.
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```
