import fs from 'node:fs';
import path from 'node:path';
import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent';

/**
 * Keep the CLI BRIDGE extension out of server-built sessions.
 *
 * The bridge (`@wherever-dev/pi`, source in `extension/`) exists to connect a
 * TERMINAL pi to this server. The server loads every extension in the user's pi
 * settings for its own sessions (see extension-lifecycle.ts), and the normal
 * install lists `npm:@wherever-dev/pi` there. Loaded in-process, the bridge's
 * session_start connected back and registered the server's own session as a CLI
 * bridge, `registerCliSession` took it over and shut the server agent down,
 * session_shutdown disconnected the bridge, `unregisterCliSession` reloaded the
 * session, and the loop repeated several times a second, aborting every turn with
 * "CLI terminal disconnected". Nothing the bridge offers is needed in-process:
 * the server registers its own attach_file / say tools and conversation-mode hook.
 */

/** The bridge's npm package name, the `name` in `extension/package.json`. */
export const CLI_BRIDGE_PACKAGE_NAME = '@wherever-dev/pi';

/**
 * `name` of the nearest `package.json` at or above `startDir` that HAS a name,
 * or undefined. A name-less package.json (a dual-build `dist/package.json` that
 * only says `{"type":"module"}`) marks no package, so the walk goes past it.
 */
function nearestPackageName(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const name = (JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: unknown })?.name;
        if (typeof name === 'string' && name) return name;
      } catch {
        // Unreadable or invalid: not a package boundary we can use; keep going.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * THE IDENTIFICATION RULE: an extension is the CLI bridge exactly when the
 * NEAREST NAMED `package.json` enclosing its resolved entry file (symlinks
 * resolved) has `"name": "@wherever-dev/pi"`. A package.json without a `name`
 * is skipped, so a dual-build `dist/package.json` cannot hide the real one.
 *
 * - It follows the package, not how it was listed: `npm:@wherever-dev/pi`
 *   (…/node_modules/@wherever-dev/pi/dist/index.js), a git or local-path package,
 *   a direct file path to `extension/dist/index.js`, or the TypeScript source used
 *   in development all resolve inside that package.
 * - It never matches on a substring such as "wherever": an unrelated extension
 *   in a `wherever-*` folder, or one whose package is merely named like us, has
 *   its own nearest package.json with a different name and keeps loading.
 * - Only the NEAREST named package.json counts, so an extension that happens to
 *   sit somewhere below the bridge package (it would carry its own named
 *   package.json) is not swept up, and an extension with no package.json at all
 *   is not the bridge.
 * - Inline extensions (`<inline…>` paths, the server's own factories) and paths
 *   that cannot be resolved on disk are never the bridge.
 */
export function isCliBridgeExtensionPath(extensionPath: string): boolean {
  if (!extensionPath || extensionPath.startsWith('<')) return false;
  let resolved: string;
  try {
    resolved = fs.realpathSync(extensionPath);
  } catch {
    return false;
  }
  return nearestPackageName(path.dirname(resolved)) === CLI_BRIDGE_PACKAGE_NAME;
}

let loggedExclusion = false;

/**
 * `DefaultResourceLoader` `extensionsOverride` for server sessions: the loaded
 * set minus the CLI bridge (see `isCliBridgeExtensionPath` for the rule).
 * Every other extension, and every load error, passes through untouched, so they
 * keep the full lifecycle (session_start / session_shutdown).
 *
 * The bridge's factory has already RUN by the time this sees the result (pi
 * loads, then offers the override); that is harmless because the bridge only
 * registers handlers, flags, commands and tools at load and connects on
 * session_start, which it never receives here.
 */
export function withoutCliBridgeExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  // `resolvedPath` is always set by pi: absolute for files (resolved against the
  // session cwd), `<inline…>` for factories. `path` may be relative, so never use it.
  const extensions = base.extensions.filter((ext) => !isCliBridgeExtensionPath(ext.resolvedPath));
  if (extensions.length === base.extensions.length) return base;
  if (!loggedExclusion) {
    loggedExclusion = true;
    console.log(
      `[wherever] not loading the CLI bridge extension (${CLI_BRIDGE_PACKAGE_NAME}) in server sessions; it only runs inside a terminal pi`,
    );
  }
  return { ...base, extensions };
}
