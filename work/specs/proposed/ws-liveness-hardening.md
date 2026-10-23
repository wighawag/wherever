---
title: WebSocket liveness hardening - no false teardown on thaw, a tolerant server reaper
slug: ws-liveness-hardening
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

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

## Implementation Decisions

> Seed for tasking; trimmed once tasked.

- **Probe before teardown (the core change):** whenever `silentFor` exceeds the threshold (`TURN_STALL_MS` / `STALE_SOCKET_MS`), the watchdog sends a ping and re-checks after a grace period (~5 s), tearing down only if no inbound frame arrived meanwhile. This alone covers a thaw: with 25 s ticks and a 45 s mid-turn threshold, a freeze-induced gap of 45-50 s is NOT a ">2× interval" jump, so a jump-only trigger would still kill a healthy socket.
- **Client seam:** the client package has no `document` access. Add `client.noteVisible()`. `+page.svelte` calls it on EVERY `visibilitychange: visible` and `pageshow`, not only in today's `!connected` branch. It starts the same probe immediately, so a dead socket is detected right away rather than at the next tick. A wall-clock jump of more than 2× the tick interval is an additional proactive trigger, not the gate.
- **Server:** let the reaper count consecutive misses per socket (reap at 2). Any `message` event (text or binary) marks the socket alive, as `pong` does. The interval is a constant inside `main()` today, and server tests run the server as a child process configured by env (`server/test/*.test.ts`). So read it from `WHEREVER_HEARTBEAT_MS`, defaulting to 30 000.
- **Phantom-viewer window:** N=2 widens the window in which a vanished viewer still counts as present to about 3× `HEARTBEAT_MS`. Same-tab reconnects are already covered by `clientKey` eviction (`evictPreviousConnection`); a different device is a real second viewer anyway. Document this in the reaper comment.

## Testing Decisions

> Seed for tasking; trimmed once tasked.

- Client (vitest + `client/test/harness.ts`):
  - a fake-timer jump past the threshold followed by `noteVisible()` sends a ping and does NOT tear down;
  - with no inbound frame within the grace period, it tears down and reconnects;
  - a normal idle stale socket is still detected.
- Server (child-process harness, `WHEREVER_HEARTBEAT_MS` small; the "no pongs" client is a `ws` client created with `autoPong: false`):
  - one missed pong is tolerated and two consecutive are reaped;
  - inbound data frames keep a socket alive with no pongs.

## Out of Scope

- Keeping the socket alive while the app is in the background (not reliably possible on the mobile web; see `native-shell-capacitor-experiment`).
- The 8 s `suspend()` policy itself.

## Further Notes

- Prerequisite for `resumable-chunked-uploads` (heartbeat starvation during uploads) and `instant-resume-from-cached-conversation` (thaw behaviour). Both declare `taskedAfter` on this spec.
