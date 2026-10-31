import { describe, it, expect } from 'vitest';
import {
  TELEGRAM_TOKEN_ENV,
  TELEGRAM_TOKEN_FILE_ENV,
  resolveTelegramToken,
  takeTelegramTokenEnv,
} from '../src/telegram-token.ts';

/**
 * The Telegram bot token resolver (ADR 0007's shape, ADR 0018's non-fatal
 * rule): pure, with the file read injected, so the order and every refusal is
 * checked without touching a real file.
 */

const noFile = (p: string): string => {
  throw new Error(`ENOENT: no such file, open '${p}'`);
};

describe('takeTelegramTokenEnv', () => {
  it('captures both variables and deletes them from the environment', () => {
    const env: Record<string, string | undefined> = {
      [TELEGRAM_TOKEN_ENV]: 'abc',
      [TELEGRAM_TOKEN_FILE_ENV]: '/run/secrets/tg',
      OTHER: 'kept',
    };
    const taken = takeTelegramTokenEnv(env);
    expect(taken).toEqual({ token: 'abc', tokenFile: '/run/secrets/tg' });
    expect(TELEGRAM_TOKEN_ENV in env).toBe(false);
    expect(TELEGRAM_TOKEN_FILE_ENV in env).toBe(false);
    expect(env.OTHER).toBe('kept');
  });

  it('is harmless when neither is set', () => {
    const env: Record<string, string | undefined> = {};
    expect(takeTelegramTokenEnv(env)).toEqual({ token: undefined, tokenFile: undefined });
  });
});

describe('resolveTelegramToken', () => {
  it('prefers the environment variable (trimmed) over the file and the config', () => {
    let read = false;
    const r = resolveTelegramToken({
      env: { token: '  env-token\n', tokenFile: '/x' },
      configToken: 'config-token',
      readFile: () => {
        read = true;
        return 'file-token';
      },
    });
    expect(r).toMatchObject({ ok: true, token: 'env-token', source: TELEGRAM_TOKEN_ENV });
    expect(read).toBe(false);
  });

  it('then the token FILE, its trimmed content, over the config', () => {
    const r = resolveTelegramToken({
      env: { tokenFile: '/run/secrets/tg' },
      configToken: 'config-token',
      readFile: (p) => (p === '/run/secrets/tg' ? 'file-token\n' : noFile(p)),
    });
    expect(r).toMatchObject({ ok: true, token: 'file-token', source: `${TELEGRAM_TOKEN_FILE_ENV} (/run/secrets/tg)` });
  });

  it('then the config value', () => {
    const r = resolveTelegramToken({ env: {}, configToken: ' cfg ', readFile: noFile });
    expect(r).toMatchObject({ ok: true, token: 'cfg', source: 'assistantTelegram.token' });
  });

  it('an unreadable token file is an error, and does NOT fall through to the config', () => {
    const r = resolveTelegramToken({ env: { tokenFile: '/missing' }, configToken: 'cfg', readFile: noFile });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/WHEREVER_TELEGRAM_TOKEN_FILE is set to \/missing but it could not be read/);
  });

  it('an empty token file is an error', () => {
    const r = resolveTelegramToken({ env: { tokenFile: '/empty' }, readFile: () => '\n  \n' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/is empty/);
  });

  it('a blank env variable is treated as unset, with a warning', () => {
    const r = resolveTelegramToken({ env: { token: '   ' }, configToken: 'cfg', readFile: noFile });
    expect(r).toMatchObject({ ok: true, token: 'cfg' });
    if (r.ok) expect(r.warnings.join('\n')).toMatch(/WHEREVER_TELEGRAM_TOKEN is set but contains only whitespace/);
  });

  it('no source at all is an error naming every source', () => {
    const r = resolveTelegramToken({ env: {}, readFile: noFile });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/WHEREVER_TELEGRAM_TOKEN.*WHEREVER_TELEGRAM_TOKEN_FILE.*assistantTelegram\.token/s);
  });

  it('expands a leading ~ in the file path', () => {
    let asked = '';
    resolveTelegramToken({
      env: { tokenFile: '~/tg' },
      readFile: (p) => {
        asked = p;
        return 't';
      },
      homedir: '/home/u',
    });
    expect(asked).toBe('/home/u/tg');
  });
});
