---
"wherever-dev": patch
---

The session pool now keeps per-user-message reply routing for the assistant (ADR 0014): each send can carry an origin (`telegram`, `schedule:<jobId>`, ...; web sends record `none`), and every reply is attributed to the origin of the user message it answers, across prompts, steers and follow-ups, extension-handled `/commands`, `!` shell sends, aborts and CLI-bridge sessions. The pool also gains an event fan-out beside the WS broadcaster. Server sends now all go through pi's `prompt()` (plain text exactly as before; `/skill:` and prompt templates still expand). Nothing a user or client sees changes.
