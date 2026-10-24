import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import semver from 'semver';

/**
 * WHICH pi SDK the server runs its sessions on: the pure half (no SDK is loaded
 * here). `pi-sdk.ts` applies it once at startup.
 *
 * By default the server runs on the SDK it bundles (the one its tests ran
 * against). A user can instead point it at another install, typically the pi
 * they run in a terminal, so web and terminal sessions run the same pi on the
 * same session files and the same `mcp.json`. A version policy decides whether
 * that install is used, in three tiers:
 *
 *   - `tested`: inside TESTED_PI_RANGE, which CI runs the suite against. Used.
 *   - `untested`: at or above PI_SDK_FLOOR but outside the tested range.
 *     Refused unless the user opts in, with `allowUntested: true` (any such
 *     version) or their own `accept` range (narrower); then used, with a
 *     warning. pi does not follow semver strictly (minor releases have carried
 *     breaking SDK changes), so an untested version can fail in ways the tests
 *     would have caught.
 *   - `incompatible`: below PI_SDK_FLOOR, where APIs the server needs do not
 *     exist (`ModelRuntime`, the built-in MCP extensions). Always refused.
 *
 * A refusal never stops the server: it falls back to the bundled SDK and logs
 * why.
 */

/** The pi versions CI runs the server suite against. */
export const TESTED_PI_RANGE = '>=1.4.0 <1.5.0';
/** The oldest pi the server can run on at all (opt-in only below TESTED_PI_RANGE). */
export const PI_SDK_FLOOR = '1.0.0';

export const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

/** `piSdk` in the wherever config.json. */
export interface PiSdkConfig {
  /**
   * `bundled` (default): the SDK shipped with wherever.
   * `auto`: the SDK of the `pi` on the server's PATH (a symlinked bin or a
   * shell wrapper such as Nix's are both followed).
   * Anything else: a path to a pi-coding-agent package directory, or to a
   * directory whose node_modules holds one (e.g. a global npm prefix's lib).
   */
  source?: string;
  /** Use an untested version (at or above the floor) instead of refusing it. */
  allowUntested?: boolean;
  /** Use an untested version (at or above the floor) when it satisfies this semver range. */
  accept?: string;
}

export type PiSdkTier = 'bundled' | 'tested' | 'untested' | 'incompatible';

export interface PiSdkVerdict {
  use: boolean;
  tier: PiSdkTier;
  why: string;
}

/** The tier of `version` under `config`, and whether it is used. */
export function decidePiSdkVersion(version: string, config: Pick<PiSdkConfig, 'allowUntested' | 'accept'> = {}): PiSdkVerdict {
  if (!semver.valid(version)) return { use: false, tier: 'incompatible', why: `"${version}" is not a version` };
  if (semver.lt(version, PI_SDK_FLOOR)) {
    return { use: false, tier: 'incompatible', why: `${version} is older than ${PI_SDK_FLOOR}, the oldest pi wherever can run on` };
  }
  if (semver.satisfies(version, TESTED_PI_RANGE)) return { use: true, tier: 'tested', why: `${version} is in the tested range ${TESTED_PI_RANGE}` };
  if (config.accept) {
    if (!semver.validRange(config.accept)) {
      return { use: false, tier: 'untested', why: `${version} is untested and piSdk.accept "${config.accept}" is not a valid semver range` };
    }
    if (semver.satisfies(version, config.accept, { includePrerelease: true })) {
      return { use: true, tier: 'untested', why: `${version} is untested (tested: ${TESTED_PI_RANGE}), accepted by piSdk.accept "${config.accept}"` };
    }
  }
  if (config.allowUntested) {
    return { use: true, tier: 'untested', why: `${version} is untested (tested: ${TESTED_PI_RANGE}), allowed by piSdk.allowUntested` };
  }
  return {
    use: false,
    tier: 'untested',
    why: `${version} is untested (tested: ${TESTED_PI_RANGE}); set piSdk.allowUntested or a piSdk.accept range to use it anyway`,
  };
}

/**
 * The effective config: config.json's `piSdk`, overridden field by field by
 * `WHEREVER_PI_SDK` (source), `WHEREVER_PI_SDK_ACCEPT` and
 * `WHEREVER_PI_SDK_ALLOW_UNTESTED` (`1`/`true`), which is how tests and CI
 * pick an SDK without writing a config file.
 */
