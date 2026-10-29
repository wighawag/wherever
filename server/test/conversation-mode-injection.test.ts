import { describe, it, expect, afterEach } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import {
  CONVERSATION_MODE_HINT,
  CONVERSATION_MODE_REMINDER_MARKER,
} from '../src/conversation-mode-hint.ts';

// End-to-end (real server + real pi + fake LLM): with the per-turn
// conversation-mode flag on the message, the assembled SYSTEM PROMPT that reaches
// the model must carry the hint telling the agent to also call `say`; without the
// flag it must be byte-identical to before. This is the whole point of the
// feature: the agent could not previously tell a spoken conversation was active.
//
// The CLI-bridge half is covered too: the server must RELAY the flag on
// `cli_message` so the extension's own before_agent_start handler can inject the
// same hint in the bridged terminal pi.

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** The `system` field of the last upstream request, flattened to a string. */
function lastSystemPrompt(harness: Harness): string {
  const reqs = harness.fake.requests();
  expect(reqs.length).toBeGreaterThan(0);
  return JSON.stringify(reqs[reqs.length - 1]?.system ?? '');
}

/** The user text of the last upstream request, flattened to a string. */
function lastRequestMessages(harness: Harness): string {
  const reqs = harness.fake.requests();
  return JSON.stringify(reqs[reqs.length - 1]?.messages ?? []);
}

/** The messages of the Nth (0-based) upstream request, flattened to a string. */
function requestMessages(harness: Harness, index: number): string {
  return JSON.stringify(harness.fake.requests()[index]?.messages ?? []);
}

/** The LAST message of the Nth (0-based) upstream request, flattened to a string. */
function requestTailMessage(harness: Harness, index: number): string {
  const messages = (harness.fake.requests()[index]?.messages ?? []) as unknown[];
  return JSON.stringify(messages[messages.length - 1] ?? null);
}

async function waitForRequests(harness: Harness, count: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (harness.fake.requests().length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(harness.fake.requests().length).toBeGreaterThanOrEqual(count);
}

describe('conversation-mode injection (server-created session)', () => {
  it('appends the hint to the system prompt for a turn whose message carried the flag', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'spoken and written' } });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');

    c.send({
      type: 'message',
      message: 'how did the build go?',
      sessionId: created.sessionId,
      conversationMode: true,
    });
    await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);

    expect(lastSystemPrompt(h)).toContain(CONVERSATION_MODE_HINT);
    // The user's message is preserved VERBATIM: the signal never rewrites what
    // the human said, it only rides ALONGSIDE it in the ephemeral context.
    expect(lastRequestMessages(h)).toContain('how did the build go?');
    expect(lastRequestMessages(h)).not.toContain(CONVERSATION_MODE_HINT);
  }, 60_000);

  it('appends nothing when the flag is absent (older client / mode off)', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'written only' } });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');

    c.send({ type: 'message', message: 'plain typed question', sessionId: created.sessionId });
    await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);

    expect(lastSystemPrompt(h)).not.toContain(CONVERSATION_MODE_HINT);
  }, 60_000);

  it('is per-turn: a following unflagged message gets no hint', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'ok' } });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');

    c.send({
      type: 'message',
      message: 'first, spoken',
      sessionId: created.sessionId,
      conversationMode: true,
    });
    await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
    expect(lastSystemPrompt(h)).toContain(CONVERSATION_MODE_HINT);

    // The user turned conversation mode off (or switched to typing): the very next
    // turn must be back to the untouched prompt.
    c.send({ type: 'message', message: 'second, typed', sessionId: created.sessionId });
    await c.waitFor(
      (m) => m.type === 'message_end' && m.role === 'assistant' && m.content === 'ok',
      30_000,
    );
    // Wait until the SECOND upstream request has been recorded.
    const deadline = Date.now() + 10_000;
    while (h.fake.requests().length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(h.fake.requests().length).toBeGreaterThanOrEqual(2);
    expect(lastSystemPrompt(h)).not.toContain(CONVERSATION_MODE_HINT);
  }, 90_000);
});

