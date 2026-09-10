import { describe, it, expect, vi } from 'vitest';
import {
  CONVERSATION_MODE_HINT,
  CONVERSATION_MODE_REMINDER,
  CONVERSATION_MODE_REMINDER_MARKER,
  appendConversationModeHint,
  createConversationModeSignal,
  saidThisTurn,
  withConversationModeReminder,
  type ContextMessageLike,
} from '../src/conversation-mode-hint.ts';
// The CLI-bridge twin. It lives in the `@wherever-dev/pi` extension, a separate
// published package that cannot import from the server (the same constraint that
// makes the `say` tool a duplicate), so the guard against drift is this test:
// it holds both copies to the SAME text and the SAME latch behaviour.
import {
  CONVERSATION_MODE_HINT as EXTENSION_HINT,
  CONVERSATION_MODE_REMINDER as EXTENSION_REMINDER,
  createConversationModeSignal as createExtensionSignal,
  withConversationModeReminder as extensionWithReminder,
} from '../../extension/src/conversation-mode-hint.ts';

// Unit tests for the per-turn conversation-mode SIGNAL: the `before_agent_start`
// hook that tells the agent a spoken conversation is active so it also calls
// `say`. The contract is narrow on purpose: APPEND to the system prompt the event
// carries (never replace, never re-fetch), only for a turn whose message carried
// the flag, and once.

type Event = { systemPrompt: string; messages: ContextMessageLike[] };
type Handler = (event: Event) => { systemPrompt?: string; messages?: ContextMessageLike[] } | void;

/** A minimal fake pi ExtensionAPI that just captures the registered handlers. */
function loadInlineExtension() {
  const signal = createConversationModeSignal();
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  };
  const inline = signal.inlineExtension as { name: string; factory: (pi: unknown) => void };
  inline.factory(pi);
  const handler = handlers.get('before_agent_start');
  if (!handler) throw new Error('the inline extension did not register before_agent_start');
  const contextHandler = handlers.get('context');
  if (!contextHandler) throw new Error('the inline extension did not register context');
  const agentEnd = handlers.get('agent_end');
  if (!agentEnd) throw new Error('the inline extension did not register agent_end');
  return { signal, handler, contextHandler, agentEnd, name: inline.name };
}

/** The concatenated text of a message, however its content is shaped. */
function textOf(message: ContextMessageLike | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return (message.content as { text?: string }[]).map((b) => b?.text ?? '').join('\n');
}

const userMessage = (text: string): ContextMessageLike => ({
  role: 'user',
  content: [{ type: 'text', text }],
});
const assistantSay = (): ContextMessageLike => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'c1', name: 'say' }],
});
const toolResult = (toolName: string): ContextMessageLike => ({
  role: 'toolResult',
  toolCallId: 'c1',
  toolName,
  content: [{ type: 'text', text: `${toolName} output` }],
});

describe('appendConversationModeHint', () => {
  it('appends the hint to the provided base, preserving it verbatim', () => {
    const base = 'You are pi.\n\n## Tools\nread, bash';
    const result = appendConversationModeHint(base);
    expect(result.startsWith(base)).toBe(true);
    expect(result.endsWith(CONVERSATION_MODE_HINT)).toBe(true);
    expect(result).toBe(`${base}\n\n${CONVERSATION_MODE_HINT}`);
  });

  it('tells the agent to ALSO call say, in addition to the written answer', () => {
    const hint = CONVERSATION_MODE_HINT.toLowerCase();
    expect(hint).toContain('say');
    expect(hint).toContain('in addition');
    expect(hint).toContain('spoken');
  });
});

describe('the conversation-mode before_agent_start handler', () => {
  it('appends nothing when the turn was not armed (mode off / flag absent)', () => {
    const { handler } = loadInlineExtension();
    const result = handler({ systemPrompt: 'BASE' });
    expect(result).toBeUndefined();
  });

  it('appends the hint to the system prompt the event carries when armed', () => {
    const { signal, handler } = loadInlineExtension();
    signal.arm(true);
    const result = handler({ systemPrompt: 'BASE' });
    expect(result?.systemPrompt).toBe(`BASE\n\n${CONVERSATION_MODE_HINT}`);
  });

  it('appends to the value the event carries, not a snapshot (SDK chains extensions)', () => {
    const { signal, handler } = loadInlineExtension();
    signal.arm(true);
    // Another extension already modified the prompt for this turn; ours must build
    // on THAT value rather than on the pristine base.
    const chained = handler({ systemPrompt: 'BASE\n\nFROM ANOTHER EXTENSION' });
    expect(chained?.systemPrompt).toBe(
      `BASE\n\nFROM ANOTHER EXTENSION\n\n${CONVERSATION_MODE_HINT}`,
    );
  });

  it('consumes the arming so the hint cannot leak into a later unflagged turn', () => {
    const { signal, handler } = loadInlineExtension();
    signal.arm(true);
    expect(signal.isArmed()).toBe(true);
    expect(handler({ systemPrompt: 'BASE' })?.systemPrompt).toContain(CONVERSATION_MODE_HINT);
    expect(signal.isArmed()).toBe(false);
    // Next turn (e.g. a plain typed message, or an auto-retry): nothing appended.
    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined();
  });

  it('disarms when the next message carries no flag (latest message wins)', () => {
    const { signal, handler } = loadInlineExtension();
    signal.arm(true);
    signal.arm(false);
    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined();
  });
});

