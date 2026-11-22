import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKenning, type Kenning } from 'kenning';
import { startHarness, type Harness } from './harness.js';
import { FakeBotApi } from './fake-bot-api.ts';

/**
 * A blocking kenning question answered from Telegram, end to end: a REAL server
 * with the REAL kenning-pi in its sessions, the assistant active, and the Bot
 * API faked at the HTTP boundary (`assistantTelegram.apiBaseUrl`).
 *
 * The first manual run found that answering by just typing "yes" in the chat
 * does nothing for the question (it is a message for the assistant: only a
 * Telegram REPLY to the question answers it). So the question now says how to
 * answer there and carries its options as buttons; a tap answers it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const KENNING_PI_DIR = fs.realpathSync(path.join(here, '..', 'node_modules', 'kenning-pi'));
const USER = 7;

let h: Harness;
let api: FakeBotApi;
let kenning: Kenning;
let root: string;

async function until(pred: () => boolean, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  kenning = openKenning();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-kenning-tg-')));
  api = new FakeBotApi(100);
  const url = await api.listen();
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ assistantFolder: path.join(root, 'assistant'), assistantTelegram: { enabled: true, apiBaseUrl: url, userId: USER } }),
  );
  h = await startHarness({
    env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir, KENNING_POLL_MS: '100', WHEREVER_TELEGRAM_TOKEN: '111:kenning-token', WHEREVER_TELEGRAM_TOKEN_FILE: '' },
  });
  const settings = path.join(h.agentDir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), extensions: [KENNING_PI_DIR] }));
  await until(() => api.of('getUpdates').length > 0, 30_000, 'polling');
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
  await api?.close();
  kenning?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('a blocking kenning question on Telegram', () => {
  it('says how to answer, offers its options as buttons, ignores a plain message, and a tap answers it', async () => {
    const web = await h.connect();
    await web.waitForType('kenning_update');
    const dir = path.join(root, 'release');
    fs.mkdirSync(dir, { recursive: true });
    web.send({ type: 'session_new', cwd: dir });
    const created = await web.waitForType('session_created', 30_000);
    const sessionFile = created.sessionFile as string;
    await web.waitFor((m) => m.type === 'kenning_update' && (m as any).presence.some((p: any) => p.sessionFile === sessionFile), 15_000);

    h.fake.queue({ kind: 'tool-call', toolName: 'human_ask', input: { question: 'Publish 0.3.0 to npm?', options: ['yes', 'no'], blocking: true } });
    web.send({ type: 'message', sessionId: created.sessionId, message: 'release it when I say so' });

    await until(() => api.withKeyboard().length === 1, 30_000, 'the question on Telegram');
    const question = api.of('sendMessage').find((c) => c.params.reply_markup)!.params;
    expect(question.text).toContain('Publish 0.3.0 to npm?');
    expect(question.text).toContain('To answer here: tap a button below, or swipe this message to reply with your own answer.');
    expect(question.reply_markup.inline_keyboard).toEqual([[{ text: 'yes', callback_data: 'answer:0' }, { text: 'no', callback_data: 'answer:1' }]]);
    const item = kenning.inbox().find((i) => i.question === 'Publish 0.3.0 to npm?')!;

    // What the manual run did: a plain "Yes" is a message for the assistant, not the answer.
    api.message(USER, 'Yes');
    await until(() => api.of('sendMessage').some((c) => c.params.text === 'ok'), 30_000, "the assistant's reply");
    expect(kenning.item(item.id)?.state).toBe('open');

    api.tap(USER, api.withKeyboard()[0], 0);
    await until(() => kenning.item(item.id)?.state === 'answered', 15_000, 'the answer');
    expect(kenning.item(item.id)).toMatchObject({ answer: 'yes', answerChannel: 'telegram' });
    await until(() => api.of('sendMessage').some((c) => String(c.params.text).startsWith('✅ Answered')), 10_000, 'the confirmation');
    expect(api.of('answerCallbackQuery').map((c) => c.params.text)).toEqual(['Answered: yes']);
    expect(api.withKeyboard()).toEqual([]);

    // The waiting tool returned the human's answer to the model.
    let seen = '';
    await until(() => {
      seen = JSON.stringify(h.fake.requests().map((r: any) => r.messages ?? []));
      return /the human answered h_[\w-]+ \(origin human, on telegram\)/.test(seen);
    }, 20_000, 'the tool result');
  }, 120_000);
});
