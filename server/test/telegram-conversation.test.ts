import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChannelContext, ChannelInboundHooks, ChannelUserMessage } from '../src/assistant-channels.ts';
import {
  NOTHING_RUNNING_REPLY,
  RESET_REPLY,
  SHELL_REFUSAL_REPLY,
  STEER_NOTE,
  STEER_REACTION,
  STOPPED_REPLY,
  TELEGRAM_PAIRING_FILE,
  TelegramChannel,
  type TelegramChannelOptions,
} from '../src/telegram-channel.ts';
import { FakeBotApi } from './fake-bot-api.ts';

/**
 * The Telegram CONVERSATION (task `telegram-conversation`) on the channel, with
 * a CONTROLLER FAKE behind the channel context and the Bot API mocked at the
 * HTTP boundary: start vs steer (and the steer marker with its fallback note),
 * `!` refused, `/new` / `/reset` reset, `stop` aborts, other `/` text passed
 * through untouched, `assistant_notify` as its own `🔔` message, dropped
 * messages reported, and replies delivered to the paired chat. Temp state dir.
 */

const TOKEN = '123456:secret-token';
const USER = 7;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The controller fake: `busy` decides start vs steer; a started turn's send stays pending until `endTurn()`. */
class FakeController {
  busy = false;
  received: Array<{ text: string; channel: string }> = [];
  resets = 0;
  aborts = 0;
  resetError: string | null = null;
  private ends: Array<() => void> = [];
  ctx(): ChannelContext {
    return {
      onUserMessage: (m: ChannelUserMessage, hooks?: ChannelInboundHooks) => {
        this.received.push({ text: m.text, channel: m.channel });
        const steered = this.busy;
        hooks?.onDispatched?.({ steered });
        this.busy = true;
        if (steered) return Promise.resolve({ accepted: true as const });
        return new Promise((resolve) => this.ends.push(() => resolve({ accepted: true })));
      },
      resetSession: async () => {
        this.resets += 1;
        return this.resetError ? { ok: false as const, error: this.resetError } : { ok: true as const };
      },
      abortTurn: async () => {
        this.aborts += 1;
        const was = this.busy;
        this.busy = false;
        return { aborted: was };
      },
    };
  }
  endTurn() {
    this.busy = false;
    for (const e of this.ends.splice(0)) e();
  }
}

function setup(opts: Partial<TelegramChannelOptions> = {}, paired = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-tg-conv-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (paired) fs.writeFileSync(path.join(dir, TELEGRAM_PAIRING_FILE), JSON.stringify({ userId: String(USER), chatId: String(USER) }));
  const api = new FakeBotApi(30);
  const controller = new FakeController();
  const channel = new TelegramChannel({
    token: TOKEN,
    stateDir: dir,
    configuredUserId: null,
    fetch: api.fetch,
    retryDelayMs: () => 10,
    newCode: () => 'CODE0001',
    replyThrottleMs: 0,
    log: quiet,
    ...opts,
  });
  cleanups.push(() => {
    controller.endTurn();
    return channel.stop();
  });
  channel.start(controller.ctx());
  return { api, controller, channel };
}

const sentTexts = (api: FakeBotApi) => api.of('sendMessage').map((c) => c.params.text as string);

