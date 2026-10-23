---
title: Client liveness watchdog probes before tearing a socket down, and on every return to the page
slug: client-liveness-probes-before-teardown
spec: ws-liveness-hardening
blockedBy: []
covers: [1, 4]
---

## What to build

The client never tears down a WebSocket on silence alone, so returning to the app after the file picker, camera or a short app switch keeps the live connection instead of reconnecting and resyncing.

- When the liveness watchdog sees `silentFor` above its threshold (`TURN_STALL_MS` mid-turn / `STALE_SOCKET_MS` idle), it sends a ping and re-checks after a grace period (~5 s), tearing down only if NO inbound frame arrived meanwhile. This alone covers a thaw: timers fire before the frames queued during the freeze are dispatched.
- New `client.noteVisible()` is a no-op unless the current socket is OPEN and the watchdog is running (a probe on a CONNECTING socket would be dropped by `ping()`, and the grace check would then tear down a socket that is still handshaking). Otherwise it starts the same probe immediately (and resets the stale clock baseline so frozen time is not counted as silence). `+page.svelte` calls it (through a `noteVisible()` wrapper in `web/src/lib/wherever.ts`, next to `suspend`/`resume`) on EVERY `visibilitychange: visible` and every `pageshow`, BEFORE the existing `!connected` branch. A pending probe is cancelled when the socket changes.
- A wall-clock jump of more than 2× the tick interval between watchdog ticks is an additional proactive trigger, never the gate.
- A truly dead socket is still torn down and reconnected, about one grace period later than today.

## Acceptance criteria

- [ ] Past the threshold, the watchdog pings and does NOT tear down if any frame arrives within the grace period.
- [ ] Past the threshold with no frame during the grace period, the socket is torn down and a reconnect is scheduled (existing behaviour preserved).
- [ ] `noteVisible()` triggers an immediate probe; `+page.svelte` calls it on every visible / pageshow event.
- [ ] Client tests (vitest + `client/test/harness.ts`, fake timers) cover: thaw-like jump then `noteVisible()` with a reply → no teardown; no reply → teardown; ordinary idle stale socket → still detected; `noteVisible()` on a CONNECTING socket does nothing.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: change the liveness watchdog in `@wherever-dev/client` (`client/src/client.ts`: `startLivenessWatchdog` / `checkLiveness`, constants `HEARTBEAT_MS`, `STALE_SOCKET_MS`, `TURN_STALL_MS`) from "silent past threshold → teardown" to "silent past threshold → probe → teardown only if still silent after a grace period". The client package has no `document` access, so add a public `noteVisible()` and call it from `web/src/routes/+page.svelte`'s `handleVisibility` (visible branch, unconditionally) and `handlePageShow`. Rationale: ADR 0011; user stories: `work/specs/tasked/ws-liveness-hardening.md`.
>
> Be careful with the existing teardown path: it nulls `this.ws` before `terminate()` and calls `uploadsLostSocket()` (pending WS uploads must keep that). Keep the mid-turn "Connection to relay stalled" sessionError behaviour for a real teardown.
>
> Tests: extend the existing client test style (`client/test/*.test.ts`, the fake socket in `harness.ts`, `vi.useFakeTimers()`). Done = probe-before-teardown and `noteVisible()` are tested; existing tests stay green.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim client-liveness-probes-before-teardown --arbiter origin
git fetch origin && git switch -c work/client-liveness-probes-before-teardown origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/client-liveness-probes-before-teardown.md work/tasks/done/client-liveness-probes-before-teardown.md
```
