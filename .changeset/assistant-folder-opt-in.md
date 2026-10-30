---
"wherever-dev": minor
---

Add the opt-in `assistantFolder` config key, the foundation of the upcoming assistant. Unset (the default) changes nothing. When set, the server creates the folder at start and seeds it once (never overwriting) with a default `AGENTS.md`, `jobs/AGENTS.md` and a `.gitignore`, and takes a folder lock `.assistant.lock` (pid, host, boot id, process start time). A second server on the same folder refuses the assistant with a clear log line; a stale same-host lock (dead pid, reused pid, other boot) is taken over, and a lock from another host never is. The assistant status (configured, folder, active, lock) is exposed to the web in `GET /config`. Changing `assistantFolder` takes effect on restart.