describe('conversation-mode TAIL reminder (server-created session)', () => {
  it('rides the tail of every LLM call of the turn, including after a tool result', async () => {
    // A turn with a tool call makes TWO upstream calls: the first decides to run
    // the tool, the second synthesizes the answer from its result. That SECOND
    // call is where a system-prompt-only hint measurably stops working, so it is
    // the one that must carry the reminder at the tail.
    h = await startHarness({
      initial: { kind: 'tool-call', toolName: 'bash', input: { command: 'echo hello' } },
    });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');

    c.send({
      type: 'message',
      message: 'run the build',
      sessionId: created.sessionId,
      conversationMode: true,
    });
    // Once the first call has been seen, let the second one answer with text.
    await waitForRequests(h, 1);
    h.setNext({ kind: 'reply', text: 'the build passed' });
    await c.waitFor(
      (m) => m.type === 'message_end' && m.role === 'assistant' && m.content === 'the build passed',
      30_000,
    );
    await waitForRequests(h, 2);

    // First call: the reminder rides the user turn at the tail.
    expect(requestTailMessage(h, 0)).toContain(CONVERSATION_MODE_REMINDER_MARKER);
    // Second call (post tool result): still at the very tail, next to the output
    // the model is about to summarize.
    expect(requestTailMessage(h, 1)).toContain(CONVERSATION_MODE_REMINDER_MARKER);
    // Role-safe: it rides INSIDE the tool-result turn rather than opening a second
    // consecutive user turn (which Bedrock and some proxies reject).
    const tail = JSON.parse(requestTailMessage(h, 1)) as { role: string; content: unknown[] };
    expect(tail.role).toBe('user');
    expect(JSON.stringify(tail.content)).toContain('tool_result');
  }, 90_000);

  it('stops nudging once the agent has actually called say (no say loop)', async () => {
    h = await startHarness({
      initial: { kind: 'tool-call', toolName: 'say', input: { text: 'the build passed' } },
    });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');

    c.send({
      type: 'message',
      message: 'how did the build go?',
      sessionId: created.sessionId,
      conversationMode: true,
    });
    await waitForRequests(h, 1);
    h.setNext({ kind: 'reply', text: 'the build passed' });
    await c.waitFor(
      (m) => m.type === 'message_end' && m.role === 'assistant' && m.content === 'the build passed',
      30_000,
    );
    await waitForRequests(h, 2);

    expect(requestMessages(h, 0)).toContain(CONVERSATION_MODE_REMINDER_MARKER);
    // The turn has spoken: re-asking could make the model speak again, and again.
    expect(requestMessages(h, 1)).not.toContain(CONVERSATION_MODE_REMINDER_MARKER);
  }, 90_000);

  it('is EPHEMERAL: a later turn carries no trace of it in the history', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'ok' } });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');

    c.send({
      type: 'message',
      message: 'first, spoken',
      sessionId: created.sessionId,
      conversationMode: true,
    });
    await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
    expect(requestMessages(h, 0)).toContain(CONVERSATION_MODE_REMINDER_MARKER);

    c.send({ type: 'message', message: 'second, typed', sessionId: created.sessionId });
    await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
    await waitForRequests(h, 2);

    // The second turn replays the first from the session file. If the reminder had
    // been persisted into the transcript it would show up here; it must not, and
    // the unflagged turn gets no reminder of its own either.
    expect(lastRequestMessages(h)).toContain('first, spoken');
    expect(lastRequestMessages(h)).not.toContain(CONVERSATION_MODE_REMINDER_MARKER);
    expect(lastSystemPrompt(h)).not.toContain(CONVERSATION_MODE_HINT);
  }, 90_000);
});

describe('conversation-mode relay (CLI-bridge session)', () => {
  it('relays the flag on cli_message so the bridged pi can inject the same hint', async () => {
    h = await startHarness();

    // Act as the pi CLI bridge and register a session.
    const cli = await h.connect();
    await cli.waitForType('connected');
    const sessionFile = `${cli.workspace}/cli-conversation.jsonl`;
    cli.send({ type: 'cli_register', sessionFile, cwd: cli.workspace, model: 'fake:fake-model' });
    await h.waitForActive(sessionFile);

    // The web client (phone, conversation mode ON) joins that session and sends.
    const web = await h.connect();
    await web.waitForType('connected');
    web.send({ type: 'session_load', sessionFile });
    const created = await web.waitForType('session_created', 15_000);

    web.send({
      type: 'message',
      message: 'speak this one',
      sessionId: created.sessionId,
      conversationMode: true,
    });
    const relayed = await cli.waitFor((m) => m.type === 'cli_message', 15_000);
    expect(relayed.message).toBe('speak this one');
    expect(relayed.conversationMode).toBe(true);

    // With the mode off the field is omitted entirely, so the relayed payload is
    // exactly what an older extension already understands.
    web.send({ type: 'message', message: 'typed one', sessionId: created.sessionId });
    const plain = await cli.waitFor(
      (m) => m.type === 'cli_message' && m.message === 'typed one',
      15_000,
    );
    expect('conversationMode' in plain).toBe(false);
  }, 60_000);
});
