---
title: Instant resume - show the cached conversation after the app was killed
slug: instant-resume-from-cached-conversation
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

> Tasked. The implementation and testing detail moved into the tasks in `work/tasks/` (`spec: instant-resume-from-cached-conversation`), and the durable rationale into `docs/adr/0013-on-device-conversation-cache-on-by-default-keyed-by-the-stamped-server.md`.

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

## Out of Scope

- Offline sending (queueing outbound messages for later delivery).
- Keeping the socket alive in the background (see `native-shell-capacitor-experiment`).
- Liveness / thaw behaviour (`ws-liveness-hardening`, independent: no hydration task depends on it).
- Caching uploads or attachments.