describe('withConversationModeReminder (the TAIL reminder)', () => {
  it('merges into a user tail rather than opening a second user turn', () => {
    // Two consecutive user turns are merged by Anthropic but REJECTED by Bedrock
    // and some proxies, so the reminder rides inside the tail message instead.
    const messages = [userMessage('hello?')];
    const out = withConversationModeReminder(messages);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
    expect(textOf(out[0])).toContain('hello?');
    expect(textOf(out[0])).toContain(CONVERSATION_MODE_REMINDER);
  });

  it('merges into a toolResult tail (the post-tool synthesis call)', () => {
    const messages = [
      userMessage('what is New Zealand known for?'),
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'web_search' }] },
      toolResult('web_search'),
    ];
    const out = withConversationModeReminder(messages);
    expect(out).toHaveLength(3);
    expect(out[2]?.role).toBe('toolResult');
    expect(out[2]?.toolCallId).toBe('c1');
    expect(textOf(out[2])).toContain('web_search output');
    expect(textOf(out[2])).toContain(CONVERSATION_MODE_REMINDER);
  });

  it('appends a non-displayed custom message when the tail is an assistant turn', () => {
    const messages = [userMessage('hi'), { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
    const out = withConversationModeReminder(messages);
    expect(out).toHaveLength(3);
    expect(out[2]?.role).toBe('custom');
    expect(out[2]?.display).toBe(false);
    expect(textOf(out[2])).toBe(CONVERSATION_MODE_REMINDER);
  });

  it('never mutates the input messages', () => {
    const tail = userMessage('hello?');
    const messages = [tail];
    withConversationModeReminder(messages);
    expect(messages).toHaveLength(1);
    expect(textOf(tail)).toBe('hello?');
  });

  it('is idempotent: a tail that already carries the marker is left alone', () => {
    const once = withConversationModeReminder([userMessage('hello?')]);
    const twice = withConversationModeReminder(once);
    expect(twice).toEqual(once);
    expect(textOf(twice[0]).split(CONVERSATION_MODE_REMINDER_MARKER)).toHaveLength(2);
  });

  it('stops once the agent has spoken this turn (no say loop, no nagging)', () => {
    const spoken = [userMessage('hello?'), assistantSay(), toolResult('say')];
    expect(saidThisTurn(spoken)).toBe(true);
    expect(withConversationModeReminder(spoken)).toEqual(spoken);
  });

  it('a say in an EARLIER turn does not count as spoken for this one', () => {
    const messages = [
      userMessage('first'),
      assistantSay(),
      toolResult('say'),
      { role: 'assistant', content: [{ type: 'text', text: 'spoken and written' }] },
      userMessage('second'),
    ];
    expect(saidThisTurn(messages)).toBe(false);
    expect(textOf(withConversationModeReminder(messages)[4])).toContain(CONVERSATION_MODE_REMINDER);
  });
});

describe('the conversation-mode context handler', () => {
  it('leaves the messages untouched when no spoken turn is open', () => {
    const { contextHandler } = loadInlineExtension();
    expect(contextHandler({ systemPrompt: '', messages: [userMessage('hi')] })).toBeUndefined();
  });

  it('adds the reminder for every LLM call of a spoken turn, not just the first', () => {
    const { signal, handler, contextHandler } = loadInlineExtension();
    signal.arm(true);
    handler({ systemPrompt: 'BASE', messages: [] });
    expect(signal.isTurnActive()).toBe(true);

    const first = contextHandler({ systemPrompt: '', messages: [userMessage('search NZ')] });
    expect(textOf(first?.messages?.[0])).toContain(CONVERSATION_MODE_REMINDER);

    // Same turn, second call: the model ran web_search and is about to synthesize.
    const second = contextHandler({
      systemPrompt: '',
      messages: [
        userMessage('search NZ'),
        { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'web_search' }] },
        toolResult('web_search'),
      ],
    });
    expect(textOf(second?.messages?.[2])).toContain(CONVERSATION_MODE_REMINDER);
  });

  it('stops at agent_end so the reminder cannot leak into a later turn', () => {
    const { signal, handler, contextHandler, agentEnd } = loadInlineExtension();
    signal.arm(true);
    handler({ systemPrompt: 'BASE', messages: [] });
    agentEnd({ systemPrompt: '', messages: [] });
    expect(signal.isTurnActive()).toBe(false);
    expect(contextHandler({ systemPrompt: '', messages: [userMessage('hi')] })).toBeUndefined();
  });

  it('an unflagged turn closes a spoken one even if agent_end never fired', () => {
    const { signal, handler, contextHandler } = loadInlineExtension();
    signal.arm(true);
    handler({ systemPrompt: 'BASE', messages: [] });
    // Next turn: conversation mode off (or a plain typed message).
    handler({ systemPrompt: 'BASE', messages: [] });
    expect(signal.isTurnActive()).toBe(false);
    expect(contextHandler({ systemPrompt: '', messages: [userMessage('hi')] })).toBeUndefined();
  });
});

