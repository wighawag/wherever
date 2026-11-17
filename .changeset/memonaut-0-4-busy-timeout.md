---
"wherever-dev": patch
---

Conversation search now uses memonaut 0.4 instead of 0.1. The old range `^0.1.0` meant `<0.2.0` on a 0.x version, so it never picked up newer releases. The index schema (v1) and the transcript extraction are unchanged, so the existing `~/.local/share/memonaut/index.db` is reused as-is, with no rebuild. What changes is how contention is handled: 0.4 sets a 5 s SQLite busy timeout on every connection. The index is written concurrently by the `recall` CLI, by memonaut-pi in every agent session, and by the server's own background `index` child. Under 0.1 that child could fail silently with SQLITE_BUSY, and a `/search` read could return `status: 'error'` while another process was checkpointing the database.
