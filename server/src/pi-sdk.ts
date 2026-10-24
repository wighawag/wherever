import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Pi from '@earendil-works/pi-coding-agent';
import { getWhereverConfigDir } from './config-dir.js';
import {
  PI_SDK_PACKAGE,
  decidePiSdkVersion,
  discoverPathPi,
  effectivePiSdkConfig,
  findPiPackageFrom,
  readPiPackage,
  resolvePiSdkPath,
  type PiSdkConfig,
  type PiSdkTier,
} from './pi-sdk-policy.js';

/**
 * THE pi SDK the server runs on, chosen ONCE at startup (top-level await, so
 * every importer sees the final choice). Every RUNTIME use of the SDK in the
 * server goes through this module; types still come from the bundled package
 * (`import type`), which is what the server is compiled against.
 *
 * The choice (policy in pi-sdk-policy.ts): the bundled SDK, unless the
 * config's `piSdk.source` (or `WHEREVER_PI_SDK`) names another install that
 * the version policy accepts. Anything refused, missing or failing to load
 * falls back to the bundled SDK with a log line; the server always starts.
 *
 * Everything comes from ONE install: the SDK entry, and its built-in extension
 * list, so pi's own module-level state (provider registries, the extension
 * cache) is never split across two copies. The server's own tools build their
 * schemas with the server's `typebox`; typebox 1.x schemas are plain JSON, so
 * any SDK copy accepts them.
 */

type PiModule = typeof Pi;

export interface PiSdkInfo {
  /** Where the SDK came from: `bundled`, or a description of the install. */
  source: string;
  /** The pi-coding-agent package directory. */
  root: string;
  version: string;
  tier: PiSdkTier;
  /** How it was chosen, including why a requested install was NOT used. */
  why: string;
  /** How the built-in extensions were obtained. */
  builtinsFrom: 'install' | 'exported-factories';
}

const REQUIRED: Array<keyof PiModule> = [
  'createAgentSession',
  'ModelRuntime',
  'ModelRegistry',
  'DefaultResourceLoader',
  'SettingsManager',
  'SessionManager',
  'getAgentDir',
];

function bundledRoot(): string {
  const root = findPiPackageFrom(fileURLToPath(import.meta.url));
  if (!root) throw new Error(`cannot locate the bundled ${PI_SDK_PACKAGE}`);
  return root;
}

function readConfigPiSdk(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(getWhereverConfigDir(), 'config.json'), 'utf8'))?.piSdk;
  } catch {
    return undefined;
  }
}

function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

async function importFrom(root: string): Promise<PiModule> {
  const pj = readPiPackage(root);
  const dot = pj?.exports?.['.'];
  const rel = (typeof dot === 'string' ? dot : dot?.import ?? dot?.default) ?? pj?.main;
  if (!rel) throw new Error(`${root}/package.json names no entry point`);
  const mod = (await import(pathToFileURL(path.join(root, rel)).href)) as PiModule;
  const missing = REQUIRED.filter((k) => !(k in mod));
  if (missing.length) throw new Error(`it lacks ${missing.join(', ')}`);
  return mod;
}

/**
 * The install's OWN built-in extension list (what its CLI loads, llama.cpp
 * included). It is outside the package `exports`, so it is read from the file;
 * if that ever moves, the exported factories give MCP, codemode and tool search.
 */
async function builtinsOf(root: string, mod: PiModule): Promise<{ list: Pi.InlineExtension[]; from: PiSdkInfo['builtinsFrom'] }> {
  try {
    const list = (await import(pathToFileURL(path.join(root, 'dist', 'extensions', 'index.js')).href)).builtInExtensions;
    if (Array.isArray(list) && list.length > 0) return { list, from: 'install' };
  } catch {}
  return {
    list: [
      { name: 'codemode', factory: mod.createCodemodeExtension(), replaceable: true, builtin: true },
      { name: 'tool-search', factory: mod.createToolSearchExtension(), replaceable: true, builtin: true },
      { name: 'mcp', factory: mod.createMcpExtension(), replaceable: true, builtin: true },
    ],
    from: 'exported-factories',
  };
}

