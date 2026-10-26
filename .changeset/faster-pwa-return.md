---
"wherever-dev": patch
"@wherever-dev/client": patch
---

Coming back to the PWA no longer reconnects slower than a page reload. When the page becomes visible again, the client probes the existing socket with a 2 s grace (was 5 s), replaces a dead socket at once instead of after the reconnect backoff, resets a backoff that grew while the app was in the background, and restarts a handshake still pending after 8 s. A dead socket on return used to cost 7 to 20 s of "Reconnecting...".
