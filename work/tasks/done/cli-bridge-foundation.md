---
title: CLI bridge foundation (isNew + capabilities on cli_register, agent_settled forwarding, cli_request/cli_response, assistant_info)
slug: cli-bridge-foundation
spec: assistant-session-and-channels
blockedBy: [pool-per-message-routing]
covers: [20]
---

## What to build

Extend the `@wherever-dev/pi` extension's existing WebSocket so a CLI-bridge session can take part in the assistant. `docs/adr/0016` is the design. This is the ONLY task that changes the bridge protocol; later tasks build on it.

- **`cli_register` gains `isNew` and `capabilities`.** `isNew` = the session context had no messages at `session_start` (`buildSessionContext().messages.length === 0`, the check pi's SDK uses; NOT an entry count, since pi writes `model_change` / `thinking_level_change` entries into every new session), sent true only on the FIRST `cli_register` after that `session_start`, so a reconnect (even of a still-empty session) never repeats it. `capabilities` lists at least `agent_settled` and `cli_request`.
- **Pointer from CLI.** A `cli_register` with `isNew: true` fires the pool's session-created callback (from `assistant-pointer-and-reset`), so a session started in a terminal in `assistantFolder` moves the pointer. An older extension without `isNew` moves nothing (expected; documented).
- **The extension forwards `agent_settled`** (today it only beeps on it).
- **`cli_request {id, op, args}` / `cli_response {id, ok, result | error}`** with correlation ids and a timeout. The server resolves the calling session from the bridge registration (origin stamped server-side). This task implements one op, `assistant_info` (returns `assistantFolder`, or "not configured"; `assistant-schedule-tools-server` adds the user's current timezone to it); an unknown op answers an error. Later tasks add the tool ops.
- **`assistant_info_changed {assistantFolder, timezone}`** server-to-extension push. The extension fetches `assistant_info` once after register and caches it, negative answers included ("unsupported" on timeout from an old server, "not configured"); the push updates the cache. Expose the cache inside the extension for the tool-twins task.

> FORWARD-POINTER (drive conductor, 2026-10-30): (1) when you record non-obvious decisions in a note, the done record must link it: end your final report with a `## Decisions` block (the runner copies that block verbatim into `work/tasks/done/<slug>.md`), written AS the done-record section itself, e.g. `The non-obvious in-scope decisions (...) are recorded in [work/notes/observations/<slug>-decisions.md](../../notes/observations/<slug>-decisions.md).` Do not address the reviewer in it. An unlinked note fails review. (2) Earlier tasks in this chain established conventions to build on: gate assistant behaviour on the `/config` `assistant.active` flag (configured AND lock held), not on `configured`; see the `## Decisions` links in `work/tasks/done/assistant-*.md`.

## Acceptance criteria

- [ ] A fresh `pi` in `assistantFolder` moves the pointer; `pi -c` on an existing session and any reconnect do not.
- [ ] `agent_settled` from a CLI session reaches the pool's event fan-out.
- [ ] `assistant_info` round-trips; disconnected bridge, disabled bridge and timeout each yield a clear, cached negative answer without blocking anything.
- [ ] `assistant_info_changed` updates the cache.
- [ ] An old server (drops unknown messages) and an old extension (no `isNew`, no `agent_settled`) keep working as before; a forwarded `agent_settled` produces no new WS frame, beep, `sessions_updated` or working-dot change.
- [ ] Request timeout timers are `unref`'d, so `pi -p` exit time is unchanged against an old server; with `assistantFolder` unset, `isNew` writes no pointer.
- [ ] Tests cover the new behaviour (mirror the repo's test style), with temp assistant/config/state dirs (the pointer is written to the state dir) and an assertion that the real ones are untouched.
- [ ] Changesets `"@wherever-dev/pi"` and `"wherever-dev"`; `CONTEXT.md` documents the new bridge messages.

## Blocked by

- pool-per-message-routing (provides the pool event fan-out `agent_settled` must reach; also serializes edits to the session pool and the server's WS handler; transitively after `assistant-pointer-and-reset`)

## Prompt

> Goal: give the wherever CLI bridge a request/response path and the registration details the assistant needs (spec `assistant-session-and-channels` in `work/specs/tasked/`). Read `docs/adr/0016` first.
>
> Where to look: the extension's WebSocket client, `cli_register` send and `session_start` handling, and its event forwarding (`agent_settled` only beeps today); on the server, the WS message switch (`cli_register`, `cli_event`; no default case and no register ack, which is why an old server is detected by timeout). Seams: the extension's request client (correlation, timeout, cache) with a fake socket; the server's `cli_request` handler; a real-bridge integration test if the repo has that harness.
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

The non-obvious in-scope decisions are recorded in [work/notes/observations/cli-bridge-foundation-decisions.md](../../notes/observations/cli-bridge-foundation-decisions.md), with JSDoc at the choice sites in `extension/src/bridge-requests.ts`, `server/src/cli-requests.ts` and `server/src/session-pool.ts`. They cover:
- the `assistant_info` result shape (null folder means not configured, gated on `assistant.active`);
- the extension cache's states, and keeping the last server answer across a disconnect;
- re-asking on every register;
- the 10 s unref'd timeout;
- consuming `isNew` only on a register that was actually sent;
- firing the session-created callback only for a file the pool had no entry for, and the retire that follows;
- the `registerCliSession` options object and `getCliCapabilities`;
- refusing unregistered `cli_request`s;
- `pushAssistantInfoChanged` having no caller yet;
- the changeset bumps.

Out-of-scope findings are in [work/notes/observations/cli-reconnect-close-race.md](../../notes/observations/cli-reconnect-close-race.md) and [work/notes/observations/assistant-folder-symlink-cwd-mismatch.md](../../notes/observations/assistant-folder-symlink-cwd-mismatch.md).
