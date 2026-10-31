import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';
import { FakeBotApi } from './fake-bot-api.ts';
import { RESET_REPLY, SHELL_REFUSAL_REPLY, STEER_REACTION, STOPPED_REPLY } from '../src/telegram-channel.ts';

/**
 * The Telegram CONVERSATION against the REAL server (real pi, fake LLM), with
 * the Bot API mocked at the HTTP boundary (a local HTTP server the config's
 * `assistantTelegram.apiBaseUrl` points at) and the user paired through
 * `assistantTelegram.userId`:
 *  - a Telegram question gets its streamed answer on Telegram, split under 4096;
 *  - a message sent mid-turn steers (reaction) and the output after it goes to
 *    Telegram;
 *  - a web-started turn sends nothing to Telegram; `assistant_notify`
 *    mid-exchange arrives at once as its own `🔔` message;
 *  - `!` refused, `/new` resets, `/skill:` expands;
 *  - `stop` with a Telegram steer queued: the steer is reported as dropped and
 *    the next Telegram message still gets its reply on Telegram.
 * Isolation: temp assistant folder, config and state dirs; the real
 * ~/.wherever is asserted untouched.
 */

const REAL_WHEREVER_DIR = path.join(os.homedir(), '.wherever');
function snapshotDir(dir: string): string {
  if (!fs.existsSync(dir)) return 'ABSENT';
  const entries: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        entries.push(`${prefix}${name}/`);
        walk(full, `${prefix}${name}/`);
      } else if (st.isFile()) {
        const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
        entries.push(`${prefix}${name}:${h}`);
      }
    }
  };
  walk(dir, '');
  return entries.join('\n');
}
const realBefore = snapshotDir(REAL_WHEREVER_DIR);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(() => {
  expect(snapshotDir(REAL_WHEREVER_DIR)).toBe(realBefore);
});

const USER = 7;
const TOKEN = '111:conversation-token';

async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function boot(): Promise<{ h: Harness; api: FakeBotApi; folder: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-tg-conv-srv-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = new FakeBotApi(100);
  const url = await api.listen();
  cleanups.push(() => api.close());
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  const folder = path.join(root, 'assistant');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      assistantFolder: folder,
      publicUrl: 'https://box.example',
      assistantTelegram: { enabled: true, apiBaseUrl: url, userId: USER },
    }),
  );
  const h = await startHarness({
    initial: { kind: 'reply', text: 'ok' },
    env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir, TZ: 'UTC', WHEREVER_TELEGRAM_TOKEN: TOKEN, WHEREVER_TELEGRAM_TOKEN_FILE: '' },
  });
  cleanups.push(() => h.cleanup());
  await until(() => api.of('getUpdates').length > 0, 30_000, 'polling');
  return { h, api, folder };
}

const sent = (api: FakeBotApi) => api.of('sendMessage').map((c) => String(c.params.text));
const outbound = (api: FakeBotApi) => api.calls.filter((c) => ['sendMessage', 'sendMessageDraft', 'editMessageText'].includes(c.method)).length;

function lastUserText(body: Record<string, any> | undefined): string {
  const msgs = (body?.messages ?? []) as Array<{ role: string; content: unknown }>;
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (p?.type === 'text' ? p.text : '')).join('');
  return '';
}

async function assistantStatus(port: number): Promise<any> {
  return (await (await fetch(`http://127.0.0.1:${port}/config`)).json()).assistant;
}

