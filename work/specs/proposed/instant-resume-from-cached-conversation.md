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
- **Byte cap:** trim the oldest messages to fit. The cached `historyOffset`/`historyTotalCount` are kept as-is and only drive the affordance: client messages do not map 1:1 to server entries (`mapHistory` merges a tool call with its result), so the offset can't be adjusted by counting. "Load older messages" is disabled while `resyncing`, and the rejoin's `message_history` re-states the authoritative offset before it can be used.
- **Write triggers:** `message_history`, `agent_end`, `visibilitychange: hidden`, `pagehide`, plus at most one throttled write per ~5 s while streaming. No per-token or per-second structured clones.
- **Failure handling:** if `indexedDB.open` throws or rejects, the cache is disabled for the page and everything behaves as today. Optionally call `navigator.storage.persist()`.

**`serverKey`.** `host:port` plus a short hash of the token, captured from the config of the LIVE socket at connect time (`client.connect`'s effective config), never recomputed from saved settings at write time. Connection Settings saves host/port/token on every field change WITHOUT reconnecting (`handleConfigChange` → `setConfig`), so a key read from saved config would file the current server's conversation under the next server's key.
- Wipe hooks:
  - both explicit Disconnect actions (`+page.svelte`'s `handleDisconnect` and `ConnectionSettings.svelte`'s `handleDisconnect`);
  - a connect whose `serverKey` differs from the previous connection's.
- NOT `wherever.ts`'s `disconnect()` itself: "Reconnect" (`+page.svelte`) and the settings "Connect" button (`ConnectionSettings.svelte`'s connect handler) also call it.
- Keying already prevents cross-server leaks; the wipe is hygiene. Align or document the difference with `disconnect(true)`, which deliberately KEEPS the localStorage pending entries.

**Hydration seam (client).** Add `WhereverClient.hydrateCachedSession(snapshot)`.
- It is a no-op unless all of these hold:
  - the store has no `activeSessionFile`;
  - `pendingLoadFile === null`;
  - the client is not connected.

  This guards against an IndexedDB read that resolves after real data has landed.
- It sets the active session fields and messages, plus `resyncing: true` and `isStreaming: false`. It leaves `agentPending`, `folderConflict`, `sudoPrompt` and `readOnly` at their defaults (the rejoin re-states them). It does NOT set `pendingLoadFile`.
- `onOpen`'s existing rejoin then issues `session_load` from `activeSessionFile`. `message_history` replaces messages wholesale, so no merge logic is needed.

**Boot wiring (web).**
- Today `onMount` → `connect()` → `client.connect(cfg)` with `preserveState=false`, which resets the store to defaults and would erase a hydration. The new boot:
  1. reads the cache for the hash session, awaiting at most ~300 ms (boot already defers 200 ms);
  2. calls `hydrateCachedSession` on a hit;
  3. connects with `preserveState: true` ONLY on a cache hit (preserve keeps the store's existing fields, e.g. `hideThinking`), so `wherever.ts`'s `connect()` gains a preserve option. On a miss, boot is unchanged.
- The `+page.svelte` hash auto-join already skips when `currentSessionId === hashId`; verify that a hydrated session is not double-loaded.

**Load failure / offline.**
- Evict the record and clear the cached session from the store ONLY on a `session_error` that answers the hydrated load itself: `pendingLoadFile === hydratedFile` and no `session_created` has arrived yet (e.g. "session not found").
- NEVER on `folder_missing`, or on a cold-build `session_error`. Both arrive AFTER an authoritative `session_created` + `message_history`, and today they correctly leave a readable conversation (with the restore panel / blocked composer).
- After clearing, check the `+page.svelte` hash auto-join effect. With the hash still pointing at the missing session it may retry every ~300 ms. Today's behaviour for a dead hash must be confirmed first, and if it loops, the hydrated-failure path must clear the hash (or latch the failure) so a cache miss is never worse than today.
- **Offline: no false timeout.** The only load-watchdog arm before the socket opens is in `resume()`, and `+page.svelte`'s visibility handler calls `resume()` whenever `hasActiveSession()`, which is true after hydration. With a stuck CONNECTING socket the 12 s watchdog then paints "Loading the session timed out" over the cache. Skip `resume()`'s early arm when the store holds hydrated, not-yet-rejoined data. The arm in `onOpen`'s rejoin still covers a load that is sent and goes unanswered.

## Testing Decisions

> Seed for tasking; trimmed once tasked.

- **Client** (vitest + `client/test/harness.ts`):
  - hydrate, then `connect(cfg, true)`: the messages survive, `session_load` is issued for the hydrated file, and `message_history` replaces them;
  - `hydrateCachedSession` after `session_created` is a no-op;
  - undelivered-message recovery is unchanged with a hydrated cache;
  - a `session_error` answering the hydrated load clears it, while `folder_missing` / a cold-build `session_error` after `session_created` do NOT;
  - `resume()` with hydrated data and a socket stuck CONNECTING raises no timeout error.
- **Web cache module** (`fake-indexeddb`):
  - normalization (`delivery` / streaming / images stripped);
  - the byte cap trims the oldest messages, and "Load older" stays disabled until the rejoin re-states the offset;
  - LRU across sessions;
  - `serverKey` scoping;
  - graceful no-op when IndexedDB is unavailable.
- **Boot / hooks** (slice 3):
  - both Disconnect actions wipe;
  - a connect with a different `serverKey` wipes;
  - Reconnect and a same-server Connect do not;
  - an edit to host/port without reconnecting never re-keys the current conversation;
  - a cache miss boots exactly as today.

## Suggested slicing

1. Web cache module (normalization, cap, LRU, `serverKey` keying, failure no-op).
2. Client hydration seam plus load-failure / offline-watchdog behaviour.
3. Boot wiring (await cache, hydrate, preserve-mode connect on a hit) and the wipe hooks (blockedBy 1 and 2).
- **Cross-spec ordering:** slice 2 touches `client.ts` (`onOpen`, `session_created`, `resume()`) and slice 3 touches `+page.svelte`'s visibility handlers, both also touched by `ws-liveness-hardening` and `resumable-chunked-uploads`. Add `blockedBy` links at tasking so they run in order. There is no design dependency, hence no `taskedAfter`.

## Out of Scope

- Offline sending (queueing outbound messages for later delivery).
- Keeping the socket alive in the background (see `native-shell-capacitor-experiment`).
- Liveness / thaw behaviour (`ws-liveness-hardening`, independent: no hydration task depends on it).
- Caching uploads or attachments.

## Further Notes

- Related: `docs/plan-firefox-android-reload-on-resume.md` (its Option A, "make reload cheap", is this cache) and `docs/plan-speed-up-long-session-load.md`.
