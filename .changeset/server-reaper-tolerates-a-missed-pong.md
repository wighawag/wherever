---
"wherever-dev": patch
---

The server's WebSocket heartbeat reaper no longer drops a healthy connection after a single late pong: it terminates a socket only after two consecutive unanswered pings, and any inbound message now counts as proof of life just like a pong, so a client busily sending data (e.g. upload chunks) is never reaped. A genuinely dead (half-open) socket is still reaped, at most one interval later. The interval is configurable with `WHEREVER_HEARTBEAT_MS` (default 30000; an invalid value is ignored with a warning).