async function webClient(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

describe('Telegram conversation (real server)', () => {
  it('streamed + split answers, steer marker and routing, web turns silent, notify immediate, refusals and commands', async () => {
    const { h, api } = await boot();

    // 1. A question gets its streamed answer on Telegram, split under 4096.
    const long = ['A', 'B', 'C'].map((ch) => ch.repeat(3000)).join('\n\n');
    h.setNext({ kind: 'slow-reply', text: long, charDelayMs: 0 });
    api.message(USER, 'tell me a long story');
    await until(() => sent(api).join('\n\n') === long, 60_000, 'the long answer');
    for (const t of sent(api)) expect(t.length).toBeLessThan(4096);
    expect(sent(api).length).toBe(3);
    expect(api.of('sendMessageDraft').length).toBeGreaterThan(0);
    expect(lastUserText(h.fake.requests().at(-1))).toBe('tell me a long story');

    // 2. Mid-turn: the second message steers (reaction) and the output after it goes to Telegram.
    let mark = api.calls.length;
    h.fake.queue({ kind: 'slow-reply', text: 'thinking about it '.repeat(10), charDelayMs: 15 });
    h.setNext({ kind: 'reply', text: 'answer after the steer' });
    api.message(USER, 'first question');
    await until(() => api.calls.slice(mark).some((c) => c.method === 'sendMessageDraft'), 30_000, 'streaming');
    const steerId = api.message(USER, 'actually, in French');
    await until(() => api.of('setMessageReaction').length === 1, 30_000, 'the steer reaction');
    expect(api.of('setMessageReaction')[0]!.params).toMatchObject({ chat_id: USER, message_id: steerId, reaction: [{ type: 'emoji', emoji: STEER_REACTION }] });
    await until(() => sent(api).includes('answer after the steer'), 30_000, 'the reply after the steer');
    expect(lastUserText(h.fake.requests().at(-1))).toContain('actually, in French');

    // 3. A web-started turn in the same assistant session sends nothing to Telegram.
    const web = await webClient(h);
    web.send({ type: 'assistant_open' });
    const cur = await web.waitForType('assistant_current');
    web.send({ type: 'session_load', sessionFile: cur.sessionFile });
    await web.waitFor((m) => m.type === 'session_ready' && m.sessionFile === cur.sessionFile);
    await new Promise((r) => setTimeout(r, 1000)); // let the last reply's draft clear land
    mark = outbound(api);
    h.setNext({ kind: 'reply', text: 'web only answer' });
    web.send({ type: 'message', message: 'from the web', sessionId: cur.sessionId });
    await web.waitFor((m) => m.type === 'message_end' && m.role === 'assistant' && m.content === 'web only answer', 30_000);
    await web.waitForType('agent_end', 30_000);
    await new Promise((r) => setTimeout(r, 1000));
    expect(outbound(api)).toBe(mark);

    // 4. assistant_notify mid-exchange: its own 🔔 message, at once, never part of the reply.
    const before = sent(api).length;
    h.fake.queue({ kind: 'tool-call', toolName: 'assistant_notify', input: { title: 'Heads up', body: 'the deploy finished' }, toolCallId: 'toolu_tgnotify' });
    h.setNext({ kind: 'reply', text: 'notified you' });
    api.message(USER, 'notify me');
    await until(() => sent(api).includes('notified you'), 30_000, 'the reply after notify');
    const after = sent(api).slice(before);
    const bell = after.findIndex((t) => t.startsWith('🔔 '));
    expect(bell).toBeGreaterThanOrEqual(0);
    expect(after[bell]).toMatch(/^🔔 assistant: Heads up\n\nthe deploy finished\n\nhttps:\/\/box\.example\/#/);
    expect(bell).toBeLessThan(after.indexOf('notified you'));
    expect(after.filter((t) => t.includes('🔔')).length).toBe(1);

    // 5. `!` is refused and never reaches the session.
    const reqs = h.fake.requests().length;
    api.message(USER, '!ls -la');
    await until(() => sent(api).includes(SHELL_REFUSAL_REPLY), 30_000, 'the refusal');
    await new Promise((r) => setTimeout(r, 300));
    expect(h.fake.requests().length).toBe(reqs);

    // 6. /skill: still expands.
    const skillDir = path.join(h.agentDir, 'skills', 'tg-probe');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: tg-probe\ndescription: A probe skill.\n---\n\nTG-PROBE-BODY-4411\n');
    // Skills are discovered when the session is built: reset to get a fresh one (also checks /new).
    const oldId = (await assistantStatus(h.port)).currentSessionId;
    api.message(USER, '/new');
    await until(() => sent(api).includes(RESET_REPLY), 30_000, 'the reset reply');
    expect((await assistantStatus(h.port)).currentSessionId).not.toBe(oldId);
    h.setNext({ kind: 'reply', text: 'skill used' });
    api.message(USER, '/skill:tg-probe and go');
    await until(() => sent(api).includes('skill used'), 30_000, 'the skill reply');
    const expanded = lastUserText(h.fake.requests().at(-1));
    expect(expanded).toContain('TG-PROBE-BODY-4411');
    expect(expanded).toContain('and go');
  }, 240_000);

  it('stop with a Telegram steer queued: the steer is reported dropped, and the next message still replies on Telegram', async () => {
    const { h, api } = await boot();
    h.setNext({ kind: 'slow-reply', text: 'a very long and slow answer '.repeat(40), charDelayMs: 20 });
    api.message(USER, 'start something slow');
    await until(() => api.of('sendMessageDraft').length > 0, 30_000, 'streaming');
    api.message(USER, 'queued steer text');
    await until(() => api.of('setMessageReaction').length === 1, 30_000, 'the steer reaction');
    api.message(USER, 'stop');
    await until(() => sent(api).includes(STOPPED_REPLY), 30_000, 'the stop reply');
    await until(() => sent(api).some((t) => t.includes('• queued steer text')), 30_000, 'the dropped report');
    expect(sent(api).find((t) => t.includes('• queued steer text'))).toMatch(/stopped/);

    h.setNext({ kind: 'reply', text: 'routed back to telegram' });
    api.message(USER, 'are you there?');
    await until(() => sent(api).includes('routed back to telegram'), 30_000, 'the reply after stop');
    expect(lastUserText(h.fake.requests().at(-1))).toBe('are you there?');
  }, 120_000);
});
