import type { AgentSession, ExtensionError } from '@earendil-works/pi-coding-agent';

/**
 * The pi EXTENSION LIFECYCLE for server-created sessions.
 *
 * `createAgentSession()` only LOADS extensions. It does not start them: in the pi
 * SDK it is `AgentSession.bindExtensions(...)` that emits `session_start` and then
 * `resources_discover` (extension-contributed skills, prompts, themes). The pi CLI
 * modes (interactive, print, rpc) all call it; a host that skips it leaves every
 * extension that initialises on `session_start` dead. The pi-mcp-adapter was the
 * visible victim ("MCP not initialized" on every `mcp(...)` call).
 *
 * Teardown has the same trap from the other side: `AgentSession.dispose()` does
 * NOT emit `session_shutdown`. Only `AgentSessionRuntime.dispose()` does, through
 * the internal (unexported) `emitSessionShutdownEvent`. Wherever owns bare
 * AgentSessions, not runtimes, so without this module extensions never cleaned up
 * (MCP connections, OAuth callback servers, timers) for the life of the process.
 *
 * The contract, used by every server-session path in session-pool.ts:
 *   - bind on create: `bindServerSessionExtensions()` right after
 *     `createAgentSession()`, before the session is tracked or handed to clients;
 *   - shut down before dispose: `shutdownAndDisposeAgentSession()` is the ONLY way
 *     a server session is disposed, so no call site can skip `session_shutdown`.
 */

/**
 * Drop pi's PROCESS-WIDE cache of loaded extension factories, so the next
 * resource load re-reads extension code from disk.
 *
 * pi caches each extension's factory at module level (keyed by cwd), and only
 * `DefaultResourceLoader.reload()` on an ALREADY-LOADED loader clears it: that is
 * how pi's own `/reload` picks up edited extension code. Wherever's `/reload`
 * rebuilds with a FRESH loader (see SessionPool.reloadSession), whose first
 * `reload()` does not clear, so without this the rebuilt agent silently runs the
 * old code. `clearExtensionCache` is not in the package's `exports` map, so it is
 * reached through the module file next to the resolved entry point; it is the
 * same module instance the SDK uses (same URL). If a future SDK moves it, reload
 * still works for settings, skills, prompts and context files, and this logs
 * why extension edits were not picked up. Pinned by test/session-reload-ws.test.ts.
 * Clearing is safe for other sessions: their next build just reloads from disk.
 */
export async function clearPiExtensionCache(): Promise<void> {
  try {
    const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
    const loader = (await import(new URL('./core/extensions/loader.js', entry).href)) as {
      clearExtensionCache?: () => void;
    };
    if (typeof loader.clearExtensionCache !== 'function') throw new Error('clearExtensionCache not found');
    loader.clearExtensionCache();
  } catch (err) {
    console.error(
      `[wherever] could not clear pi's extension cache; /reload will not pick up edited extension code: ${(err as Error).message}`,
    );
  }
}

/** Upper bound on extension `session_shutdown` handlers before we dispose anyway. */
export const EXTENSION_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * After this long without `session_start` handlers finishing, log that the bind is
 * stuck. It does NOT cancel the bind (a half-started extension set is worse than a
 * slow one); it only makes a hang visible in the journal, where it otherwise
 * shows up as a session that silently never opens.
 */
export const EXTENSION_BIND_WARN_AFTER_MS = 15_000;

type ExtensionBindings = Parameters<AgentSession['bindExtensions']>[0];

function logExtensionError(label: string, err: ExtensionError): void {
  // stderr is the wherever journal under systemd. Never swallowed: an extension
  // that fails to start is otherwise invisible from the web UI.
  console.error(
    `[wherever] extension error in ${label} (${err.extensionPath}, ${err.event}): ${err.error}` +
      (err.stack ? `\n${err.stack}` : ''),
  );
}

