---
"wherever-dev": minor
---

Upgrade the embedded pi SDK to 1.4 and give server-created (web) sessions pi's native MCP support (#69). The SDK does not load pi's built-in extensions by itself, so the server now loads the built-in MCP, codemode and tool search extensions the way the pi CLI does: the MCP servers in `~/.pi/agent/mcp.json` (and a trusted project's `.pi/mcp.json`) connect in web sessions, `-builtin:mcp` in the `extensions` setting still turns them off, and an installed replacement such as pi-mcp-adapter still takes over. Sign in to OAuth MCP servers from a terminal (`pi mcp login <server>`); web sessions use the stored credentials. Models and auth now come from pi 1.x's shared `ModelRuntime`, and `/models` refreshes availability before answering, so a provider signed in to from a terminal shows up without restarting the server.
