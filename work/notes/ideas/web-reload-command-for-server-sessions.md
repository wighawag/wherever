---
title: Support /reload from the web composer as an explicit protocol message, not chat text
type: idea
status: incubating
created: 2026-09-26
---

# `/reload` in the web composer

## Today

`/reload` is a built-in pi TUI command, not an extension command, so in a web session it reaches the agent as plain chat text (server sessions go through `AgentSession.prompt()` with template expansion, which only knows skills, prompt templates and extension commands). The web composer already intercepts `/new`, `/reset`, `/clear`, `/leave`, `/exit` locally (`web/src/lib/components/ChatInput.svelte`, "Handle local slash commands").

## Proposal

- The composer recognises `/reload` (same place as `/new`) and sends a dedicated WS message, e.g. `session_reload { sessionId }`, instead of a `message`. A dedicated message rather than server-side text matching because a mid-stream `message` becomes a STEER, and a reload must not be queued into the agent's turn.
- Server, server-created session: refuse while streaming (or wait for idle), then `agentSession.reload()`. Since server sessions are now bound (`server/src/extension-lifecycle.ts`), reload fires `session_shutdown(reload)` then `session_start(reload)` and `resources_discover("reload")`. Afterwards push the refreshed skill/command list so web autocomplete updates.
- Server, CLI-bridge session: the terminal pi owns the agent. Either relay to the `@wherever-dev/pi` extension (which would need a command-context path to `ctx.reload()`), or answer "run /reload in the terminal".

## Blocker to design first

`AgentSession.reload()` calls pi-ai's `resetApiProviders()`, which is PROCESS-WIDE. In the multi-session server, one session's reload drops the custom API providers that OTHER live sessions' extensions registered (they re-register only on their own reload/rebuild). This is why the extension-requested `ctx.reload()` is currently refused for server sessions (see CONTEXT.md). A web `/reload` needs an answer: reload every live server session together, re-register providers from all live extension runners after the reset, or get pi to scope the reset.
