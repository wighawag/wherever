import { describe, it, expect } from 'vitest';
import { FakeBotApi } from './fake-bot-api.ts';
import {
  TELEGRAM_TEXT_LIMIT,
  TelegramReplies,
  assistantText,
  splitTelegramText,
} from '../src/telegram-replies.ts';

/**
 * Reply delivery from a RECORDED event stream (pool events as the channel
 * dispatcher hands them over), with the Bot API mocked at the HTTP boundary:
 * draft streaming (`sendMessageDraft`), the `sendMessage` + `editMessageText`
 * fallback, splitting under Telegram's limit, and the aborted / error ends.
 */

const TOKEN = '123:tok';
const CHAT = 77;

function botCall(api: FakeBotApi) {
  return async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const res = await api.fetch(`http://x/bot${TOKEN}/${method}`, { method: 'POST', headers: {}, body: JSON.stringify(params) });
    const body = (await res.json()) as any;
    if (!body.ok) throw new Error(body.description);
    return body.result as T;
  };
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

function replies(api: FakeBotApi) {
  return new TelegramReplies({ call: botCall(api), chatId: () => String(CHAT), throttleMs: 0, log: quiet });
}

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }],
  ...extra,
});
const update = (text: string) => ({ type: 'message_update', message: assistant(text) });
const end = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'message_end', message: assistant(text, { stopReason: 'stop', ...extra }) });

const methods = (api: FakeBotApi) => api.calls.map((c) => c.method);

describe('splitTelegramText', () => {
  it('keeps short text whole and splits long text under the limit, by paragraph, then line, then hard', () => {
    expect(splitTelegramText('hello')).toEqual(['hello']);
    const para = 'p'.repeat(3000);
    const parts = splitTelegramText(`${para}\n\n${para}\n\n${para}`);
    expect(parts).toEqual([para, para, para]);
    const huge = 'x'.repeat(TELEGRAM_TEXT_LIMIT * 2 + 10);
    const hard = splitTelegramText(huge);
    expect(hard.join('')).toBe(huge);
    for (const p of [...parts, ...hard]) expect(p.length).toBeLessThan(4096);
    expect(TELEGRAM_TEXT_LIMIT).toBeLessThan(4096);
  });

  it('never splits a surrogate pair', () => {
    const text = 'a' + '😀'.repeat(TELEGRAM_TEXT_LIMIT);
    const parts = splitTelegramText(text);
    expect(parts.join('')).toBe(text);
    for (const p of parts) expect(p).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });

  it('assistantText joins the text blocks only', () => {
    expect(assistantText(assistant(' a ').content)).toBe('a');
    expect(assistantText([{ type: 'toolCall', name: 'bash' }])).toBe('');
    expect(assistantText('plain')).toBe('plain');
  });
});

describe('TelegramReplies (recorded event stream)', () => {
  it('streams with sendMessageDraft, then sends the final message and clears the draft', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/s.jsonl', { type: 'message_end', message: { role: 'user', content: 'q' } });
    r.handle('/s.jsonl', update('Hel'));
    r.handle('/s.jsonl', update('Hello wor'));
    r.handle('/s.jsonl', end('Hello world'));
    await r.idle();
    const drafts = api.of('sendMessageDraft');
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts[0]!.params).toMatchObject({ chat_id: String(CHAT), text: expect.stringMatching(/^Hel/) });
    const sent = api.of('sendMessage');
    expect(sent.map((c) => c.params.text)).toEqual(['Hello world']);
    expect(drafts.at(-1)!.params.text).toBe('');
    expect(api.of('editMessageText')).toEqual([]);
  });

  it('falls back to sendMessage + editMessageText when drafts are unsupported', async () => {
    const api = new FakeBotApi();
    api.failMethods.add('sendMessageDraft');
    const r = replies(api);
    r.handle('/s.jsonl', update('Hel'));
    await r.idle();
    r.handle('/s.jsonl', update('Hello wor'));
    await r.idle();
    r.handle('/s.jsonl', end('Hello world'));
    await r.idle();
    expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['Hel']);
    expect(api.of('editMessageText').map((c) => c.params.text)).toEqual(['Hello wor', 'Hello world']);
    // The unsupported draft is remembered: the next reply does not try it again.
    const draftsBefore = api.of('sendMessageDraft').length;
    r.handle('/s.jsonl', update('Next'));
    r.handle('/s.jsonl', end('Next one'));
    await r.idle();
    expect(api.of('sendMessageDraft').length).toBe(draftsBefore);
  });

  it('splits a long answer into several messages, each under 4096', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    const long = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(2500)).join('\n\n');
    r.handle('/s.jsonl', update(long.slice(0, 5000)));
    r.handle('/s.jsonl', end(long));
    await r.idle();
    const sent = api.of('sendMessage').map((c) => c.params.text as string);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join('\n\n')).toBe(long);
    for (const s of sent) expect(s.length).toBeLessThan(4096);
    for (const d of api.of('sendMessageDraft')) expect((d.params.text as string).length).toBeLessThan(4096);
  });

  it('in fallback mode a long answer edits the preview to the first part and sends the rest', async () => {
    const api = new FakeBotApi();
    api.failMethods.add('sendMessageDraft');
    const r = replies(api);
    const long = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
    r.handle('/s.jsonl', update('aaa'));
    await r.idle();
    r.handle('/s.jsonl', end(long));
    await r.idle();
    expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['aaa', 'b'.repeat(3000)]);
    expect(api.of('editMessageText').map((c) => c.params.text)).toEqual(['a'.repeat(3000)]);
  });

  it('a tool-only assistant message sends nothing; an aborted one clears its draft; an error is reported', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/s.jsonl', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }], stopReason: 'toolUse' } });
    await r.idle();
    expect(api.calls).toEqual([]);

    r.handle('/s.jsonl', update('partial'));
    r.handle('/s.jsonl', end('partial', { stopReason: 'aborted' }));
    await r.idle();
    expect(api.of('sendMessage')).toEqual([]);
    expect(api.of('sendMessageDraft').at(-1)!.params.text).toBe('');

    r.handle('/s.jsonl', end('', { stopReason: 'error', errorMessage: 'rate limited' }));
    await r.idle();
    expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['⚠️ The assistant failed: rate limited']);
  });

  it('keeps one stream per session and ignores non-assistant events; no chat = nothing sent', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/a.jsonl', update('from a'));
    r.handle('/b.jsonl', update('from b'));
    r.handle('/a.jsonl', { type: 'tool_execution_start' });
    r.handle('/b.jsonl', end('B done'));
    r.handle('/a.jsonl', end('A done'));
    await r.idle();
    expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['B done', 'A done']);
    const drafts = new Set(api.of('sendMessageDraft').map((c) => c.params.draft_id));
    expect(drafts.size).toBe(2);

    const none = new FakeBotApi();
    const unpaired = new TelegramReplies({ call: botCall(none), chatId: () => null, throttleMs: 0, log: quiet });
    unpaired.handle('/a.jsonl', update('x'));
    unpaired.handle('/a.jsonl', end('x'));
    await unpaired.idle();
    expect(none.calls).toEqual([]);
    expect(methods(none)).toEqual([]);
  });
});
