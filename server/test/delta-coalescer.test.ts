import { describe, it, expect } from 'vitest';
import { DeltaCoalescer } from '../src/delta-coalescer.js';

type Msg = { type: string; [k: string]: unknown };

// A manual clock: timers fire only when the test advances time.
function setup(opts: { backedUp?: () => boolean; maxChars?: number } = {}) {
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const out: Msg[] = [];
  const c = new DeltaCoalescer<Msg>((m) => out.push(m), {
    windowMs: 50,
    maxHoldMs: 1000,
    maxChars: opts.maxChars,
    isBackedUp: opts.backedUp,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = until;
  };
  return { c, out, advance };
}

const text = (delta: string, sessionId = 's1') => ({ type: 'message_update', sessionId, delta });

describe('DeltaCoalescer', () => {
  it('merges consecutive text deltas into one frame after the window', () => {
    const { c, out, advance } = setup();
    c.send(text('Hel'));
    c.send(text('lo, '));
    c.send(text('world'));
    expect(out).toEqual([]);
    advance(50);
    expect(out).toEqual([text('Hello, world')]);
  });

  it('flushes held deltas BEFORE any other frame, so order never changes', () => {
    const { c, out } = setup();
    c.send(text('partial'));
    c.send({ type: 'message_end', sessionId: 's1', content: 'partial', role: 'assistant' });
    expect(out.map((m) => m.type)).toEqual(['message_update', 'message_end']);
    expect(out[0].delta).toBe('partial');
  });

  it('never merges across kinds, sessions or tools', () => {
    const { c, out, advance } = setup();
    c.send({ type: 'thinking_update', sessionId: 's1', delta: 'hmm' });
    c.send(text('a'));
    c.send(text('b', 's2'));
    c.send({ type: 'tool_update', sessionId: 's1', toolName: 'bash', delta: 'x' });
    c.send({ type: 'tool_update', sessionId: 's1', toolName: 'bash', delta: 'y' });
    c.send({ type: 'tool_update', sessionId: 's1', toolName: 'read', delta: 'z' });
    advance(50);
    expect(out).toEqual([
      { type: 'thinking_update', sessionId: 's1', delta: 'hmm' },
      text('a'),
      text('b', 's2'),
      { type: 'tool_update', sessionId: 's1', toolName: 'bash', delta: 'xy' },
      { type: 'tool_update', sessionId: 's1', toolName: 'read', delta: 'z' },
    ]);
  });

  it('sends at once when the held delta reaches maxChars', () => {
    const { c, out } = setup({ maxChars: 10 });
    c.send(text('12345'));
    c.send(text('67890'));
    expect(out).toEqual([text('1234567890')]);
  });

  it('keeps growing while the socket is backed up, up to maxHoldMs, dropping nothing', () => {
    let backedUp = true;
    const { c, out, advance } = setup({ backedUp: () => backedUp });
    c.send(text('a'));
    advance(500);
    c.send(text('b'));
    expect(out).toEqual([]);
    advance(600); // past maxHoldMs (1000 ms since the first delta)
    expect(out).toEqual([text('ab')]);
    c.send(text('c'));
    backedUp = false;
    advance(50);
    expect(out).toEqual([text('ab'), text('c')]);
  });

  it('dispose drops the held delta and its timer', () => {
    const { c, out, advance } = setup();
    c.send(text('gone'));
    c.dispose();
    advance(100);
    expect(out).toEqual([]);
  });
});