describe('Telegram conversation: inbound', () => {
  it('an idle message starts a turn (no marker); a mid-turn one steers and gets the steer reaction', async () => {
    const { api, controller } = setup();
    const first = api.message(USER, 'what is the weather?');
    await until(() => controller.received.length === 1);
    const second = api.message(USER, 'and tomorrow?');
    await until(() => api.of('setMessageReaction').length === 1);
    expect(controller.received).toEqual([
      { text: 'what is the weather?', channel: 'telegram' },
      { text: 'and tomorrow?', channel: 'telegram' },
    ]);
    const reaction = api.of('setMessageReaction')[0]!.params;
    expect(reaction).toEqual({ chat_id: USER, message_id: second, reaction: [{ type: 'emoji', emoji: STEER_REACTION }] });
    expect(reaction.message_id).not.toBe(first);
    expect(sentTexts(api)).toEqual([]);
  });

  it('when the reaction is refused, the steer is shown with a short note instead', async () => {
    const { api, controller } = setup();
    api.failMethods.add('setMessageReaction');
    api.message(USER, 'start');
    await until(() => controller.received.length === 1);
    const steer = api.message(USER, 'also this');
    await until(() => sentTexts(api).length === 1);
    expect(api.of('sendMessage')[0]!.params).toMatchObject({ chat_id: USER, text: STEER_NOTE, reply_parameters: { message_id: steer } });
  });

  it('a started turn does not hold polling: later messages are handled while it runs', async () => {
    const { api, controller } = setup();
    api.message(USER, 'long task');
    api.message(USER, 'stop');
    await until(() => controller.aborts === 1);
    expect(sentTexts(api)).toEqual([STOPPED_REPLY]);
  });

  it('`!` / `!!` are refused with an explanation and never reach the controller', async () => {
    const { api, controller } = setup();
    api.message(USER, '!rm -rf ~');
    api.message(USER, '  !!sudo ls');
    await until(() => sentTexts(api).length === 2);
    expect(sentTexts(api)).toEqual([SHELL_REFUSAL_REPLY, SHELL_REFUSAL_REPLY]);
    expect(controller.received).toEqual([]);
  });

  it('/new and /reset reset the assistant (never sent to pi); a failed reset says so', async () => {
    const { api, controller } = setup();
    api.message(USER, '/new');
    api.message(USER, '/reset@wherever_test_bot');
    await until(() => sentTexts(api).length === 2);
    expect(controller.resets).toBe(2);
    expect(sentTexts(api)).toEqual([RESET_REPLY, RESET_REPLY]);
    controller.resetError = 'disk full';
    api.message(USER, '/reset');
    await until(() => sentTexts(api).length === 3);
    expect(sentTexts(api)[2]).toMatch(/disk full/);
    expect(controller.received).toEqual([]);
  });

  it('stop, /stop and STOP abort the running turn; with nothing running it says so', async () => {
    const { api, controller } = setup();
    api.message(USER, 'stop');
    await until(() => sentTexts(api).length === 1);
    expect(sentTexts(api)).toEqual([NOTHING_RUNNING_REPLY]);
    controller.busy = true;
    api.message(USER, '/stop');
    await until(() => sentTexts(api).length === 2);
    controller.busy = true;
    api.message(USER, ' STOP ');
    await until(() => sentTexts(api).length === 3);
    expect(controller.aborts).toBe(3);
    expect(sentTexts(api).slice(1)).toEqual([STOPPED_REPLY, STOPPED_REPLY]);
    expect(controller.received).toEqual([]);
  });

  it('other `/` text, including /skill:, is passed through untouched (no origin prefix)', async () => {
    const { api, controller } = setup();
    api.message(USER, '/skill:brief summarize my day');
    await until(() => controller.received.length === 1);
    controller.endTurn();
    api.message(USER, '/compact');
    await until(() => controller.received.length === 2);
    expect(controller.received.map((r) => r.text)).toEqual(['/skill:brief summarize my day', '/compact']);
  });
});

describe('Telegram conversation: outbound', () => {
  it('replies whose destination is Telegram go to the paired chat, streamed then final', async () => {
    const { api, channel } = setup();
    await until(() => api.of('getUpdates').length > 0);
    const event = (type: string, text: string) => ({ type, message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
    channel.deliverReply({ sessionFile: '/s.jsonl', destination: 'telegram', event: event('message_update', 'Sun') });
    channel.deliverReply({ sessionFile: '/s.jsonl', destination: 'telegram', event: event('message_end', 'Sunny all day') });
    await channel.replyIdle();
    expect(api.of('sendMessageDraft')[0]!.params).toMatchObject({ chat_id: String(USER), text: 'Sun' });
    expect(api.of('sendMessage').map((c) => c.params)).toEqual([{ chat_id: String(USER), text: 'Sunny all day' }]);
  });

  it('assistant_notify is its own 🔔 message with the body and, with a public URL, a link to the session', async () => {
    const { api, channel } = setup({ publicUrl: 'https://box.example/' });
    await until(() => api.of('getUpdates').length > 0);
    const r = await channel.notify({ title: 'CI', body: 'tests are red', source: 'app', navigate: 'sess-1' });
    expect(r).toEqual({ ok: true, detail: 'sent' });
    expect(sentTexts(api)).toEqual(['🔔 app: CI\n\ntests are red\n\nhttps://box.example/#sess-1']);

    const { api: api2, channel: plain } = setup();
    await until(() => api2.of('getUpdates').length > 0);
    await plain.notify({ title: 'Hi', body: '', source: 'assistant', navigate: 's' });
    expect(sentTexts(api2)).toEqual(['🔔 assistant: Hi']);
  });

  it('notify while unpaired is a failed delivery (nothing sent)', async () => {
    const { api, channel } = setup({}, false);
    await until(() => api.of('getUpdates').length > 0);
    const r = await channel.notify({ title: 'x', body: 'y', source: 's', navigate: 'n' });
    expect(r.ok).toBe(false);
    expect(api.of('sendMessage')).toEqual([]);
  });

  it('dropped messages are reported on Telegram', async () => {
    const { api, channel } = setup();
    await until(() => api.of('getUpdates').length > 0);
    await channel.reportDropped({ sessionFile: '/s', reason: 'aborted', messages: ['one', 'two'], at: 'now' });
    await channel.reportDropped({ sessionFile: '/s', reason: 'reset', messages: ['three'], at: 'now' });
    const [aborted, reset] = sentTexts(api);
    expect(aborted).toMatch(/stopped/);
    expect(aborted).toContain('• one');
    expect(aborted).toContain('• two');
    expect(reset).toMatch(/reset/);
    expect(reset).toContain('• three');
  });
});
