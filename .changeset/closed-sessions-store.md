---
"wherever-dev": minor
---

The server can now close a session: `POST /sessions/close {sessionFile, closed}` records it in `closed-sessions.json` (the transcript is never touched), `/sessions` reports `closed: true` per session (closed sessions are still listed, and not retention-exempt), closing a starred session unstars it and starring a closed one reopens it, and deleting a session drops its close flag. The web store gains `setSessionClosed()`; no UI uses it yet.
