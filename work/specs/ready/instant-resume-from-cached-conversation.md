---
title: Instant resume - show the cached conversation after the app was killed
slug: instant-resume-from-cached-conversation
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Resolved decisions

1. **Privacy: cache ON by default, no opt-in toggle.** The user confirmed that caching sensitive conversation content (tool output included) on the device is fine. The cache is wiped by the explicit "Disconnect Server" actions and when a connect uses a different server (see `serverKey`).
2. **Size: the proposed default is adopted.** The last loaded history window for the 5 most recently opened sessions, capped at ~2 MB per session (oldest messages dropped first).
3. **Staleness cue: the existing banner is enough.** The "Reconnecting and syncing session..." banner marks the window in which cached content may be stale. Messages are not dimmed or labelled.

## Problem Statement

Coming back to the PWA on a phone after the OS killed it in the background (common on Android, especially for installed PWAs and Firefox) shows **no conversation at all**: a full-screen "Connecting to Wherever Server..." and then "Loading session..." for several seconds, with nothing to read and nowhere to type.

The client keeps the conversation only in memory. Only *undelivered outbound* messages are persisted (`loadPersistedPending`, localStorage). After a reload there is nothing to show until:
1. the socket is up;
2. the session is re-loaded;
3. the (possibly large) history frame has arrived over a mobile link.

`ChatMessageList` keeps the conversation on screen during a reconnect only when `hasCachedSession` (`!!sessionFile`) is true, and it never is after a reload.

(Not part of this spec, already in the tree:
- when the page survives, the cached in-memory conversation stays visible;
- the composer blocks only sending while reconnecting.

False socket teardown on thaw is handled by `ws-liveness-hardening`.)

## Solution

Persist a bounded cache of recently viewed conversations on the device (IndexedDB). On boot, when the URL hash names a cached session:
1. load it into the client store;
2. then connect in PRESERVE mode.

The conversation renders immediately and the composer is editable (sending blocked). The existing rejoin path (`session_load` → `session_created` + `message_history`) then replaces it with the authoritative history.

## User Stories

1. As a phone user returning to the PWA after the OS killed it, I want the conversation I was reading to appear immediately, so that I can keep reading while it reconnects.
2. As that user, I want to start typing (and attaching) immediately, with only Send blocked until the session has resynced.
3. As a user, I want the cached view to be replaced seamlessly by the server's authoritative history, with no duplicates or lost messages.
4. As a user, I want messages I sent that never reached the server to still be recovered as "failed / retry" exactly as today. The cache must not double-surface or re-tag them.
5. As a user whose cached session no longer exists (its load is refused outright), I want the cached view replaced by the normal error/empty behaviour and the stale record evicted, not a conversation that looks live but isn't. A session that loads but turns out folder-missing, or whose cold agent build fails, keeps today's readable-but-blocked behaviour, since those arrive after an authoritative paint.
6. As a user who boots offline, I want to keep reading the cached conversation without a misleading "Loading the session timed out" error appearing over it while no socket exists.
7. As a user, I want both "Disconnect" actions (the sidebar's "Disconnect Server" and Connection Settings' "Disconnect"), and connecting to a different server, to wipe the cache. "Reconnect", and the settings "Connect" button against the same server, must NOT wipe it.
8. As a maintainer, I want the cache bounded in sessions and bytes, with LRU eviction, and cheap to write while a reply streams (no jank on low-end phones).
9. As a maintainer, I want the cache keyed by a config-derived server identity plus the session id, so that two configured servers never show each other's conversations.
10. As a user with storage unavailable (e.g. private mode, blocked storage, iOS eviction), I want exactly today's behaviour, with no errors.
11. As a user opening a session that is NOT cached, I want today's behaviour (the "Loading conversation..." spinner).
12. As a user with two tabs open, I accept last-write-wins on the same session's cache record. It is only a cache.

### Autonomy notes

- `humanOnly` and `needsAnswers` are omitted. The questions are resolved above.

## Implementation Decisions

> Seed for tasking; trimmed once tasked.

