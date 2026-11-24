---
"wherever-dev": minor
---

A closed session now reopens itself when it comes back to life: on an agent turn starting, a user message from any channel (web, Telegram, a CLI terminal), a shipmates delivery, or an open inbox item it raised after it was closed. Each reopen re-lists the sessions on every dashboard, and a failing reopen write is logged without disturbing the session's events.
