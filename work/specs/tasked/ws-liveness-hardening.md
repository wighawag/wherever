---
title: WebSocket liveness hardening - no false teardown on thaw, a tolerant server reaper
slug: ws-liveness-hardening
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

> Tasked. The implementation and testing detail moved into the tasks in `work/tasks/` (`spec: ws-liveness-hardening`), and the durable rationale into `docs/adr/0011-websocket-liveness-probes-before-teardown-and-tolerates-a-missed-pong.md`.

## Problem Statement

Both ends of the relay WebSocket decide too eagerly that a healthy connection is dead, which turns an instant return to the app into a reconnect + resync, and lets a big upload kill the socket it travels on:

- **Client, on thaw.** The liveness watchdog compares raw `now - lastInboundAt` against `TURN_STALL_MS` (45 s) / `STALE_SOCKET_MS` (60 s), with no allowance for time the page spent frozen. When a backgrounded page thaws, timers fire before the inbound frames queued during the freeze are dispatched, so a healthy socket is torn down. The main trigger is the file picker / camera: that path deliberately skips the 8 s `suspend()`, so the socket stays up through the freeze.
- **Server reaper.** It pings every 30 s (`HEARTBEAT_MS`) and terminates a socket after ONE missed pong. Only a `pong` frame marks a socket alive: a client that is busily sending data (e.g. a large upload whose pong is queued behind it on the TCP stream) is reaped anyway.

## Solution

- The client never tears a socket down on silence alone. When the silence threshold is exceeded it first sends a ping and waits a short grace period, and only tears down if nothing arrives. A visibility return (or a detected freeze) triggers the same probe proactively. A genuinely dead socket is still torn down, only a few seconds later.
- The server reaper tolerates one missed pong (it reaps on the second consecutive miss) and treats ANY inbound frame as proof of life.

## User Stories

1. As a phone user returning to the app after the picker/camera or a short app switch, I don't want a healthy connection torn down and rebuilt, so that returning is instant.
2. As a phone user on a flaky link, I don't want the server to drop my socket after a single late pong.
3. As a user uploading a large file in CHUNKS (`resumable-chunked-uploads`), I don't want the server to reap the socket while my chunks are arriving. (A legacy single-frame upload proves nothing until the whole frame has arrived, because `ws` emits `message` only per complete frame. That path stays exposed until chunking lands; counting raw socket bytes was considered and rejected as unnecessary once uploads are chunked.)
4. As a user whose connection REALLY died (half-open TCP), I still want it detected and recovered, at most a few seconds later than today.
5. As a maintainer, I want the reaper interval injectable and covered by tests (today it is a hard-coded constant inside the server start closure, with no test).

### Autonomy notes

- `humanOnly` and `needsAnswers` are omitted. This is small, agent-taskable work.

## Out of Scope

- Keeping the socket alive while the app is in the background (not reliably possible on the mobile web; see `native-shell-capacitor-experiment`).
- The 8 s `suspend()` policy itself.
