---
"wherever-dev": patch
"@wherever-dev/client": patch
---

Client groundwork for showing a cached conversation instantly after a reload. `@wherever-dev/client` now exports `serverKey(config)` (a synchronous `host:port` plus token-hash identity) and `WhereverClient.hydrateCachedSession(snapshot)`, which paints a cached conversation before the socket is up and lets the normal reconnect rejoin replace it with the server's history. The store gains `serverKey` (the server that actually delivered the active session) and `historyAuthoritative` (gates `loadMoreHistory()` until the real history has arrived). A reconnect after the host, port or token were edited no longer preserves or rejoins the previous server's session. When the server refuses the load of a hydrated session outright, the client clears it and emits a synthesized `hydration_rejected` event to `onMessage` listeners. `resume()` no longer arms a load watchdog that was immediately cleared.
