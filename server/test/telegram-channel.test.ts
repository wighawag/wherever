import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChannelContext, ChannelUserMessage } from '../src/assistant-channels.ts';
import { ALREADY_PAIRED_REPLY, PAIRED_REPLY } from '../src/telegram-pairing.ts';
import { TELEGRAM_OFFSET_FILE, TELEGRAM_PAIRING_FILE, TelegramChannel, type TelegramChannelOptions } from '../src/telegram-channel.ts';
import { FakeBotApi } from './fake-bot-api.ts';

/**
 * The Telegram poller against a fake Bot API (mocked at the HTTP boundary) and a
 * temp state dir: pairing by one-time code, ignoring strangers, refusing
 * `/start` / `/pair` once paired, re-pair, the configured id winning, the
 * polling offset surviving a restart, and a rejected token stopping the poller.
 */

const TOKEN = '123456:secret-token';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function stateDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-tg-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

function setup(dir: string, api: FakeBotApi, opts: Partial<TelegramChannelOptions> = {}) {
  const received: ChannelUserMessage[] = [];
  const ctx: ChannelContext = {
    onUserMessage: async (m) => {
      received.push(m);
      return { accepted: true };
    },
  };
  let codes = 0;
  const channel = new TelegramChannel({
    token: TOKEN,
    stateDir: dir,
    configuredUserId: null,
    fetch: api.fetch,
    retryDelayMs: () => 10,
    newCode: () => `CODE000${++codes}`,
    log: quiet,
    ...opts,
  });
  cleanups.push(() => channel.stop());
  return { channel, ctx, received };
}

async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait until the fake has seen every queued update confirmed (polled past it). */
async function drained(api: FakeBotApi): Promise<void> {
  await until(() => api.pendingIds().length === 0 && api.of('getUpdates').length > 0);
  const n = api.of('getUpdates').length;
  await until(() => api.of('getUpdates').length > n);
}

const sent = (api: FakeBotApi) => api.of('sendMessage').map((c) => ({ chat: c.params.chat_id, text: c.params.text }));