**Cache module (web).**
- An IndexedDB store `wherever-conversation-cache`. Records: `{ serverKey, sessionId, sessionFile, cwd, model, messages, historyTotalCount, historyOffset, savedAt }`.
- **Normalize at WRITE time:**
  - drop `delivery`-tagged user messages (those are recovered from localStorage by `loadPersistedPending`);
  - force `isStreaming: false` on every message;
  - drop tool-image payloads (base64), or count them toward the byte cap. Default: drop them.
- **Byte cap:** trim the oldest messages to fit. The cached `historyOffset`/`historyTotalCount` are kept as-is and only drive the affordance: client messages do not map 1:1 to server entries (`mapHistory` merges a tool call with its result), so the offset can't be adjusted by counting. "Load older messages" (and `loadMoreHistory()` itself, which does not check this today) is gated on "a rejoin `message_history` has landed for this session", not on `resyncing`. After a watchdog timeout `resyncing` is false while the stale cached offset remains, and the server silently ignores `history_load_more` from an unattached socket, which would leave `loadingMoreHistory` stuck.
- **Write triggers:** `message_history`, `agent_end`, `visibilitychange: hidden`, `pagehide`, plus at most one throttled write per ~5 s while streaming. No per-token or per-second structured clones.
- **Failure handling:** if `indexedDB.open` throws or rejects, the cache is disabled for the page and everything behaves as today. Optionally call `navigator.storage.persist()`.

