import { describe, it, expect } from 'vitest';
import { ReplyRouting, WEB_ORIGIN } from '../src/reply-routing.ts';

/**
 * The pure per-user-message routing queues (ADR 0014), alone: what the pool
 * records per send, what a user `message_end` takes, and how a settle trims.
 * Matching is by POSITION, never by text, so nothing here sees message text.
 */

describe('ReplyRouting', () => {
  it('starts with no destination and attributes in send order (prompt, then steers)', () => {
    const r = new ReplyRouting();
    expect(r.destination()).toBeNull();
    const a = r.record('telegram', 'promptOrSteer');
    const b = r.record(WEB_ORIGIN, 'promptOrSteer');
    r.started(a);
    r.queued(b);
    expect(r.takeForUserMessage()).toBe('telegram');
    expect(r.destination()).toBe('telegram');
    expect(r.takeForUserMessage()).toBe('none');
    expect(r.destination()).toBe('none');
  });

  it('a user message with nothing recorded gets no origin', () => {
    const r = new ReplyRouting();
    r.record('telegram', 'promptOrSteer');
    r.takeForUserMessage();
    expect(r.takeForUserMessage()).toBeNull();
    expect(r.destination()).toBeNull();
  });

  it('steers are delivered before follow-ups', () => {
    const r = new ReplyRouting();
    const f = r.record('schedule:j1', 'followUp');
    const s = r.record('telegram', 'promptOrSteer');
    r.queued(f);
    r.queued(s);
    expect(r.takeForUserMessage()).toBe('telegram');
    expect(r.takeForUserMessage()).toBe('schedule:j1');
  });

  it('a started prompt jumps ahead of steers still queued from an aborted run', () => {
    const r = new ReplyRouting();
    const old = r.record('telegram', 'promptOrSteer');
    r.queued(old);
    const p = r.record('schedule:j1', 'promptOrSteer');
    r.started(p);
    expect(r.takeForUserMessage()).toBe('schedule:j1');
    expect(r.takeForUserMessage()).toBe('telegram');
  });

  it('a follow-up send that STARTED a run (idle) answers as a prompt', () => {
    const r = new ReplyRouting();
    const f = r.record('telegram', 'followUp');
    r.started(f);
    expect(r.snapshot()).toEqual({ promptOrSteer: ['telegram'], followUp: [] });
    expect(r.takeForUserMessage()).toBe('telegram');
  });

  it('a dropped entry (handled / threw) leaves no slot', () => {
    const r = new ReplyRouting();
    const handled = r.record('telegram', 'promptOrSteer');
    const next = r.record(WEB_ORIGIN, 'promptOrSteer');
    r.drop(handled);
    r.started(next);
    expect(r.takeForUserMessage()).toBe('none');
    expect(r.takeForUserMessage()).toBeNull();
  });

  it('a delivered queued entry is preferred over one still awaiting its preflight', () => {
    const r = new ReplyRouting();
    const inFlight = r.record('telegram', 'promptOrSteer'); // still in pi's input handlers
    const f = r.record('schedule:j1', 'followUp');
    r.queued(f);
    expect(r.takeForUserMessage()).toBe('schedule:j1');
    r.queued(inFlight);
    expect(r.takeForUserMessage()).toBe('telegram');
  });

  it('settle trim keeps the NEWEST delivered-to-pi entries, up to pi\'s queue length', () => {
    const r = new ReplyRouting();
    for (const o of ['a', 'b', 'c']) r.queued(r.record(o, 'promptOrSteer'));
    r.queued(r.record('f1', 'followUp'));
    r.queued(r.record('f2', 'followUp'));
    r.trimToPiQueues(1, 0);
    expect(r.snapshot()).toEqual({ promptOrSteer: ['c'], followUp: [] });
  });

  it('settle trim keeps sends still awaiting their preflight, drops deferred ones from an earlier settle', () => {
    const r = new ReplyRouting();
    const pending = r.record('telegram', 'promptOrSteer');
    const deferred = r.record('schedule:j1', 'promptOrSteer');
    r.deferred(deferred);
    r.trimToPiQueues(0, 0);
    expect(r.snapshot()).toEqual({ promptOrSteer: ['telegram'], followUp: [] });
    r.started(pending);
    expect(r.takeForUserMessage()).toBe('telegram');
  });

  it('a deferred entry whose preflight then fires is no longer deferred', () => {
    const r = new ReplyRouting();
    const d = r.record('schedule:j1', 'promptOrSteer');
    r.deferred(d);
    r.started(d);
    r.trimToPiQueues(0, 0); // a later settle before its message_end would drop a stale started one
    expect(r.snapshot()).toEqual({ promptOrSteer: [], followUp: [] });
  });

  it('clear drops what pi had queued but keeps sends not yet in pi', () => {
    const r = new ReplyRouting();
    r.queued(r.record('telegram', 'promptOrSteer'));
    r.queued(r.record('schedule:j1', 'followUp'));
    r.record('later', 'promptOrSteer');
    expect(r.clear()).toEqual({ promptOrSteer: ['telegram'], followUp: ['schedule:j1'] });
    expect(r.snapshot()).toEqual({ promptOrSteer: ['later'], followUp: [] });
  });

  it('empty drops everything (CLI settle), destination is kept', () => {
    const r = new ReplyRouting();
    r.relayed(r.record('telegram', 'promptOrSteer'));
    r.takeForUserMessage();
    r.relayed(r.record('x', 'promptOrSteer'));
    r.relayed(r.record('y', 'followUp'));
    r.empty();
    expect(r.snapshot()).toEqual({ promptOrSteer: [], followUp: [] });
    expect(r.destination()).toBe('telegram');
  });

  it('a stale ticket is ignored', () => {
    const r = new ReplyRouting();
    const t = r.record('telegram', 'promptOrSteer');
    r.relayed(t);
    r.takeForUserMessage();
    r.started(t);
    r.drop(t);
    expect(r.snapshot()).toEqual({ promptOrSteer: [], followUp: [] });
  });
});
