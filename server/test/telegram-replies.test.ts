import { describe, it, expect } from 'vitest';
import { FakeBotApi } from './fake-bot-api.ts';
import {
  TELEGRAM_TEXT_LIMIT,
  ABORTED_MARK,
  TelegramReplies,
  type TelegramToolCalls,
  assistantText,
  splitTelegramText,
  toolCallSummary,
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

function replies(api: FakeBotApi, toolCalls?: TelegramToolCalls) {
  return new TelegramReplies({ call: botCall(api), chatId: () => String(CHAT), throttleMs: 0, log: quiet, toolCalls });
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
  it('streams with sendMessageDraft, then sends the final message, which clears the draft (no empty draft)', async () => {
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
    // An empty draft is Telegram's "Thinking..." placeholder, not a clear: never sent.
    for (const d of drafts) expect(d.params.text).not.toBe('');
    expect(api.visibleDraft(CHAT)).toBeNull();
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

  it('a tool-only assistant message sends nothing; an aborted one keeps what was shown and clears its draft; an error is reported', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/s.jsonl', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }], stopReason: 'toolUse' } });
    await r.idle();
    expect(api.calls).toEqual([]);

    r.handle('/s.jsonl', update('partial'));
    r.handle('/s.jsonl', end('partial', { stopReason: 'aborted' }));
    await r.idle();
    expect(api.of('sendMessage').map((c) => c.params)).toEqual([{ chat_id: String(CHAT), text: `partial\n\n${ABORTED_MARK}`, disable_notification: true }]);
    expect(api.visibleDraft(CHAT)).toBeNull();

    r.handle('/s.jsonl', end('', { stopReason: 'error', errorMessage: 'rate limited' }));
    await r.idle();
    expect(api.of('sendMessage').map((c) => c.params.text).at(-1)).toBe('⚠️ The assistant failed: rate limited');
  });

  it('keeps one stream per session and ignores non-assistant events; no chat = nothing sent', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/a.jsonl', update('from a'));
    r.handle('/b.jsonl', update('from b'));
    r.handle('/a.jsonl', { type: 'message_end', message: { role: 'user', content: 'not an assistant message' } });
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

/** A recorded turn: text, a bash tool call (its partial toolCall content streams too), then the final answer. */
function bashTurn(r: TelegramReplies, command = 'ls -la ~/dev\necho second line') {
  const withTool = (text: string, stopReason?: string) => ({
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command } },
    ],
    ...(stopReason ? { stopReason } : {}),
  });
  r.handle('/s.jsonl', { type: 'agent_start' });
  r.handle('/s.jsonl', { type: 'turn_start' });
  r.handle('/s.jsonl', { type: 'message_update', message: withTool('Let me look.') });
  r.handle('/s.jsonl', { type: 'message_end', message: withTool('Let me look.', 'toolUse') });
  r.handle('/s.jsonl', { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command } });
  r.handle('/s.jsonl', { type: 'tool_execution_update', toolCallId: 'call_1', toolName: 'bash', args: { command }, partialResult: { content: [{ type: 'text', text: 'total 0' }] } });
  r.handle('/s.jsonl', { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', result: { content: [{ type: 'text', text: 'total 0' }] }, isError: false });
  r.handle('/s.jsonl', { type: 'message_start', message: { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'total 0' }] } });
  r.handle('/s.jsonl', { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'total 0' }] } });
  r.handle('/s.jsonl', { type: 'turn_end' });
  r.handle('/s.jsonl', { type: 'turn_start' });
  r.handle('/s.jsonl', update('It is empty'));
  r.handle('/s.jsonl', end('It is empty.'));
  r.handle('/s.jsonl', { type: 'turn_end' });
  r.handle('/s.jsonl', { type: 'agent_end' });
}

/** Every call is plain content Telegram renders normally: a non-empty text message, or a draft WITH text. */
function expectOnlyRenderableContent(api: FakeBotApi) {
  for (const c of api.calls) {
    expect(['sendMessage', 'sendMessageDraft']).toContain(c.method);
    expect(typeof c.params.text).toBe('string');
    expect((c.params.text as string).trim()).not.toBe('');
    expect(c.params.parse_mode).toBeUndefined();
    expect(c.params.entities).toBeUndefined();
  }
}

