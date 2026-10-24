---
"wherever-dev": patch
---

Add the web's on-device conversation cache module (`web/src/lib/core/conversation-cache.ts`): a bounded IndexedDB store of recently viewed conversations (5 sessions in total, ~2 MB each, LRU), scoped by server key, normalized at write time (no undelivered messages, streaming flags or tool images), with a write throttle for streaming replies and a silent no-op fallback when IndexedDB is unavailable. Not wired into the app yet; it is the storage half of instant resume after the OS kills the PWA.
