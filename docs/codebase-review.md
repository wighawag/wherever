# Wherever — Codebase Health, Architecture, and Quality Review

This document provides a comprehensive evaluation of the overall health, architecture, and code quality of the Wherever monorepo (comprising `extension`, `server`, and `web` workspaces).

---

## Review

### Correct (Already Good)

* **Svelte 5 Runes & Reactivity Integration:**
  * The web app (`web/`) uses modern Svelte 5 runes (`$state`, `$derived`, `$effect`, and `@render`) flawlessly.
  * Static Svelte checking (`pnpm --filter @wherever-dev/web check`) reports **0 errors and 0 warnings**, indicating excellent code safety and compliance with the Svelte 5 engine.
* **Coherent Monorepo Architecture & Strict TypeScript Setup:**
  * Clean `pnpm` workspaces structure segregates responsibilities appropriately (`extension` for terminal CLI bridge integration, `server` for standalone multi-session management, and `web` for SPA UI).
  * Strict TypeScript checks compile cleanly without a single error or warning across all packages.
* **Intelligent UX Features:**
  * **Input Queueing:** `ChatInput.svelte` implements a highly fluid queueing system: if a user inputs text while the agent is streaming, the client caches it and automatically fires it as soon as the agent finishes.
  * **Interactive Collapsible Tools:** `ChatMessageList.svelte` parses raw CLI execution messages (e.g. `bash`, `read`, `write`, `grep`, `find`) and presents them as interactive, collapsible items with custom icons and formatted argument-value blocks rather than raw dump strings.
  * **Slash Commands:** Local UI slash command handling (`/new`, `/reset`, `/clear`, `/leave`, `/exit`) directly mirrors terminal CLI behaviors. `/reload` is intercepted too but carried out by the server (`session_reload`, see CONTEXT.md).
* **Safe Session Takeover & Read-Only Observer Mode:**
  * Multi-session conflict resolution on the standalone server protects workspaces from simultaneous conflicting client actions. "Read Only" observer state allows multi-client mirroring without collision, and "Take Over" sends a prompt `session_interrupted` websocket notice to re-route prior controllers safely.
* **Self-Signed SSL Generation:**
  * `server/src/index.ts` automatically runs OpenSSL CLI commands to generate local certs (`~/.wherever/certs/`) if secure connection parameters are set. This provides instant encrypted `HTTPS`/`WSS` support for remote browser or mobile connection out-of-the-box.

---

### Fixed

* **Store Rendering Bug in Session Browser:**
  * **Location:** `web/src/lib/components/SessionBrowser.svelte` (lines 231–237)
  * **Issue:** The derived `sessionError` store was being rendered inside Svelte markup directly as `{sessionError}` instead of referencing its reactive value `{$sessionError}`. This caused the UI to print `[object Object]` as a raw string instead of the actual error message.
  * **Resolution:** Replaced `{sessionError}` with `{$sessionError}` to ensure the warning text renders correctly.

---

### Blocker

* **Outdated and Broken CLI Reference Client (`extension/src/client.ts`):**
  * **Location:** `extension/src/client.ts`
  * **Issue:** The reference CLI testing client has become obsolete and entirely non-functional due to the standalone server transitioning to a multi-session architecture:
    1. The standalone server now requires clients to join or create a session (via `session_load` or `session_new` WS events) before accepting chat messages (`type: "message"`). Since `client.ts` sends raw user inputs without executing a session handshake first, the server discards inputs silently.
    2. The CLI client expects a `session` field in the initial `connected` response, but the standalone server sends `clientId` instead.
  * **Resolution:** Re-write or update `client.ts` to perform the initial session connection handshake, or document that `client.ts` is a legacy client that should be deprecated in favor of using the unified web application.

---

### Note

* **Total Lack of Test Coverage:**
  * Across all workspaces (`web`, `server`, `extension`), there is **no test coverage** (no Unit, Integration, or End-to-End tests). To protect against potential regressions as the underlying Pi SDK or protocol formats evolve, establishing a standard test suite (e.g., using Vitest for server/client logic and Playwright for web UI) is strongly advised.
* **Missing CLI Client Guides:**
  * While `docs/USAGE.md` provides detailed specifications for the REST and WebSocket protocols, it entirely lacks instructions on how to run or debug the reference `client.ts` utility.
* **Runtime OpenSSL Tooling Dependency:**
  * The automatic cert generator in `server/src/index.ts` relies on the presence of the `openssl` command in the host environment. On environments where OpenSSL is not standard (e.g., bare Windows without git-bash, or minimal alpine Docker images), it fails back to insecure HTTP. While the fallback is handled gracefully, the dependency should be declared in the documentation.
* **Incomplete Service Worker / PWA configuration:**
  * The frontend repository contains remnants of PWA integration (such as `pwag` script references and `VersionAndInstallNotfications.svelte` imports) but service worker registration is set to `register: false` in `svelte.config.js`, indicating a partially integrated feature set.