describe('lockstep with the CLI-bridge extension twin', () => {
  it('injects the identical hint text', () => {
    expect(EXTENSION_HINT).toBe(CONVERSATION_MODE_HINT);
  });

  it('injects the identical tail reminder', () => {
    expect(EXTENSION_REMINDER).toBe(CONVERSATION_MODE_REMINDER);
  });

  it('places the tail reminder identically', () => {
    // The two implementations each stamp their own `Date.now()` on the reminder
    // message, so a deep-equal between them is a RACE: it passes only when both
    // calls land in the same millisecond, and fails by a millisecond or two under
    // load. Freeze the clock rather than exclude the field, so the comparison
    // still asserts that both stamp a timestamp AND that they agree on it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
    const cases: ContextMessageLike[][] = [
      [userMessage('hello?')],
      [userMessage('q'), { role: 'assistant', content: [{ type: 'text', text: 'a' }] }],
      [userMessage('q'), assistantSay(), toolResult('say')],
      [userMessage('q'), { role: 'assistant', content: [] }, toolResult('web_search')],
    ];
    for (const messages of cases) {
      expect(extensionWithReminder(messages)).toEqual(withConversationModeReminder(messages));
    }
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends identically, given the same base prompt', () => {
    const server = createConversationModeSignal();
    const extension = createExtensionSignal();
    server.arm(true);
    extension.arm(true);
    const base = 'BASE\n\nFROM ANOTHER EXTENSION';
    expect(extension.applyToSystemPrompt(base)).toBe(server.applyToSystemPrompt(base));
  });

  it('has the same latch behaviour: nothing unarmed, once when armed', () => {
    const extension = createExtensionSignal();
    expect(extension.applyToSystemPrompt('BASE')).toBeUndefined();
    extension.arm(true);
    expect(extension.applyToSystemPrompt('BASE')).toBe(appendConversationModeHint('BASE'));
    expect(extension.isArmed()).toBe(false);
    expect(extension.applyToSystemPrompt('BASE')).toBeUndefined();
    extension.arm(true);
    extension.arm(false);
    expect(extension.applyToSystemPrompt('BASE')).toBeUndefined();
  });

  it('has the same turn lifecycle for the tail reminder', () => {
    const server = createConversationModeSignal();
    const extension = createExtensionSignal();
    const messages = [userMessage('hello?')];
    for (const signal of [server, extension]) {
      expect(signal.applyToContext(messages)).toBeUndefined();
      signal.arm(true);
      // Still closed: the turn opens when before_agent_start consumes the arming.
      expect(signal.applyToContext(messages)).toBeUndefined();
      signal.applyToSystemPrompt('BASE');
      expect(signal.isTurnActive()).toBe(true);
      expect(textOf(signal.applyToContext(messages)?.[0])).toContain(CONVERSATION_MODE_REMINDER);
      signal.endTurn();
      expect(signal.applyToContext(messages)).toBeUndefined();
    }
  });

  it('the extension registers a before_agent_start handler wired to that latch', async () => {
    // The wiring itself (pi.on + arming from cli_message) lives in the extension's
    // big default export, which needs a whole pi runtime to load; assert the two
    // load-bearing lines are present so the twin cannot be left unwired.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../extension/src/index.ts', import.meta.url), 'utf-8'),
    );
    expect(source).toContain('pi.on("before_agent_start"');
    expect(source).toContain('conversationSignal.applyToSystemPrompt(event.systemPrompt)');
    expect(source).toContain('conversationSignal.arm(msg.conversationMode === true)');
    // ... and the tail-reminder half, which is what actually reaches smaller models.
    expect(source).toContain('pi.on("context"');
    expect(source).toContain('conversationSignal.applyToContext(event.messages)');
    expect(source).toContain('conversationSignal.endTurn()');
  });
});
