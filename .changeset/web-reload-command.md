---
"wherever-dev": minor
"@wherever-dev/client": minor
---

Support `/reload` in the web composer. It no longer reaches the model as chat text: the client sends a new `session_reload` frame and the server rebuilds the session's agent so it re-reads settings, extensions (including edited extension code), skills, prompts and context files such as AGENTS.md. Extensions see `session_shutdown` and `session_start` with reason `reload`. The rebuild keeps the conversation, model and thinking level, and avoids pi's in-place reload, whose provider reset would affect every other live session. While it runs, viewers get `session_reloading` (composer blocked) and then `session_ready`. It is refused with a notice while the agent is busy, for terminal-driven sessions and for read-only viewers. The client gains `reloadResources()`.
