# Decisions taken while building `client-hydration-seam-and-server-key`

2026-10-24. In-scope choices the task did not spell out, recorded for the reviewer to ratify or reverse. Code: `client/src/client.ts` (`serverKey`, `connect`, `hydrateCachedSession`, `rejectHydration`), summarised in CONTEXT.md "Client hydration seam and the stamped server key".

1. **Key format is `host:port#<fnv1a32(token) hex>`; `secure` is excluded.** The host is normalised like the socket URL (an `http(s)://` prefix dropped). Alternative: include the scheme. Rejected because ws vs wss to the same host:port is the same server, and flipping the toggle would otherwise wipe the cache. Touches: the web cache keys and `retainOnly(serverKey(cfg))` in `boot-hydration-wiring-and-wipe-hooks`.
2. **The key-mismatch wipe applies to every `connect()`, preserve or not, and also drops `pendingLoadFile` and the hydration marker** (not only `resume*`). Alternative: only in preserve mode. Rejected because a plain `connect()` after `suspend()` would otherwise still rejoin `resumeSessionFile` on the new server.
3. **`historyAuthoritative` is also reset on `session_created`** (the task lists hydration and the onOpen rejoin). It makes the flag mean "this session's own history has landed" for switches too; harmless since `message_history` follows immediately.
4. **`hydrateCachedSession` drops `delivery`-tagged user messages from the snapshot**, defensively (the cache already drops them at write time), so recovery stays solely with `loadPersistedPending`.
5. **`hydration_rejected` clears the stamp and the paging state with the session**, and keeps the `sessionError` the reducer surfaced. The hydration marker is also cleared by `switchSession`, `leaveSession` and `createSession`, so a later untagged error for another request can never reject it.
6. **A snapshot without `serverKey` is stamped with `serverKey(this.config)`.** The web record always carries one; the default only serves other callers.
