import os from 'node:os';
import path from 'node:path';

/**
 * Directory holding `config.json`. `WHEREVER_CONFIG_DIR` overrides the default
 * `~/.wherever` so a test server can run in FULL isolation (ADR 0001): without
 * it, an isolated harness still reads the developer's real config, so e.g. a
 * personal `sessions.ignore: ["/tmp/**"]` silently hid the harness's own
 * temp-dir sessions from /sessions.
 *
 * Its own module (re-exported by session-pool.ts) because `pi-sdk.ts` reads
 * the config BEFORE session-pool.ts can load: session-pool imports the SDK
 * that pi-sdk.ts picks.
 */
export function getWhereverConfigDir(): string {
  const override = process.env.WHEREVER_CONFIG_DIR;
  return override && override.trim() ? path.resolve(override.trim()) : path.join(os.homedir(), '.wherever');
}