export function effectivePiSdkConfig(fromFile: unknown, env: NodeJS.ProcessEnv = process.env): PiSdkConfig {
  const file = fromFile && typeof fromFile === 'object' ? (fromFile as Record<string, unknown>) : {};
  const out: PiSdkConfig = {
    source: typeof file.source === 'string' && file.source.trim() ? file.source.trim() : undefined,
    allowUntested: file.allowUntested === true,
    accept: typeof file.accept === 'string' && file.accept.trim() ? file.accept.trim() : undefined,
  };
  if (env.WHEREVER_PI_SDK?.trim()) out.source = env.WHEREVER_PI_SDK.trim();
  if (env.WHEREVER_PI_SDK_ACCEPT?.trim()) out.accept = env.WHEREVER_PI_SDK_ACCEPT.trim();
  if (env.WHEREVER_PI_SDK_ALLOW_UNTESTED !== undefined) out.allowUntested = /^(1|true|yes)$/i.test(env.WHEREVER_PI_SDK_ALLOW_UNTESTED.trim());
  return out;
}

/** The package.json of a pi-coding-agent package directory, or undefined if `dir` is not one. */
export function readPiPackage(dir: string): { name: string; version: string; exports?: any; main?: string } | undefined {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pj?.name === PI_SDK_PACKAGE ? pj : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pi-coding-agent package directory Node would resolve from `fromFile`
 * (the bundled SDK when called from the server's own modules). Walks Node's
 * module search paths rather than resolving the specifier: the package's
 * `exports` offers neither `package.json` nor a `require` condition, and
 * `import.meta.resolve` is not available under every loader (vitest).
 */
export function findPiPackageFrom(fromFile: string): string | undefined {
  for (const dir of createRequire(fromFile).resolve.paths(PI_SDK_PACKAGE) ?? []) {
    const candidate = path.join(dir, PI_SDK_PACKAGE);
    if (readPiPackage(candidate)) return candidate;
  }
  return undefined;
}

/** The pi-coding-agent package directory enclosing `file`, if any. */
export function piPackageDirOf(file: string): string | undefined {
  let dir = path.dirname(file);
  while (true) {
    if (readPiPackage(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The pi-coding-agent package behind the `pi` on PATH. Follows symlinks (npm
 * global bins), then, for a shell wrapper (Nix `makeWrapper`, version-manager
 * shims), reads the wrapper's head for the pi-coding-agent script it execs.
 * A standalone pi binary has no package to load: undefined, with the reason.
 */
export function discoverPathPi(env: NodeJS.ProcessEnv = process.env): { root?: string; how: string } {
  let bin: string;
  try {
    bin = execFileSync('/bin/sh', ['-c', 'command -v pi'], { encoding: 'utf8', env, timeout: 5_000 }).trim();
  } catch {
    return { how: 'no `pi` on PATH' };
  }
  if (!bin) return { how: 'no `pi` on PATH' };
  let real: string;
  try {
    real = fs.realpathSync(bin);
  } catch (err) {
    return { how: `${bin}: ${(err as Error).message}` };
  }
  const direct = piPackageDirOf(real);
  if (direct) return { root: direct, how: `${bin} -> ${real}` };
  let head = '';
  try {
    const fd = fs.openSync(real, 'r');
    try {
      const buf = Buffer.alloc(8192);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  // A text wrapper names a file inside the package; a binary has no such path.
  for (const m of head.matchAll(/(\/[^\s"':]*\/node_modules\/@earendil-works\/pi-coding-agent)\/[^\s"':]+/g)) {
    if (readPiPackage(m[1])) return { root: m[1], how: `${bin} -> ${real}, a wrapper running ${m[0]}` };
  }
  return { how: `${bin} -> ${real} is not a node package and runs none (a standalone pi binary?)` };
}

/** The package directory a non-`auto`, non-`bundled` source names, or why there is none. */
export function resolvePiSdkPath(source: string, home = process.env.HOME ?? ''): { root?: string; how: string } {
  const expanded = source.startsWith('~/') ? path.join(home, source.slice(2)) : source;
  const abs = path.resolve(expanded);
  for (const candidate of [abs, path.join(abs, 'node_modules', PI_SDK_PACKAGE), path.join(abs, 'lib', 'node_modules', PI_SDK_PACKAGE)]) {
    if (readPiPackage(candidate)) return { root: candidate, how: `piSdk.source ${source}` };
  }
  return { how: `piSdk.source ${source}: no ${PI_SDK_PACKAGE} package there` };
}