describe('TelegramReplies: tool calls', () => {
  it('toolCalls off (the default): a turn with a bash tool call sends only its text, never an empty draft or tool content', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    bashTurn(r);
    await r.idle();
    expectOnlyRenderableContent(api);
    expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['Let me look.', 'It is empty.']);
    for (const c of api.calls) expect(String(c.params.text)).not.toMatch(/ls -la|bash|total 0|🔧/);
    expect(api.visibleDraft(CHAT)).toBeNull();
  });

  it('toolCalls compact: exactly one silent plain-text summary line per call, in order', async () => {
    const api = new FakeBotApi();
    const r = replies(api, 'compact');
    bashTurn(r);
    r.handle('/s.jsonl', { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'read', args: { path: '/etc/hosts', offset: 3 } });
    r.handle('/s.jsonl', { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'read', result: { content: [{ type: 'text', text: 'root' }] }, isError: false });
    await r.idle();
    expectOnlyRenderableContent(api);
    const sent = api.of('sendMessage').map((c) => c.params);
    expect(sent.map((p) => p.text)).toEqual(['Let me look.', '🔧 bash: ls -la ~/dev', 'It is empty.', '🔧 read: /etc/hosts']);
    const lines = sent.filter((p) => String(p.text).startsWith('🔧'));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.disable_notification).toBe(true);
    for (const p of sent.filter((p) => !String(p.text).startsWith('🔧'))) expect(p.disable_notification).toBeUndefined();
    expect(api.visibleDraft(CHAT)).toBeNull();
  });

  it('a forced user shell command (`!`) is not a tool call and sends nothing in compact mode', async () => {
    const api = new FakeBotApi();
    const r = replies(api, 'compact');
    r.handle('/s.jsonl', { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, forceCommand: true });
    await r.idle();
    expect(api.calls).toEqual([]);
  });

  it('toolCallSummary: first line, truncated, secrets redacted, only the summary argument', () => {
    expect(toolCallSummary('bash', { command: '  cd /x && make\nrm -rf build' })).toBe('🔧 bash: cd /x && make');
    const long = toolCallSummary('bash', { command: 'echo ' + 'a'.repeat(200) });
    expect(long.length).toBeLessThanOrEqual('🔧 bash: '.length + 81);
    expect(long.endsWith('…')).toBe(true);
    expect(toolCallSummary('read', { path: '/home/u/notes.md', limit: 20 })).toBe('🔧 read: /home/u/notes.md');
    expect(toolCallSummary('edit', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] })).toBe('🔧 edit: a.ts');
    expect(toolCallSummary('mcp__miro__board_create', { name: 'Secret plans' })).toBe('🔧 mcp__miro__board_create');
    expect(toolCallSummary('bash', {})).toBe('🔧 bash');
    const secrets = [
      'curl -H "Authorization: Bearer abcDEF123456789xyz" https://api.x',
      'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'mysql --password=hunter2 -u root',
      'git clone https://user:s3cr3tpass@example.com/r.git',
      'curl "https://api.telegram.org/bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe"',
      'API_KEY=sk-proj-1234567890abcdefghij node run.js',
      'curl -u admin:hunter2 https://x',
      'mysql -phunter2 -u root',
      'sshpass -p hunter2 ssh box',
    ];
    for (const cmd of secrets) {
      const s = toolCallSummary('bash', { command: cmd });
      expect(s).not.toMatch(/abcDEF123456789xyz|ghp_abc|hunter2|s3cr3tpass|AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw|sk-proj-1234567890/);
      expect(s).toContain('***');
    }
    // Control characters never reach the line.
    expect(toolCallSummary('bash', { command: 'echo \u0007\u001b[31mred' })).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('TelegramReplies: the draft is cleared at every boundary', () => {
  it('message end: the final message replaces the draft', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/s.jsonl', update('Hi'));
    await r.idle();
    expect(api.visibleDraft(CHAT)?.text).toBe('Hi');
    r.handle('/s.jsonl', end('Hi there'));
    await r.idle();
    expect(api.visibleDraft(CHAT)).toBeNull();
  });

  it('tool call start: a still-open draft is sent as its message before the tool runs, and not repeated at message_end', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/s.jsonl', update('Checking'));
    await r.idle();
    r.handle('/s.jsonl', { type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: { command: 'ls' } });
    await r.idle();
    expect(api.visibleDraft(CHAT)).toBeNull();
    expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['Checking']);
    r.handle('/s.jsonl', end('Checking'));
    await r.idle();
    expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['Checking']);
    expectOnlyRenderableContent(api);
  });

  it('tool call start then message_end before the chain drains: the text is sent once', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/s.jsonl', update('Checking'));
    r.handle('/s.jsonl', { type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: { command: 'ls' } });
    r.handle('/s.jsonl', end('Checking'));
    await r.idle();
    expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['Checking']);
    expect(api.visibleDraft(CHAT)).toBeNull();
  });

  it('leading whitespace does not defeat the already-sent prefix', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/s.jsonl', update('\n\nFirst part'));
    await r.idle();
    r.handle('/s.jsonl', { type: 'turn_end' });
    await r.idle();
    const draftsBefore = api.of('sendMessageDraft').length;
    r.handle('/s.jsonl', update('\n\nFirst part and more'));
    await r.idle();
    r.handle('/s.jsonl', end('\n\nFirst part and more'));
    await r.idle();
    expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['First part', 'and more']);
    expect(api.of('sendMessageDraft').slice(draftsBefore).map((d) => d.params.text)).toEqual(['and more']);
  });

  it('turn end and agent end: a draft whose message never ended is sent', async () => {
    for (const type of ['turn_end', 'agent_end']) {
      const api = new FakeBotApi();
      const r = replies(api);
      r.handle('/s.jsonl', update('Almost'));
      await r.idle();
      r.handle('/s.jsonl', { type });
      await r.idle();
      expect(api.visibleDraft(CHAT)).toBeNull();
      expect(api.of('sendMessage').map((c) => c.params.text)).toEqual(['Almost']);
      expectOnlyRenderableContent(api);
    }
  });

  it('abort: the shown partial text is kept as a silent message, which clears the draft', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/s.jsonl', update('Half an ans'));
    await r.idle();
    r.handle('/s.jsonl', end('Half an answer', { stopReason: 'aborted' }));
    r.handle('/s.jsonl', { type: 'agent_end' });
    await r.idle();
    expect(api.visibleDraft(CHAT)).toBeNull();
    expect(api.of('sendMessage').map((c) => c.params)).toEqual([{ chat_id: String(CHAT), text: `Half an answer\n\n${ABORTED_MARK}`, disable_notification: true }]);
    expectOnlyRenderableContent(api);
  });

  it('an aborted message that never showed a draft sends nothing', async () => {
    const api = new FakeBotApi();
    const r = replies(api);
    r.handle('/s.jsonl', end('', { stopReason: 'aborted' }));
    r.handle('/s.jsonl', { type: 'agent_end' });
    await r.idle();
    expect(api.calls).toEqual([]);
  });
});