/**
 * The bindings a server-created session hands to `bindExtensions`. Chosen against
 * `AgentSession.bindExtensions` / `_applyExtensionBindings` in the bundled SDK:
 *
 * - `uiContext`: left UNSET. The runner then uses its no-op UI context, so
 *   `ctx.hasUI` is false and extensions take their non-interactive path. The web
 *   UI has no channel for extension dialogs (select / confirm / input / custom
 *   components); a context that pretended otherwise would make a dialog hang or
 *   silently resolve to a default the human never chose.
 * - `mode: 'print'`: the SDK's own headless default, and the only non-json mode
 *   the SDK documents as compatible with `hasUI === false` ("true in TUI and RPC
 *   modes"). Passing it explicitly records the decision instead of inheriting it.
 *   `rpc` would claim a dialog-capable client we do not have.
 * - `onError`: logs every extension error (handler throws in session_start,
 *   session_shutdown, tool hooks...) to the journal. Setting any binding also
 *   makes `AgentSession.reload()` re-emit `session_start` on reload, which it
 *   skips for a session that was never bound.
 * - `commandContextActions`: minimal and honest. Only `waitForIdle` acts (on this
 *   very AgentSession). The session-REPLACING actions (newSession, fork,
 *   switchSession) and navigateTree answer `{ cancelled: true }`: sessions here
 *   are owned by the pool, keyed by file, and swapped only through the web
 *   protocol, so an extension must not do it behind the UI's back. The SDK's
 *   unbound defaults would instead report `{ cancelled: false }` for work that
 *   never happened.
 * - `reload` is REFUSED too (logged, resolves without reloading). Not because the
 *   session could not survive it, but because `AgentSession.reload()` calls pi-ai's
 *   `resetApiProviders()`, which is PROCESS-WIDE: in a multi-session server, one
 *   session's reload would drop the custom API providers every OTHER live
 *   session's extensions registered. The web `/reload` does not use it either: it
 *   REBUILDS the agent (`SessionPool.reloadSession`). Routing an extension's
 *   `ctx.reload()` there is possible but would dispose the session whose command
 *   is still running, so it stays refused until that is designed.
 * - `shutdownHandler`: left unset. `ctx.shutdown()` from an extension must not
 *   stop the whole multi-session server.
 * - `abortHandler`: left unset, so `ctx.abort()` aborts this session's turn (the
 *   SDK default).
 */
export function serverExtensionBindings(agentSession: AgentSession, label: string): ExtensionBindings {
  const refuse = (action: string) => async () => {
    console.warn(`[wherever] extension asked to ${action} in ${label}; not supported for server sessions`);
    return { cancelled: true };
  };
  return {
    mode: 'print',
    onError: (err) => logExtensionError(label, err),
    commandContextActions: {
      waitForIdle: () => agentSession.waitForIdle(),
      reload: async () => {
        await refuse('reload (process-wide provider reset)')();
      },
      newSession: refuse('start a new session'),
      fork: refuse('fork the session'),
      navigateTree: refuse('navigate the session tree'),
      switchSession: refuse('switch session'),
    },
  };
}

/** Start the extensions of a freshly created server session (emits session_start + resources_discover). */
export async function bindServerSessionExtensions(
  agentSession: AgentSession,
  label: string,
  warnAfterMs = EXTENSION_BIND_WARN_AFTER_MS,
): Promise<void> {
  const started = Date.now();
  const watchdog = setTimeout(() => {
    console.error(
      `[wherever] extension session_start for ${label} still running after ${warnAfterMs}ms; the session cannot open until it finishes`,
    );
  }, warnAfterMs);
  try {
    await agentSession.bindExtensions(serverExtensionBindings(agentSession, label));
  } finally {
    clearTimeout(watchdog);
    const elapsed = Date.now() - started;
    if (elapsed >= warnAfterMs) console.error(`[wherever] extension session_start for ${label} finished after ${elapsed}ms`);
  }
}

/**
 * Emit `session_shutdown` to the session's extensions, then dispose it. The
 * shutdown is awaited but bounded by `timeoutMs`, so a hung extension cannot
 * block idle eviction or server shutdown. Never rejects. `reason` is `quit` for
 * every teardown except the pool's `/reload` rebuild, which says `reload` so
 * extensions can tell a restart from an exit (as they can under the pi CLI).
 */
export async function shutdownAndDisposeAgentSession(
  agentSession: AgentSession,
  label: string,
  timeoutMs = EXTENSION_SHUTDOWN_TIMEOUT_MS,
  reason: 'quit' | 'reload' = 'quit',
): Promise<void> {
  // Stop any in-flight turn FIRST, synchronously. dispose() would abort it, but
  // it runs only after the (up to timeoutMs) shutdown handlers; until then a live
  // turn would keep streaming, running tools and appending to the transcript,
  // which recreates a just-deleted session file or races a CLI that took over.
  // This mirrors dispose()'s own first step and cannot hang.
  try {
    agentSession.agent.abort();
  } catch (err) {
    console.error(`[wherever] abort failed for ${label}:`, err);
  }
  try {
    // Read the runner NOW: `reload()` replaces it, and the live one is the one
    // whose extensions hold resources.
    const runner = agentSession.extensionRunner;
    if (runner.hasHandlers('session_shutdown')) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        runner.emit({ type: 'session_shutdown', reason }).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (timedOut) {
        console.error(`[wherever] extension session_shutdown for ${label} exceeded ${timeoutMs}ms; disposing anyway`);
      }
    }
  } catch (err) {
    // emit() already routes handler throws to onError; this is the runner itself failing.
    console.error(`[wherever] session_shutdown failed for ${label}:`, err);
  }
  try {
    agentSession.dispose();
  } catch (err) {
    console.error(`[wherever] dispose failed for ${label}:`, err);
  }
}
