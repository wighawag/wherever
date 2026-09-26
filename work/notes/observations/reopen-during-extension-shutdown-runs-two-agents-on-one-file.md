---
title: Reopening a session while its extensions are still in session_shutdown briefly runs two agents (and two extension sets) on the same file
type: observation
status: spotted
spotted: 2026-09-26
---

# Reopen during extension shutdown overlaps two agents on one session file

## What was seen

Server sessions now run the pi extension lifecycle (`server/src/extension-lifecycle.ts`, CONTEXT.md "Server sessions run the pi extension lifecycle"). `SessionPool.destroySession` (`server/src/session-pool.ts`) drops the pool entry SYNCHRONOUSLY, then runs `shutdownAndDisposeAgentSession`, which awaits extension `session_shutdown` handlers for up to `EXTENSION_SHUTDOWN_TIMEOUT_MS` (5s) before `dispose()`.

During that window nothing stops `loadSession` (or an unregister-then-reload) for the same file from building a NEW AgentSession and firing its `session_start`. The old agent's turn is already aborted, so the transcript is not written twice, but two extension instances for the same session are alive at once: the old one still releasing, the new one starting.

Raised by the reviewer of the lifecycle change; not reproduced.

## Why it matters

Extensions that hold a fixed, process-level resource can collide: the pi-mcp-adapter's OAuth callback server (fixed port), a stdio MCP server with a lock file, anything keyed by session id. The symptom would be an intermittent start failure right after closing and reopening a session.

## Possible fix (not decided)

A per-file `pendingTeardown` map in `SessionPool`: `destroySession` records the teardown promise under the session file, and `loadSession` awaits it (it is bounded, so at most one shutdown timeout) before building the new agent. The same applies to `createNewSession` only if it could ever target an existing file (it cannot today).
