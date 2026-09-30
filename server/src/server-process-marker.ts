/**
 * Process-wide marker: "this process is a wherever server hosting pi sessions".
 *
 * Read by the CLI bridge extension (`@wherever-dev/pi`, extension/src/index.ts)
 * so that, if it is ever loaded inside the server anyway (a future load path that
 * bypasses the `extensionsOverride` filter in cli-bridge-extension.ts), its
 * session_start does not connect back to this server and register the server's
 * own session as a CLI bridge. Servers OLDER than this marker are recognised by
 * the extension from its entry script instead (see the extension's copy).
 *
 * Why a `globalThis` symbol and not an environment variable such as
 * `WHEREVER_SERVER=1`: an env var is inherited by every child process a session
 * spawns (the bash tool, `!commands`, terminals), so a real `pi` started from
 * there would read it and wrongly disable its bridge. A property on `globalThis`
 * lives only in this process's JS heap and cannot leak into a child; stripping an
 * env var from every spawn site instead would be a rule every future spawn site
 * has to remember, with pi's own bash tool among them. `Symbol.for` (the global
 * symbol registry) gives the server and the extension the same key without
 * importing each other, across module copies and loaders (pi loads extensions
 * through its own module loader, in this same process and realm).
 *
 * The key string is a contract with the extension: keep it in sync with
 * `WHEREVER_SERVER_PROCESS_MARKER` in extension/src/server-process-marker.ts.
 */
export const WHEREVER_SERVER_PROCESS_MARKER = Symbol.for('wherever-dev.server-process');

/** Mark this process as a wherever server. Idempotent. */
export function markWhereverServerProcess(): void {
  (globalThis as Record<symbol, unknown>)[WHEREVER_SERVER_PROCESS_MARKER] = true;
}