**`serverKey`.** `host:port` plus a short hash of the token. It is a SYNCHRONOUS pure function `serverKey(config)` exported by the client package, using a non-crypto hash (e.g. FNV-1a): `connect()` is synchronous, and `crypto.subtle` is async and missing in non-secure (plain-http LAN) contexts. Capturing it once at connect is not enough: Connection Settings saves host/port/token on every field change WITHOUT reconnecting (`handleConfigChange` → `setConfig`), and the client's own automatic reconnect (`scheduleReconnect` → `connect(undefined, preserve)`) then uses the edited config while the store still holds the old server's conversation. So:
- stamp `serverKey` (of the socket that delivered it) onto the active session when `session_created` arrives, and at hydration;
- cache writes always use the STAMPED key, never one derived from current config;
- when `connect()` (including the automatic reconnect) computes a key different from the stamped one, it wipes the store instead of preserving it (the stamped key is cleared with the store, not re-stamped to the new config's key) and does not rejoin. It also clears `resumeSessionFile` / `resumeCwd` / `resumeModel`: `onOpen` rejoins `resumeSessionFile ?? activeSessionFile`, and a `suspend()` record would otherwise survive the wipe and send the old server's `session_load` to the new server.
- The key is captured in `connect()` next to the socket it opens, so "the socket that delivered it" is well defined.
- The stamping and the comparison live in `client.ts` (slice 1). The web cache (slice 2) only takes a key string.
- Wipe hooks:
  - both explicit Disconnect actions (`+page.svelte`'s `handleDisconnect` and `ConnectionSettings.svelte`'s `handleDisconnect`);
  - on EVERY web `connect()`, slice 3 calls `cache.retainOnly(serverKey(cfg))`, deleting records under any other key. This needs no stored "previous key" (which the settings Connect button's `disconnect(true)` store reset and a reload would both erase), covers reloads, and leaves Reconnect and a same-server Connect untouched.
- NOT `wherever.ts`'s `disconnect()` itself: "Reconnect" (`+page.svelte`) and the settings "Connect" button (`ConnectionSettings.svelte`'s connect handler) also call it.
- Keying already prevents cross-server leaks; the wipe is hygiene. Align or document the difference with `disconnect(true)`, which deliberately KEEPS the localStorage pending entries.

**Hydration seam (client).** Add `WhereverClient.hydrateCachedSession(snapshot)`.
- It is a no-op unless all of these hold:
  - the store has no `activeSessionFile`;
  - `pendingLoadFile === null`;
  - the client is not connected.

  This guards against an IndexedDB read that resolves after real data has landed.
- It sets the active session fields (`session`, `sessionId`, `activeSessionFile`, `activeCwd`, `activeModel`) and messages, plus `resyncing: true` and `isStreaming: false`. `sessionId` matters: the `message_history` stale-session guard, `loadMoreHistory` and the page's `currentSessionId` (hash effect, `wasSessionActive`) all key off it. It leaves `agentPending`, `folderConflict`, `sudoPrompt` and `readOnly` at their defaults (the rejoin re-states them). It does NOT set `pendingLoadFile`.
- `onOpen`'s existing rejoin then issues `session_load` from `activeSessionFile`. `message_history` replaces messages wholesale, so no merge logic is needed.
- `historyAuthoritative` (exposed in the store): set false at hydration AND on every `onOpen` rejoin, set true by the matching `message_history`. `loadMoreHistory()` is a no-op while it is false. This also fixes the existing in-page-reconnect case, where `history_load_more` from a not-yet-attached socket is silently ignored and `loadingMoreHistory` sticks.

**Boot wiring (web).**
- Today `onMount` → `connect()` → `client.connect(cfg)` with `preserveState=false`, which resets the store to defaults and would erase a hydration. The new boot:
  1. reads the cache for the hash session, awaiting at most ~300 ms (boot already defers 200 ms);
  2. calls `hydrateCachedSession` on a hit;
  3. connects with `preserveState: true` ONLY on a cache hit (preserve keeps the store's existing fields, e.g. `hideThinking`), so `wherever.ts`'s `connect()` gains a preserve option. On a miss, boot is unchanged.
- The `+page.svelte` hash auto-join already skips when `currentSessionId === hashId`; verify that a hydrated session is not double-loaded.

**Load failure / offline.**
- Evict the record and clear the cached session from the store ONLY on a `session_error` that answers the hydrated load itself: `pendingLoadFile === hydratedFile` and no `session_created` has arrived yet (e.g. "session not found"). `pendingLoadFile` is private to the client, so the client makes this decision (slice 1). It clears the session and emits `{type: 'hydration_rejected', sessionId}` to `onMessage` listeners. (The reducer and the web listener both ignore unknown types, so a synthesized event is safe.) The web (slice 3) evicts the cache record and clears the hash on that signal.
- NEVER on `folder_missing`, or on a cold-build `session_error`. Both arrive AFTER an authoritative `session_created` + `message_history`, and today they correctly leave a readable conversation (with the restore panel / blocked composer).
- **Hash auto-join loop: already fixed** (see CONTEXT.md, "The URL hash auto-join never retries a failed load"). A hash-triggered load that fails is tried once: the hash is cleared and the error shown. A hydrated session's rejoin is issued by `onOpen`, not by the hash effect, so no attempt is recorded for it. Once connected, the hash-writing effect already clears the hash when the hydrated session is cleared (`wasSessionActive`). That clear uses `location.hash = ''`, which adds a history entry, so slice 3 must get there first: it clears the hash with `history.replaceState` SYNCHRONOUSLY in the `hydration_rejected` listener, before any await (the IndexedDB eviction comes after). The hash-writing effect then finds no hash, so Back is not trapped.
- **Offline: no false timeout (regression guard only).** No load watchdog runs before the socket opens: `resume()` arms one and then immediately calls `connect()`, whose `disconnect(false)` clears it. Remove that dead arm deliberately (it misleads readers), keep the `onOpen` rejoin arm, and keep story 6 as a regression test (hydrated data + a socket stuck CONNECTING shows no timeout error).
- **Boot window.** The `pageshow` / `visibilitychange` handlers call a plain `connect()` when `!connected && !hasActiveSession()`, which resets the store and would race (and erase) a hydration still awaiting the ≤300 ms cache read. Hold them off with a `booting` flag until boot has hydrated (or missed) and connected.

## Testing Decisions

> Seed for tasking; trimmed once tasked.

- **Client, slice 1** (vitest + `client/test/harness.ts`):
  - hydrate, then `connect(cfg, true)`: the messages survive, `session_load` is issued for the hydrated file, and `message_history` replaces them;
  - `hydrateCachedSession` after `session_created` is a no-op;
  - undelivered-message recovery is unchanged with a hydrated cache;
  - a `session_error` answering the hydrated load clears it, while `folder_missing` / a cold-build `session_error` after `session_created` do NOT;
  - `resume()` with hydrated data and a socket stuck CONNECTING raises no timeout error (regression guard);
  - an automatic reconnect after host/port were edited does not preserve or rejoin the old server's session, and the stamped key is cleared with the store (not re-stamped to the new config's key);
  - suspend → resume against a dead socket → edit host → automatic reconnect: no `session_load` is sent (the `resumeSessionFile` record is cleared too);
  - `historyAuthoritative` goes false on every `onOpen` rejoin and true on the matching `message_history`;
  - `loadMoreHistory()` is a no-op, and an exposed `historyAuthoritative` flag is false, until the rejoin's `message_history` has landed;
  - `serverKey(config)` is synchronous and stable, stamped on `session_created` and at hydration;
  - a rejected hydrated load emits `hydration_rejected`.
- **Web cache module, slice 2** (adds `fake-indexeddb` as a web dev dependency):
  - normalization (`delivery` / streaming / images stripped);
  - the byte cap trims the oldest messages;
  - LRU across sessions;
  - scoping by the key string, and `retainOnly(key)` deletes every other key;
  - graceful no-op when IndexedDB is unavailable.
- **Boot / hooks, slice 3.** The web vitest config is `environment: 'node'`, with no jsdom/testing-library, and every web test targets a pure module. So slice 3 extracts its decisions into a pure `web/src/lib/core/` module, following the `decideHashJoin` pattern (history, cache and client injected), unit-tests that, and checks the Svelte wiring manually. The decisions to test:
  - both Disconnect actions wipe;
  - every connect calls `retainOnly(serverKey(cfg))`, so records of another server are deleted;
  - nothing is ever written under a key other than the stamped one;
  - Reconnect and a same-server Connect do not;
  - an edit to host/port without reconnecting never re-keys the current conversation;
  - a cache miss boots exactly as today;
  - "Load older messages" is hidden or disabled while `historyAuthoritative` is false;
  - `hydration_rejected` evicts the record and clears the hash without adding a history entry;
  - a `pageshow` / visibility event during boot does not wipe a hydration in progress;
  - a hydrated session whose rejoin fails with an untagged `session_error` is evicted, the hash cleared, and it is not re-joined.

## Suggested slicing

1. **Client** (no deps): hydration seam (incl. `sessionId`), synchronous `serverKey(config)` with stamping and the key comparison in `connect()` (incl. clearing the `resume*` record), `hydration_rejected`, `historyAuthoritative` + the `loadMoreHistory` gate, removal of `resume()`'s dead watchdog arm.
2. **Web cache module** (no deps; takes the key as a string): normalization, cap, LRU, `retainOnly`, failure no-op, `fake-indexeddb` dev dependency.
3. **Boot wiring** (blockedBy 1 and 2): await cache, hydrate, preserve-mode connect on a hit; boot-window guard; wipe hooks + `retainOnly` on connect; synchronous hash clear on `hydration_rejected`; "Load older" UI gate. Decisions in a pure `lib/core` module.
- **Cross-spec ordering:** slice 1 touches `client.ts` (`onOpen`, `session_created`, `resume()`) and slice 3 touches `+page.svelte`'s visibility handlers, both also touched by `ws-liveness-hardening` and `resumable-chunked-uploads`. Add `blockedBy` links at tasking so they run in order. There is no design dependency, hence no `taskedAfter`.

## Out of Scope

- Offline sending (queueing outbound messages for later delivery).
- Keeping the socket alive in the background (see `native-shell-capacitor-experiment`).
- Liveness / thaw behaviour (`ws-liveness-hardening`, independent: no hydration task depends on it).
- Caching uploads or attachments.

## Further Notes

- Related: `docs/plan-firefox-android-reload-on-resume.md` (its Option A, "make reload cheap", is this cache) and `docs/plan-speed-up-long-session-load.md`.
