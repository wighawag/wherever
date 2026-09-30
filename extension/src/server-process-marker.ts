import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Detect that this extension is running INSIDE a wherever server process.
 *
 * The wherever server hosts pi sessions in-process and, since 0.18, loads the
 * extensions in the user's pi settings for them. If this bridge is among them,
 * its session_start would connect back to that same server and register the
 * server's own session as a CLI bridge; the server treats that as a terminal
 * taking over, shuts its agent down, the bridge disconnects, the server reloads
 * the session, and the loop repeats several times a second. Current servers
 * filter this package out of their sessions; this check is defence in depth,
 * mainly for servers that predate that filter.
 *
 * Two signals, either one is enough:
 *
 * 1. The MARKER: servers with the fix set
 *    `globalThis[Symbol.for("wherever-dev.server-process")] = true` at startup
 *    (see server/src/server-process-marker.ts). Deliberately NOT an environment
 *    variable: env vars are inherited by every child a session spawns, so a real
 *    `pi` launched from a wherever terminal or a `!command` would read it and turn
 *    its own bridge off. A `globalThis` property never leaves the process.
 *    `Symbol.for` keys the global symbol registry, so both sides agree on the key
 *    without importing each other. Keep the key string in sync with the server.
 *
 * 2. The ENTRY SCRIPT, for servers OLDER than the marker (which never set it):
 *    the process was started from a file of the `wherever-dev` package (its
 *    `wherever` bin, or `src/index.ts` under tsx in development), i.e. the
 *    nearest NAMED `package.json` enclosing the realpath of `process.argv[1]` is
 *    `wherever-dev`. Exact name, never a substring. It cannot leak either: a
 *    child `pi` has pi's own entry script.
 */
export const WHEREVER_SERVER_PROCESS_MARKER = Symbol.for("wherever-dev.server-process");

/** The server's npm package name. */
const WHEREVER_SERVER_PACKAGE_NAME = "wherever-dev";

function entryScriptIsWhereverServer(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    let dir = path.dirname(fs.realpathSync(entry));
    for (;;) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        let name: unknown;
        try {
          name = (JSON.parse(fs.readFileSync(candidate, "utf-8")) as { name?: unknown })?.name;
        } catch {
          name = undefined;
        }
        // A name-less package.json (e.g. a dual-build dist/package.json) marks no
        // package: keep walking up to the real one.
        if (typeof name === "string" && name) return name === WHEREVER_SERVER_PACKAGE_NAME;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  } catch {
    return false;
  }
}

/** True when the current process is a wherever server (either signal above). */
export function isInsideWhereverServer(): boolean {
  if ((globalThis as Record<symbol, unknown>)[WHEREVER_SERVER_PROCESS_MARKER] === true) return true;
  return entryScriptIsWhereverServer();
}
