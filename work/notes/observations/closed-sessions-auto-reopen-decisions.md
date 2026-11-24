# closed-sessions-auto-reopen: decisions (2026-11-24)

Decisions taken while building task `closed-sessions-auto-reopen` (spec `closed-sessions`, ADR 0025). Code: `server/src/session-auto-reopen.ts`, wiring in `server/src/index.ts`, `closedAtOf()` in `server/src/session-closed.ts`.

## 1. Out of the trigger list, by design

- **A `!command` typed into a closed CLI session.** It emits only tool events (`tool_execution_*`), no `agent_start` or user `message_end`, so it does not reopen the session. Asserted in `closed-sessions-auto-reopen-server.test.ts`. Alternative considered: treat any tool event as activity; rejected because the task lists the triggers explicitly and a tool event alone does not mean anything waits on the user.
- **A transcript written while wherever cannot see it** (no bridge connected, server down). There is no event to observe. The session reopens on its next observed trigger, if any. Alternative: compare transcript mtime with `closedAt` at listing time; rejected as out of scope (a disk read per listed session, and it would reopen on any write, including ones the user made elsewhere on purpose).

## 2. `closedAtOf()` added to the store's in-memory cache

The inbox rule needs `closedAt`, and it runs on every shipmates change (presence updates included). Rather than `getClosedEntry()` (a disk read), the store's existing in-memory cache now also keeps a `sessionFile -> closedAt` map, refreshed with the set. Touches only `session-closed.ts`; same failure mode as `isSessionClosed` (never throws). The inbox rule also skips reading shipmates' snapshot entirely while nothing is closed.

## 3. A failed reopen leaves the session closed and retries on the next trigger

When `reopenSessions` throws (the store became unreadable under a loaded set), the error is logged and swallowed; the in-memory set still says closed, so each LATER trigger event (not every event) re-reads the disk to try again. Accepted: triggers are rare (turn starts, user messages, deliveries) and the state is already an error the next close reports to the user. Alternative: drop the session from the in-memory set anyway (it would show as open in the list while the file says closed, the two disagreeing until restart); rejected because the store must stay the one source of truth.

## 4. Throttled `sessions_updated`

"Every reopen broadcasts `sessions_updated`" goes through the existing leading + trailing throttle (`broadcastSessionsUpdated`, 2 s), like every other list change, so a reopen right after another list change arrives at the window edge. Alternative: an unthrottled emit for reopens; rejected as needless divergence.

## 5. Subscription placement and the inbox chaining

The agent-event listener is registered right after `sessionPool.onEvent = broadcastAgentEvent` (events before that point are not broadcast either). The inbox half runs in a `finally` after `shipmatesHost.wakeEvicted()` inside the existing `onShipmatesChange` option, so a throwing wake cannot skip it; `shipmates-service.ts` is untouched.

## 6. Test coverage of `agent_start` on a server session

On a server session a web send emits `agent_start` and the user `message_end` together, and a shipmates wake emits the custom message and `agent_start` together, so the end-to-end test cannot isolate `agent_start` there. It is isolated end to end on a CLI-bridged session (a forwarded `agent_start` alone reopens it) and per event in the in-process tests (`session-auto-reopen.test.ts`).
