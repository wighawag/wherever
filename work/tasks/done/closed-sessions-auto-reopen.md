---
title: A closed session reopens itself on new activity or a new inbox item
slug: closed-sessions-auto-reopen
spec: closed-sessions
blockedBy: [closed-sessions-store-and-endpoint]
covers: [12, 13]
---

## What to build

Nothing that needs the user may hide behind "closed". The server clears a session's close flag when it observes activity for it:

- **Agent events, one hook:** subscribe through `sessionPool.subscribeEvents`, which sees every agent event from server AND CLI-bridged sessions and already isolates a throwing listener (`onEvent` / `broadcastAgentEvent` is called without a try/catch from pi's subscribe callback, so a failing reopen write there would escape into event routing). Reopen on `agent_start`, on a user `message_end` (any channel: web, Telegram, CLI), and on a shipmates delivery (custom message / entry with `customType: 'shipmates'`). Check membership against the store's in-memory set; never read the disk per event.
- **Inbox, stateless rule:** on every shipmates change, reopen any closed session that has an open inbox item with `createdAt > closedAt`. Hook by chaining onto the existing `onShipmatesChange` option where `index.ts` constructs `ShipmatesService` (it currently calls the host's `wakeEvicted()`), reading open items from the service's snapshot inbox (its `sessionFile` is already normalized). Do NOT edit `server/src/shipmates-service.ts` (another task edits it in parallel) and do not reuse `checkNotifications` (it returns early without a notifier). Stateless, so it holds across restarts and still lets a session be closed while an older item is open.
- **Every reopen broadcasts `sessions_updated`** (an `agent_start` alone only sends `session_working`, so the session would otherwise stay hidden until `agent_end`). Reopening also drops any `batch` membership for that session.

## Acceptance criteria

- [ ] On a server session driven by the fake LLM: a closed session reopens on a web user message, on `agent_start`, and on a shipmates delivery (tests).
- [ ] A CLI-bridged session reopens on its forwarded `agent_start` (test, or a documented reason if the existing harness cannot drive it).
- [ ] A closed session with an open inbox item created after `closedAt` reopens on the next shipmates change; one created before does not (test).
- [ ] Each reopen broadcasts `sessions_updated` (test).
- [ ] A reopen write that throws is caught and logged, never breaks event routing (test).
- [ ] Tests that inject shipmates' clock (`shipmatesNow`) keep `closedAt` on the same clock, so `createdAt > closedAt` is meaningful.
- [ ] No disk read per agent event (assert via the store's in-memory path, or a counting stub).
- [ ] Tests isolate `WHEREVER_STATE_DIR` and `SHIPMATES_STATE_DIR` in temp dirs and leave the real ones untouched.
- [ ] `CONTEXT.md` "Closed sessions" documents the triggers; changeset (`"wherever-dev": minor`).

## Blocked by

- closed-sessions-store-and-endpoint (the store and its in-memory set).

## Prompt

> Goal: as above. The decisions are in this task body and ADR 0025; the trigger list is Resolved decision 2 in `work/specs/tasked/closed-sessions.md`. Out of the trigger list, by design: a `!command` typed into a closed session (it emits only tool events), and a transcript written while wherever cannot see it (no bridge, server down). Note both in the decisions file and in CONTEXT.md.
>
> Where to look: `broadcastAgentEvent` and `sessionPool.onEvent` wiring in `server/src/index.ts`; where server events and `handleCliEvent` emit in `server/src/session-pool.ts`; how shipmates deliveries are recognised (`SHIPMATES_CUSTOM_TYPE`); `ShipmatesService.onChange` and its inbox snapshot in `server/src/shipmates-service.ts` (`AttentionItem.createdAt`). Prior art for end-to-end tests: `server/test/shipmates-inbox-server.test.ts`, `server/test/shipmates-telegram-server.test.ts`.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED). If a hook point moved or a trigger cannot be observed, route to needs-attention with the discrepancy.
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/closed-sessions-auto-reopen-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.

## Decisions

Recorded in `work/notes/observations/closed-sessions-auto-reopen-decisions.md`:
1. The two non-triggers above, and why.
2. `closedAtOf()` added to the in-memory cache, and the inbox rule skipped entirely while nothing is closed.
3. A failed reopen leaves the session closed and retries on its next trigger.
4. `sessions_updated` goes through the existing 2-second throttle, like every other list change.
5. Where the listener is registered, and the inbox check runs in a `finally` after `wakeEvicted()` so a failing wake can't skip it.
6. Why `agent_start` is tested on its own only via the CLI bridge and in-process.
