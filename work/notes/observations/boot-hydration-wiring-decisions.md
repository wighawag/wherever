# Decisions taken while building `boot-hydration-wiring-and-wipe-hooks`

2026-10-24. In-scope choices the task did not spell out, recorded for the reviewer to ratify or reverse. Code: `web/src/lib/core/instant-resume.ts` (module JSDoc), summarised in CONTEXT.md "Instant resume wiring".

1. **Cache writes are gated on `historyAuthoritative`.** Alternative: write whenever there is a stamped session. Rejected because before the history lands the store holds the cached copy itself (nothing new) or a rejoin in flight, and gating guarantees a record never comes from an unconfirmed view. Cost: a `pagehide` during a reconnect rejoin writes nothing (the last throttled write is at most ~5 s old). Touches: only the web writes.
2. **The 300 ms cap is measured from mount, in parallel with the existing 200 ms boot delay**, so a fast read adds no latency and a slow one adds at most ~100 ms. Alternative: read after the 200 ms delay and wait up to 300 ms more.
3. **A hydration the client refused (`hydrateCachedSession` was a no-op) falls back to a plain connect**, exactly as a miss. Detected by checking `activeSessionFile` after the call (the client method returns void).
4. **`hydration_rejected` only clears a hash that names the rejected session**; the record is evicted either way. The eviction uses the key captured at hydration, since the client clears the stamp before emitting the event.
5. **The boot guard holds only the `resume()` / `connect()` branch**: `noteVisible()` still runs during boot (it is a no-op without an OPEN socket).
6. **"Load older messages" is hidden, not disabled**, by gating the `hasMoreHistory` store itself. Touches: `ChatMessageList.svelte` unchanged.
7. **`retainOnly` runs in the web's `connect()` only**, not on the client's automatic `scheduleReconnect` after a settings edit. Records of the old server then survive until the next explicit connect or reload; the stamp already prevents writing under the wrong key and the read at boot is keyed by the current config, so they are never shown.
8. **Disconnect cancels a pending throttled write before `clear()`**, so a trailing streaming write cannot re-create a record after the wipe.
