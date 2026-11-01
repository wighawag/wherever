import { describe, it, expect, afterEach } from 'vitest';
import { startHarness, type Harness } from './harness.js';

// Streamed deltas are coalesced per socket (delta-coalescer.ts): a reply the
// model streams one character at a time reaches the viewer in far fewer frames,
// with the same text, and every delta still precedes message_end.

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('streamed delta coalescing', () => {
  it('delivers a per-character stream in few frames, intact and in order', async () => {
    const reply = 'The quick brown fox jumps over the lazy dog. '.repeat(6);
    h = await startHarness({ initial: { kind: 'slow-reply', text: reply, charDelayMs: 2 } });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');
    c.send({ type: 'message', message: 'go', sessionId: created.sessionId });
    await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);

    const updates = c.messages.filter((m) => m.type === 'message_update');
    expect(updates.map((m) => m.delta).join('')).toBe(reply);
    // One frame per character before; ~50 ms windows now.
    expect(updates.length).toBeLessThan(reply.length / 4);
    const lastUpdate = c.messages.lastIndexOf(updates[updates.length - 1]);
    const end = c.messages.findIndex((m) => m.type === 'message_end' && m.role === 'assistant');
    expect(lastUpdate).toBeLessThan(end);
  }, 60_000);
});
