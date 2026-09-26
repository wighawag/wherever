---
"wherever-dev": patch
---

Server-created sessions now run the pi extension lifecycle. Both `createAgentSession()` paths call `bindExtensions()` before the session is tracked, so extensions receive `session_start` and `resources_discover` (this fixes "MCP not initialized" from the pi-mcp-adapter in web sessions); a `session_start` still running after 15s is logged. Every dispose now aborts any in-flight turn, then emits `session_shutdown` (`reason: "quit"`) bounded by a 5s timeout, on idle eviction, manual destroy, delete, server shutdown and CLI takeover, so extensions release MCP connections, OAuth callback servers and timers. Extension errors are logged to the journal. Extension-requested reload, new session, fork, switch and tree navigation are refused for server sessions (reload would reset model providers for every session in the process).
