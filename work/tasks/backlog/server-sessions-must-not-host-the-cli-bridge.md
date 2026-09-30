---
title: Server sessions must not host the CLI bridge extension
slug: server-sessions-must-not-host-the-cli-bridge
blockedBy: []
covers: []
---

## What to build

Since `777d652` ("run the pi extension lifecycle for server-created sessions", released in 0.18.x) the server binds every pi extension in the user's settings for its own sessions. When those settings include `npm:@wherever-dev/pi` (the normal install, which `wherever install` itself wires up), the CLI bridge runs INSIDE the server process and connects back to it. That starts a loop:

1. The server builds a session (`buildServerAgent`), binds extensions, and fires `session_start`.
2. The bridge's `session_start` handler (extension `index.ts`) calls `connect()` and registers the session file as a CLI bridge.
3. `registerCliSession` treats this as a CLI takeover: it aborts the in-flight turn and shuts down the server agent via `shutdownAndDisposeAgentSession`.
4. That emits `session_shutdown`, so the in-server bridge disconnects.
5. `unregisterCliSession` sees clients attached, emits `session_error` "CLI terminal disconnected. Active execution was aborted." if a turn was streaming, and calls `loadSession`, which goes back to step 1.

Observed on telemaque on 2026-09-30 (wherever 0.18.3, @wherever-dev/pi 0.5.0): hundreds of alternating "Registered CLI Bridge" / "CLI Bridge disconnected ... Restarting server-side agent session..." journal lines per minute for one session, and the web UI showing the error with no terminal attached. Downstream workaround: `remote.bridge: false` in config.json, which also disables the bridge for real terminals.

Fix in two layers:

- **Server (primary, needed on its own):** a server-built session must never load the bridge extension. `DefaultResourceLoader` accepts `extensionsOverride(base)`, so filter out the `@wherever-dev/pi` extension there in the one agent-build path (load, create and reload all go through it). Identify it robustly: by package name / resolved path, not by a loose substring such as `wherever`, which would match unrelated extensions or paths.
- **Extension (defence in depth):** the bridge's `session_start` returns early when it is running inside a wherever server process (for example a marker the server sets at startup such as `process.env.WHEREVER_SERVER=1` or a `globalThis` symbol). This covers servers older than the fix. Needs a new `@wherever-dev/pi` release.

## Acceptance criteria

- [ ] A server-created, loaded and reloaded session with the bridge extension present in the agent dir's settings does NOT register a CLI bridge: no `registerCliSession` call, and no "CLI terminal disconnected" `session_error`.
- [ ] Other extensions still get the full lifecycle (`session_start`, `session_shutdown`), so the `777d652` fix (pi-mcp-adapter initialisation) is not regressed.
- [ ] A real CLI bridge (a separate pi process) still registers and takes over as before.
- [ ] The extension no-ops its bridge when it detects it is inside the wherever server.
- [ ] Regression test that fails with the fix removed. It uses a real extension file in a temp agent dir (as `test/extension-provider-model.test.ts` does), isolates `WHEREVER_CONFIG_DIR`/agent dir to temp paths, and asserts the real `~/.wherever` and `~/.pi` are untouched.

## Blocked by

- None: can start immediately.

## Prompt

> Fix the self-connecting CLI bridge loop described above. Start in `server/src/session-pool.ts` at `buildServerAgent` (the single `DefaultResourceLoader` construction shared by load/create/reload) and `server/src/extension-lifecycle.ts`; the loop's ends are `registerCliSession` / `unregisterCliSession` in the same file. The bridge is `extension/src/index.ts` (`session_start` / `session_shutdown` handlers). First confirm the premise against current code: if the server already excludes the bridge or the extension already guards itself, route to needs-attention instead of building. Record the identification rule you choose for "this is the bridge extension" in a JSDoc at the filter site. Done means the acceptance criteria above hold and a changeset exists for both `wherever-dev` and `@wherever-dev/pi`. The downstream my-boxes repo reverts its `remote.bridge: false` workaround once this ships.
