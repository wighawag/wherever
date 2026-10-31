import os from 'node:os';
import path from 'node:path';

/**
 * The assistant's Telegram BOT TOKEN: resolved in ADR 0007's shape, failing per
 * ADR 0018 (an optional channel's unreadable secret disables THAT channel, it
 * never fails the server).
 *
 * Resolution, first non-empty wins (never argv: there is no flag):
 *   1. `WHEREVER_TELEGRAM_TOKEN`, trimmed;
 *   2. `WHEREVER_TELEGRAM_TOKEN_FILE`, the trimmed CONTENT of that file (the
 *      sops-nix / systemd `LoadCredential=` shape);
 *   3. `assistantTelegram.token` in `config.json` (the config dir may be a
 *      `0400` secret file, ADR 0006).
 *
 * Decision (recorded in work/notes/observations/telegram-token-and-pairing-decisions.md):
 * a set token file that cannot be read, or is empty, is an ERROR that disables
 * Telegram; it does NOT fall through to the config value. ADR 0007's reasoning
 * for its own token file holds here too: the operator asked for the file, so a
 * file that did not arrive is a failed secret render to report, not a cue to
 * quietly use an older value from the config.
 *
 * Both variables are captured and DELETED from `process.env` at startup
 * (`takeTelegramTokenEnv`, beside the auth-token scrub in `parseArgs`), whether
 * or not Telegram is enabled: the agent's `bash` inherits the server's
 * environment. The FILE is read only by `resolveTelegramToken`, which the
 * server calls only while the assistant is active AND Telegram is enabled.
 */

export const TELEGRAM_TOKEN_ENV = 'WHEREVER_TELEGRAM_TOKEN';
export const TELEGRAM_TOKEN_FILE_ENV = 'WHEREVER_TELEGRAM_TOKEN_FILE';
export const TELEGRAM_TOKEN_CONFIG_KEY = 'assistantTelegram.token';

/** The two environment variables as captured at startup (before the scrub). */
export interface TelegramTokenEnv {
  token?: string;
  tokenFile?: string;
}

/** Capture both variables, then delete them from `env` (the scrub). */
export function takeTelegramTokenEnv(env: Record<string, string | undefined> = process.env): TelegramTokenEnv {
  const taken: TelegramTokenEnv = { token: env[TELEGRAM_TOKEN_ENV], tokenFile: env[TELEGRAM_TOKEN_FILE_ENV] };
  delete env[TELEGRAM_TOKEN_ENV];
  delete env[TELEGRAM_TOKEN_FILE_ENV];
  return taken;
}

export type TelegramTokenResult =
  | { ok: true; token: string; source: string; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

export interface ResolveTelegramTokenInput {
  env: TelegramTokenEnv;
  configToken?: unknown;
  /** Reads a file as UTF-8 (throws when it cannot). */
  readFile: (path: string) => string;
  homedir?: string;
}

/** Pure resolution (the file read is injected). Never logs: the caller does. */
export function resolveTelegramToken(input: ResolveTelegramTokenInput): TelegramTokenResult {
  const warnings: string[] = [];
  const blank = (name: string, v: string | undefined) => {
    if (v !== undefined && v.length > 0 && v.trim().length === 0) {
      warnings.push(`${name} is set but contains only whitespace; treating it as NOT SET (a secret meant to be rendered here did not arrive)`);
    }
  };

  const envToken = input.env.token;
  if (envToken && envToken.trim()) return { ok: true, token: envToken.trim(), source: TELEGRAM_TOKEN_ENV, warnings };
  blank(TELEGRAM_TOKEN_ENV, envToken);

  const file = input.env.tokenFile;
  if (file && file.trim()) {
    const p = expandTilde(file.trim(), input.homedir ?? os.homedir());
    let contents: string;
    try {
      contents = input.readFile(p);
    } catch (err) {
      return {
        ok: false,
        error: `${TELEGRAM_TOKEN_FILE_ENV} is set to ${p} but it could not be read (${err instanceof Error ? err.message : String(err)})`,
        warnings,
      };
    }
    const trimmed = contents.trim();
    if (!trimmed) return { ok: false, error: `${TELEGRAM_TOKEN_FILE_ENV} (${p}) is empty`, warnings };
    return { ok: true, token: trimmed, source: `${TELEGRAM_TOKEN_FILE_ENV} (${p})`, warnings };
  }
  blank(TELEGRAM_TOKEN_FILE_ENV, file);

  if (typeof input.configToken === 'string' && input.configToken.trim()) {
    return { ok: true, token: input.configToken.trim(), source: TELEGRAM_TOKEN_CONFIG_KEY, warnings };
  }

  return {
    ok: false,
    error: `no bot token: set ${TELEGRAM_TOKEN_ENV}, ${TELEGRAM_TOKEN_FILE_ENV} or ${TELEGRAM_TOKEN_CONFIG_KEY}`,
    warnings,
  };
}

function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}
