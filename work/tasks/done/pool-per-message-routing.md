---
title: Per-user-message reply routing in the session pool (origin queues, preflightResult, settle trim)
slug: pool-per-message-routing
spec: assistant-session-and-channels
blockedBy: [assistant-pointer-and-reset]
covers: [10]
---

## What to build

The session pool learns WHERE each user message came from and exposes, for any assistant output, the origin of the user message it answers. This is the routing core channels build on, testable with dummy origins before any channel exists. `docs/adr/0014` is the design; follow it exactly.

- **Recording.** The controller's `send(text, origin)` (from `assistant-pointer-and-reset`) threads its origin into the pool send. Sends accept an optional origin (`telegram`, `schedule:<jobId>`, ...; web sends record `none`). The pool records an origin only for sends that WILL produce a user message, keyed by session file (a CLI takeover keeps them), in one queue per delivery mode (prompt-or-steer, and followUp).
- **No drift.** Nothing is recorded, or the entry is dropped, for `!`/`!!` shell sends, sends to a non-resident session, `prompt()` reporting `preflightResult` `"handled"`, and sends that throw. To observe `preflightResult` on every send: `/`-prefixed text KEEPS its current `prompt()` call (`expandPromptTemplates: true`, `source: 'interactive'`, which is what makes `/skill:` and prompt templates expand) with only `preflightResult` added; plain text (including steers) moves from `agentSession.sendUserMessage` to `prompt(text, {expandPromptTemplates: false, streamingBehavior, source: 'extension', preflightResult})`, equivalent to today's plain-text path. A `prompt()` that returns without calling `preflightResult` was deferred and stays pending.
- **Trigger.** A user `message_end` (forwarded for both server and CLI-bridge sessions; `message_start` is not forwarded by the extension) takes the head of the matching queue; that origin is the session's current destination until the next user message. Match by position, never by text. A message typed directly in a CLI terminal has no send of its own: with an empty queue it gets no origin; otherwise it takes the head entry, a misattribution corrected at the next settle (ADR 0014).
- **Settle trim.** `cancelSteerQueue` / `clearQueue` clears both routing queues. At `agent_settled` each queue is trimmed to pi's current queue length, keeping the newest (server sessions: `getSteeringMessages()` / `getFollowUpMessages()`; abort leaves pi's queues populated); CLI sessions' routing queues are emptied. The pool does this BEFORE fanning `agent_settled` out.
- **Fan-out.** `pool.onEvent` is a single slot; add a fan-out so the assistant controller subscribes beside the WS broadcaster, with the current destination available for each assistant event. `pool.onEvent` stays assignable exactly as today (existing tests assign it directly); the WS broadcaster runs FIRST, with the same frames in the same order, and before the pool's own idle bookkeeping as today; a throwing extra subscriber is caught and never suppresses the broadcaster or the bookkeeping.
- **Invisible when unused.** Routing state is always-on internal bookkeeping with no observable output; with `assistantFolder` unset (or for any non-assistant session) nothing a user, client or the model sees changes.

> FORWARD-POINTER (drive conductor, 2026-10-30): (1) when you record non-obvious decisions in a note, ALSO append a `## Decisions` section to the done record (`work/tasks/done/<slug>.md`) that links that note; an unlinked note fails review. (2) Earlier tasks in this chain established conventions to build on: gate assistant behaviour on the `/config` `assistant.active` flag (configured AND lock held), not on `configured`; see the `## Decisions` links in `work/tasks/done/assistant-*.md`.

## Acceptance criteria

- [ ] Two interleaved dummy origins (prompt, steer, followUp) each get their own replies attributed.
- [ ] In a SERVER session, a web `!cmd` or an extension-handled `/command` followed by a tagged message still attributes that message's reply to it (no drift).
- [ ] A web message sent between a tagged message and its reply does not take its slot.
- [ ] After an abort with a steer still queued, the settle trim keeps that entry aligned with pi's queue.
- [ ] Routing works for a CLI-bridge session (via `message_end`), with routing queues emptied at settle.
- [ ] Web send behaviour (steer by default, ADR 0003) is unchanged, and `/skill:` still expands on web sends (add a test; none guards it today).
- [ ] Fan-out: broadcaster first with identical frames and order; a throwing subscriber is isolated; `pool.onEvent =` still works.
- [ ] With `assistantFolder` unset, the full existing server test suite passes unchanged, and `cancelSteerQueue` stays a no-op for CLI sessions.
- [ ] Tests cover the new behaviour (mirror the repo's test style).
- [ ] A changeset (`"wherever-dev"`); `CONTEXT.md` documents the routing state.

## Blocked by

- assistant-pointer-and-reset (both edit the session pool; serialized to avoid conflicts)

## Prompt

> Goal: per-user-message routing in the wherever session pool, so the assistant (spec `assistant-session-and-channels` in `work/specs/tasked/`) replies only to the channel a question came from and scheduled output stays silent. Read `docs/adr/0014` first.
>
> Where to look: the pool's `sendUserMessage` (`!` branch, `/`-prefixed `prompt()` path, plain-text `agentSession.sendUserMessage` path, CLI `cli_message` relay), `cancelSteerQueue`, the server-session event subscription feeding `onEvent`, the CLI event path, and in the installed pi SDK (read specific files, bounded) `AgentSession.prompt()`'s `preflightResult`, `getSteeringMessages()` / `getFollowUpMessages()`, `clearQueue()`. Seams: a pure routing-queue module unit-tested alone, then the pool with the fake LLM server (ADR 0001).
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```

## Decisions

The non-obvious in-scope decisions taken while building this task (entry states and the started-to-front rule refining ADR 0014's head-take, which queue a user `message_end` takes from, deferred prompts, settle trim keeping in-flight sends, what the clears drop, the `subscribeEvents` fan-out API and order, origin as a 5th positional parameter, CLI settle relying on the forwarded `agent_settled`, routing-state lifetime, changeset bump) are recorded in [work/notes/observations/pool-per-message-routing-decisions.md](../../notes/observations/pool-per-message-routing-decisions.md), with JSDoc at the choice sites in `server/src/reply-routing.ts` and `server/src/session-pool.ts`. Left to later tasks: `clearQueuedMessages` does not yet return the dropped origins (`channel-seam-notify-and-web-push`); the CLI `agent_end` fallback for old extensions (`assistant-scheduler`).