async function choose(config: PiSdkConfig): Promise<{ mod: PiModule; info: Omit<PiSdkInfo, 'builtinsFrom'> }> {
  const bundled = bundledRoot();
  const bundledVersion = readPiPackage(bundled)!.version;
  const useBundled = async (why: string) => ({
    mod: (await import('@earendil-works/pi-coding-agent')) as PiModule,
    info: { source: 'bundled', root: bundled, version: bundledVersion, tier: 'bundled' as const, why },
  });

  const source = config.source ?? 'bundled';
  if (source === 'bundled') return useBundled('the default (piSdk.source not set)');

  const found = source === 'auto' ? discoverPathPi() : resolvePiSdkPath(source);
  if (!found.root) return useBundled(`requested ${source}, but ${found.how}`);
  if (sameDir(found.root, bundled)) return useBundled(`requested ${source}, which is the bundled SDK (${found.how})`);

  const version = readPiPackage(found.root)!.version;
  const verdict = decidePiSdkVersion(version, config);
  if (!verdict.use) return useBundled(`requested ${source} (${found.how}), refused: ${verdict.why}`);
  try {
    const mod = await importFrom(found.root);
    return { mod, info: { source: found.how, root: found.root, version, tier: verdict.tier, why: verdict.why } };
  } catch (err) {
    return useBundled(`requested ${source} (${found.how}), failed to load: ${(err as Error).message}`);
  }
}

const chosen = await choose(effectivePiSdkConfig(readConfigPiSdk()));
const sdk = chosen.mod;
const builtins = await builtinsOf(chosen.info.root, sdk);

/** Which SDK this process runs on, and why. */
export const piSdkInfo: PiSdkInfo = { ...chosen.info, builtinsFrom: builtins.from };

if (piSdkInfo.tier === 'untested') {
  console.warn(`[wherever] running on an UNTESTED pi SDK ${piSdkInfo.version} (${piSdkInfo.root}): ${piSdkInfo.why}`);
} else if (piSdkInfo.tier === 'bundled' && piSdkInfo.why.startsWith('requested')) {
  console.warn(`[wherever] using the bundled pi SDK ${piSdkInfo.version}: ${piSdkInfo.why}`);
}

/**
 * pi's built-in extensions (native MCP, codemode, tool search, and llama.cpp
 * when the install provides its list) for server sessions. See
 * builtin-extensions.ts for why the server loads them itself.
 */
export const piBuiltinExtensions: readonly Pi.InlineExtension[] = builtins.list;

// Runtime values, typed as the bundled SDK's. A class is exported as a value
// AND a type of the same name, so call sites read as if importing from pi.
export const createAgentSession: PiModule['createAgentSession'] = sdk.createAgentSession;
export const getAgentDir: PiModule['getAgentDir'] = sdk.getAgentDir;
export const ModelRuntime: PiModule['ModelRuntime'] = sdk.ModelRuntime;
export type ModelRuntime = Pi.ModelRuntime;
export const ModelRegistry: PiModule['ModelRegistry'] = sdk.ModelRegistry;
export type ModelRegistry = Pi.ModelRegistry;
export const DefaultResourceLoader: PiModule['DefaultResourceLoader'] = sdk.DefaultResourceLoader;
export type DefaultResourceLoader = Pi.DefaultResourceLoader;
export const SettingsManager: PiModule['SettingsManager'] = sdk.SettingsManager;
export type SettingsManager = Pi.SettingsManager;
export const SessionManager: PiModule['SessionManager'] = sdk.SessionManager;
export type SessionManager = Pi.SessionManager;
export const AgentSession: PiModule['AgentSession'] = sdk.AgentSession;
export type AgentSession = Pi.AgentSession;
