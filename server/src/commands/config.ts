import fs from 'node:fs';
import path from 'node:path';
import { defaultWhereverConfig, getWhereverConfigPath } from '../config-dir.js';

/**
 * `wherever config init|show` (ADR 0022). Reading the config never writes it,
 * so these are the explicit ways to get a starter file and to see what the
 * server will actually use. Both resolve the path exactly as the server does
 * (`WHEREVER_CONFIG_DIR`, else `~/.wherever`).
 *
 * Exit codes: 0 on success; 1 when `init` finds a file already there (or cannot
 * write), when `show` finds a file that is not valid JSON, and for a bare or
 * unknown subcommand (usage goes to stderr).
 */

export const CONFIG_USAGE = `Usage:
  wherever config init   Write a starter config.json (the built-in defaults)
                         to the config dir. Refuses to overwrite one.
  wherever config show   Print the config path, whether the file exists, and
                         the effective config (credential values redacted).

The config dir is WHEREVER_CONFIG_DIR, else ~/.wherever. config.json is
optional: without it the server uses the built-in defaults.`;

/** Placeholder printed instead of a credential value. */
export const REDACTED = '<redacted>';

/**
 * A key whose value is a credential: any key whose name contains `token`,
 * `secret`, `password`, `passphrase`, `apikey`/`api_key`/`api-key` or
 * `privatekey`/`private_key`/`private-key` (case-insensitive), at any depth.
 * Covers `assistantTelegram.token` (the Telegram bot token) and `remote.token`.
 */
const CREDENTIAL_KEY = /token|secret|password|passphrase|api[-_]?key|private[-_]?key/i;

/**
 * A copy of `value` with every credential value replaced by {@link REDACTED}.
 * A credential key holding an array has each primitive element redacted; an
 * object (anywhere) is walked, its own keys judged by the same rule, so the
 * structure stays visible. An empty string or null is left as is: it reveals
 * nothing, and showing it tells the user the key is unset.
 */
export function redactConfig(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v, key));
  if (isContainer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactConfig(v, k);
    return out;
  }
  return key && CREDENTIAL_KEY.test(key) ? redactLeaf(value) : value;
}

function isContainer(v: unknown): boolean {
  return typeof v === 'object' && v !== null;
}

function redactLeaf(v: unknown): unknown {
  return v === null || v === undefined || v === '' ? v : REDACTED;
}

/** `wherever config init`: write the defaults, never over an existing file. Returns the exit code. */
export function runConfigInit(): number {
  const file = getWhereverConfigPath();
  if (fs.existsSync(file)) {
    console.error(`wherever: ${file} already exists; not overwriting it.`);
    console.error('Edit it directly, or remove it first to start from the defaults.');
    return 1;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 'wx': fail rather than clobber if the file appeared since the check.
    fs.writeFileSync(file, JSON.stringify(defaultWhereverConfig(), null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    console.error(`wherever: could not write ${file}: ${(err as Error).message}`);
    return 1;
  }
  console.log(`Wrote ${file} (the built-in defaults).`);
  return 0;
}

/** `wherever config show`: path, existence, effective config (redacted). Returns the exit code. */
export function runConfigShow(): number {
  const file = getWhereverConfigPath();
  let effective: unknown;
  if (!fs.existsSync(file)) {
    console.log(`config: ${file} (not found, using built-in defaults)`);
    console.log("Run 'wherever config init' to write a starter file.");
    effective = defaultWhereverConfig();
  } else {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`config: ${file} (found, but could not be read: ${(err as Error).message})`);
      return 1;
    }
    try {
      effective = JSON.parse(raw);
    } catch (err) {
      console.error(`config: ${file} (found, but not valid JSON: ${(err as Error).message})`);
      console.error('The server would log a parse error and run with an empty config.');
      return 1;
    }
    console.log(`config: ${file} (found)`);
  }
  console.log(`Effective config (credential values shown as "${REDACTED}"):`);
  console.log(JSON.stringify(redactConfig(effective), null, 2));
  return 0;
}

/** Dispatch `wherever config <sub>`. Returns the exit code. */
export function runConfigCommand(args: string[]): number {
  switch (args[0]) {
    case 'init':
      return runConfigInit();
    case 'show':
      return runConfigShow();
    case 'help':
    case '--help':
    case '-h':
      console.log(CONFIG_USAGE);
      return 0;
    case undefined:
      console.error(CONFIG_USAGE);
      return 1;
    default:
      console.error(`Unknown config command: ${args[0]}\n`);
      console.error(CONFIG_USAGE);
      return 1;
  }
}
