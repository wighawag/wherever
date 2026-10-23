---
title: Server heartbeat reaper tolerates one missed pong and counts any inbound frame as alive
slug: server-reaper-tolerates-a-missed-pong
spec: ws-liveness-hardening
blockedBy: []
covers: [2, 3, 4, 5]
needsAnswers: true
---

## What to build

The relay server's WebSocket heartbeat reaper stops killing healthy sockets on mobile links. Today it pings every 30 s and terminates a socket after ONE missed pong, and only a `pong` frame marks a socket alive. After this task:

- the reaper counts consecutive missed pongs per socket and terminates only on the SECOND consecutive miss;
- any inbound `message` (text or binary) marks the socket alive, exactly as a `pong` does, so a client busily sending data (e.g. chunked upload frames) is never reaped;
- the interval is read from `WHEREVER_HEARTBEAT_MS` (default 30 000) so tests can shorten it;
- a genuinely dead (half-open) socket is still reaped, at most one extra interval later.

The reaper comment, AND the `clientKey` block's comment that says a phantom lingers "up to 2x HEARTBEAT_MS", document the widened phantom-viewer window (about 3× the interval) and why same-tab reconnects are still covered by `clientKey` eviction (`evictPreviousConnection`).

## Acceptance criteria

- [ ] One missed pong is tolerated; two consecutive misses terminate the socket (and the existing close teardown runs).
- [ ] A socket that keeps sending messages but never pongs is NOT reaped.
- [ ] `WHEREVER_HEARTBEAT_MS` overrides the interval; unset keeps 30 000.
- [ ] Server tests (child-process harness like the existing `server/test/*.test.ts`) cover all three, using a `ws` client created with `autoPong: false` for the no-pong cases.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: harden the server-side WebSocket liveness reaper in `server/src/index.ts` (the heartbeat block next to the `WebSocketServer` setup, where a `liveSockets` WeakSet and a hard-coded `HEARTBEAT_MS = 30_000` live inside the server start function). The why is in ADR 0011 (`docs/adr/0011-*.md`) and `work/specs/tasked/ws-liveness-hardening.md`.
>
> Replace the single-miss WeakSet with a per-socket miss counter (reset to 0 on `pong` AND on any `message` event), reap when it reaches 2. Read the interval from `process.env.WHEREVER_HEARTBEAT_MS` with a 30 000 default (validate it is a positive integer). Keep the existing reap log line.
>
> Tests: the server tests spawn the server as a child process configured by env (see the existing `server/test/*.test.ts` harness). Start it with a small `WHEREVER_HEARTBEAT_MS` (e.g. 200), open a raw `ws` socket yourself with `new WebSocket(url, { autoPong: false })` (ws ^8.18; the harness's `TestClient` cannot pass that option) so the client does not answer pings, and assert: one interval of silence keeps the socket open, two consecutive intervals close it, and a client that sends a JSON `ping` message every interval while never ponging stays open.
>
> Done = the three behaviours are tested and green, and the comment explains N=2 and the phantom-viewer trade-off.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim server-reaper-tolerates-a-missed-pong --arbiter origin
git fetch origin && git switch -c work/server-reaper-tolerates-a-missed-pong origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/server-reaper-tolerates-a-missed-pong.md work/tasks/done/server-reaper-tolerates-a-missed-pong.md
```
