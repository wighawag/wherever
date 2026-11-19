---
"@wherever-dev/pi": minor
---

In a terminal pi connected to a wherever server that supports it, kenning's `session_spawn` now creates the new session on the server (a sidebar session under its owner) instead of a zellij pane or a headless `pi -p`, and `session_stop` of a session the server runs aborts it there. The bridge registers this only while connected, so kenning falls back to its terminal default otherwise.