describe('TelegramChannel', () => {
  it('pairs only with the current code; strangers and wrong codes are ignored, not answered', async () => {
    const dir = stateDir();
    const api = new FakeBotApi(30);
    const { channel, ctx, received } = setup(dir, api);
    channel.start(ctx);
    await until(() => channel.status().state === 'unpaired' && channel.status().bot === '@wherever_test_bot');
    const st = channel.status();
    expect(st).toMatchObject({ state: 'unpaired', code: 'CODE0001' });

    api.message(7, '/start');
    api.message(7, '/pair WRONG');
    api.message(7, 'hello');
    await drained(api);
    expect(sent(api)).toEqual([]);
    expect(received).toEqual([]);
    expect(fs.existsSync(path.join(dir, TELEGRAM_PAIRING_FILE))).toBe(false);

    api.message(7, '/pair code0001', { username: 'me' });
    await until(() => channel.status().state === 'paired');
    expect(channel.status()).toMatchObject({ state: 'paired', user: { id: '7', name: '@me', source: 'pairing' } });
    await until(() => sent(api).length === 1);
    expect(sent(api)).toEqual([{ chat: 7, text: PAIRED_REPLY }]);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, TELEGRAM_PAIRING_FILE), 'utf8'));
    expect(stored).toMatchObject({ userId: '7', chatId: '7', name: '@me' });
    expect(fs.statSync(path.join(dir, TELEGRAM_PAIRING_FILE)).mode & 0o777).toBe(0o600);

    // Paired: the user's messages are forwarded; /start and /pair are refused; others ignored.
    api.message(8, '/pair CODE0001');
    api.message(8, 'let me in');
    api.message(7, '/start');
    api.message(7, '/pair CODE0001');
    api.message(7, 'what is up');
    await drained(api);
    expect(sent(api)).toEqual([
      { chat: 7, text: PAIRED_REPLY },
      { chat: 7, text: ALREADY_PAIRED_REPLY },
      { chat: 7, text: ALREADY_PAIRED_REPLY },
    ]);
    expect(received).toEqual([{ channel: 'telegram', text: 'what is up', senderId: '7' }]);
  });

  it('re-pair forgets the stored pairing and issues a new code', async () => {
    const dir = stateDir();
    const api = new FakeBotApi(30);
    const { channel, ctx, received } = setup(dir, api);
    channel.start(ctx);
    await until(() => channel.status().state === 'unpaired');
    api.message(7, '/pair CODE0001');
    await until(() => channel.status().state === 'paired');

    expect(channel.repair()).toEqual({ ok: true });
    expect(channel.status()).toMatchObject({ state: 'unpaired', code: 'CODE0002' });
    expect(fs.existsSync(path.join(dir, TELEGRAM_PAIRING_FILE))).toBe(false);

    api.message(7, 'still there?');
    api.message(9, '/pair CODE0001');
    await drained(api);
    expect(received).toEqual([]);
    expect(channel.status().state).toBe('unpaired');
    api.message(9, '/pair CODE0002');
    await until(() => channel.status().state === 'paired');
    expect(channel.status()).toMatchObject({ user: { id: '9' } });
  });

  it('a stored pairing is loaded at start; the configured user id wins over it and cannot be re-paired', async () => {
    const dir = stateDir();
    fs.writeFileSync(path.join(dir, TELEGRAM_PAIRING_FILE), JSON.stringify({ userId: '7', chatId: '7' }));
    const api = new FakeBotApi(30);
    const a = setup(dir, api);
    a.channel.start(a.ctx);
    expect(a.channel.status()).toMatchObject({ state: 'paired', user: { id: '7', source: 'pairing' } });
    await a.channel.stop();

    const b = setup(dir, api, { configuredUserId: '42' });
    b.channel.start(b.ctx);
    expect(b.channel.status()).toMatchObject({ state: 'paired', user: { id: '42', source: 'config' } });
    api.message(7, 'hi from the stored user');
    api.message(42, 'hi from the configured user');
    await drained(api);
    expect(b.received.map((m) => m.text)).toEqual(['hi from the configured user']);
    expect(b.channel.repair().ok).toBe(false);
  });

  it('the polling offset survives a restart: nothing replayed, nothing lost', async () => {
    const dir = stateDir();
    fs.writeFileSync(path.join(dir, TELEGRAM_PAIRING_FILE), JSON.stringify({ userId: '7', chatId: '7' }));
    const api = new FakeBotApi(30);
    const first = setup(dir, api);
    first.channel.start(first.ctx);
    const one = api.message(7, 'one');
    await until(() => first.received.length === 1);
    await drained(api);
    await first.channel.stop();
    expect(JSON.parse(fs.readFileSync(path.join(dir, TELEGRAM_OFFSET_FILE), 'utf8'))).toEqual({ botId: '123456', offset: one + 1 });
    expect(fs.statSync(path.join(dir, TELEGRAM_OFFSET_FILE)).mode & 0o777).toBe(0o600);

    // Sent while the server is down.
    api.message(7, 'two');
    const second = setup(dir, api);
    second.channel.start(second.ctx);
    await until(() => second.received.length === 1);
    await drained(api);
    expect(second.received.map((m) => m.text)).toEqual(['two']);
    expect(api.of('getUpdates').filter((c) => c.params.offset === undefined)).toHaveLength(1);
  });

  it('an offset left by ANOTHER bot is ignored', async () => {
    const dir = stateDir();
    fs.writeFileSync(path.join(dir, TELEGRAM_OFFSET_FILE), JSON.stringify({ botId: '999', offset: 5_000_000 }));
    const api = new FakeBotApi(30);
    const { channel, ctx } = setup(dir, api);
    channel.start(ctx);
    await until(() => api.of('getUpdates').length > 0);
    expect(api.of('getUpdates')[0]!.params.offset).toBeUndefined();
  });

  it('nothing is written while unpaired and nobody pairs (only the offset, once updates arrive)', async () => {
    const dir = stateDir();
    const api = new FakeBotApi(30);
    const { channel, ctx } = setup(dir, api);
    channel.start(ctx);
    await until(() => api.of('getUpdates').length > 2);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a token Telegram rejects stops polling and reports the error, without the token', async () => {
    const dir = stateDir();
    const api = new FakeBotApi(30);
    api.validTokens.add('1:other');
    const errors: string[] = [];
    const { channel, ctx } = setup(dir, api, { log: { ...quiet, error: (m: string) => errors.push(m) } });
    channel.start(ctx);
    await until(() => channel.status().state === 'error');
    const calls = api.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(api.calls.length).toBe(calls);
    expect(errors.join('\n')).toMatch(/DISABLED/);
    expect(JSON.stringify(channel.status()) + errors.join('\n')).not.toContain('secret-token');
  });

  it('a transient failure is retried', async () => {
    const dir = stateDir();
    const api = new FakeBotApi(30);
    let failures = 2;
    const flaky: typeof api.fetch = async (url, init) => {
      if (url.endsWith('/getUpdates') && failures-- > 0) throw new Error(`fetch failed for ${url}`);
      return api.fetch(url, init);
    };
    const warns: string[] = [];
    const { channel, ctx } = setup(dir, api, { fetch: flaky, log: { ...quiet, warn: (m: string) => warns.push(m) } });
    channel.start(ctx);
    await until(() => api.of('getUpdates').length > 0);
    expect(warns.join('\n')).toMatch(/retrying/);
    expect(warns.join('\n')).not.toContain('secret-token');
  });
});
