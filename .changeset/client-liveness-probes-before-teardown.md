---
"wherever-dev": patch
"@wherever-dev/client": patch
---

Returning to the app after the file picker, the camera or a short app switch no longer tears down a healthy connection and resyncs the session. The client's liveness watchdog now treats a silent socket as suspect, not dead: it sends a ping and waits a 5 s grace period, and only reconnects if nothing at all arrives. The page also probes the socket on every return to visibility (`client.noteVisible()`), and a detected freeze (a wall-clock jump between watchdog ticks) triggers the same probe. A genuinely dead socket is still torn down and reconnected, about 5 s later than before.
