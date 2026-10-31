import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ChannelDispatcher,
  NO_CHANNEL_ERROR,
  destinationIsChannel,
  droppedByOrigin,
  type AssistantChannel,
  type ChannelContext,
  type ChannelDroppedReport,
  type ChannelNotification,
  type ChannelPoolPort,
  type ChannelReply,
} from '../src/assistant-channels.ts';
import { AssistantController, type AssistantPoolPort, type DroppedMessages } from '../src/assistant-controller.ts';

/**
 * The assistant's CHANNEL SEAM (assistant-channels.ts) with FAKE channels: notify
 * goes to every channel at once, replies follow the pool's current destination,
 * inbound messages reach the controller with the channel as origin (and `!` is
 * refused), and messages dropped by a reset or an aborted settle are reported
 * to the channels of their origins (through the REAL controller on a pool fake).
 * Temp assistant/state dirs; the real ~/.wherever is asserted untouched.
 */

const REAL_WHEREVER_DIR = path.join(os.homedir(), '.wherever');
const snapshot = (d: string) => {
  try {
    return fs.readdirSync(d).sort().map((n) => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`).join(',');
  } catch {
    return 'ABSENT';
  }
};
const realBefore = snapshot(REAL_WHEREVER_DIR);
afterAll(() => {
  expect(snapshot(REAL_WHEREVER_DIR)).toBe(realBefore);
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

class FakeChannel implements AssistantChannel {
  ctx: ChannelContext | null = null;
  notified: ChannelNotification[] = [];
  replies: ChannelReply[] = [];
  dropped: ChannelDroppedReport[] = [];
  stopped = false;
  constructor(
    readonly name: string,
    private opts: { notify?: 'ok' | 'fail' | 'throw' | 'none'; failStart?: boolean; hold?: Promise<void> } = {},
  ) {
    if (opts.notify === 'none') (this as { notify?: unknown }).notify = undefined;
  }
  start(ctx: ChannelContext) {
    if (this.opts.failStart) throw new Error('bad token');
    this.ctx = ctx;
  }
  stop() {
    this.stopped = true;
  }
  async notify(n: ChannelNotification) {
    await this.opts.hold;
    this.notified.push(n);
    if (this.opts.notify === 'throw') throw new Error('network down');
    return this.opts.notify === 'fail' ? { ok: false as const, error: 'no device' } : { ok: true as const, detail: 'sent' };
  }
  deliverReply(r: ChannelReply) {
    this.replies.push(r);
  }
  reportDropped(r: ChannelDroppedReport) {
    this.dropped.push(r);
  }
}

class FakeEvents implements ChannelPoolPort {
  listeners = new Set<(f: string, e: { type: string }, d: string | null) => void>();
  subscribeEvents(l: (f: string, e: { type: string }, d: string | null) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(file: string, type: string, destination: string | null) {
    for (const l of this.listeners) l(file, { type }, destination);
  }
}

const note: ChannelNotification = { title: 'Done', body: 'CI is green', source: 'app', navigate: 'sess-1' };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('notify', () => {
  it('goes to EVERY started channel that can notify, at once, and is ok when one delivered', async () => {
    const a = new FakeChannel('webpush');
    const b = new FakeChannel('telegram', { notify: 'fail' });
    const c = new FakeChannel('replies-only', { notify: 'none' });
    const d = new ChannelDispatcher({ controller: { send: async () => {} }, pool: new FakeEvents(), channels: [a, b, c] });
    await d.start();
    expect(d.notifyChannels()).toEqual(['webpush', 'telegram']);
    const r = await d.notify(note);
    expect(r).toEqual({
      ok: true,
      deliveries: [
        { channel: 'webpush', result: { ok: true, detail: 'sent' } },
        { channel: 'telegram', result: { ok: false, error: 'no device' } },
      ],
    });
    expect(a.notified).toEqual([note]);
    expect(b.notified).toEqual([note]);
  });

  it('never waits on a running turn: it is delivered while the pool is mid-run', async () => {
    const a = new FakeChannel('webpush');
    const events = new FakeEvents();
    const d = new ChannelDispatcher({ controller: { send: async () => {} }, pool: events, channels: [a] });
    await d.start();
    events.emit('/s.jsonl', 'agent_start', 'telegram');
    const r = await d.notify(note);
    expect(r.ok).toBe(true);
    expect(a.notified).toHaveLength(1);
    // The channels are called in parallel: a slow one does not hold another.
    let release!: () => void;
    const slow = new FakeChannel('slow', { hold: new Promise<void>((res) => (release = res)) });
    const fast = new FakeChannel('fast');
    const d2 = new ChannelDispatcher({ controller: { send: async () => {} }, pool: events, channels: [slow, fast] });
    await d2.start();
    const pending = d2.notify(note);
    await tick();
    expect(fast.notified).toHaveLength(1);
    expect(slow.notified).toHaveLength(0);
    release();
    expect((await pending).ok).toBe(true);
  });

  it('with no channel able to notify, a clear error; all failing, an error naming each', async () => {
    const none = new ChannelDispatcher({ controller: { send: async () => {} }, pool: new FakeEvents(), channels: [] });
    await none.start();
    expect(await none.notify(note)).toEqual({ ok: false, error: NO_CHANNEL_ERROR, deliveries: [] });
    // A channel that failed to start does not count.
    const broken = new ChannelDispatcher({
      controller: { send: async () => {} },
      pool: new FakeEvents(),
      channels: [new FakeChannel('telegram', { failStart: true })],
    });
    await broken.start();
    expect((await broken.notify(note)) as { error: string }).toMatchObject({ ok: false, error: NO_CHANNEL_ERROR });
    const failing = new ChannelDispatcher({
      controller: { send: async () => {} },
      pool: new FakeEvents(),
      channels: [new FakeChannel('webpush', { notify: 'fail' }), new FakeChannel('telegram', { notify: 'throw' })],
    });
    await failing.start();
    const r = await failing.notify(note);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('the notification reached no device (webpush: no device; telegram: network down)');
  });

  it('refuses two channels with one name', () => {
    expect(() => new ChannelDispatcher({ controller: { send: async () => {} }, pool: new FakeEvents(), channels: [new FakeChannel('x'), new FakeChannel('x')] })).toThrow();
  });
});

describe('inbound and replies', () => {
  it('a channel message reaches the controller with the channel as origin; ! is refused', async () => {
    const sent: Array<[string, string]> = [];
    const t = new FakeChannel('telegram');
    const d = new ChannelDispatcher({ controller: { send: async (text, origin) => void sent.push([text, origin]) }, pool: new FakeEvents(), channels: [t] });
    await d.start();
    expect(await t.ctx!.onUserMessage({ channel: 'telegram', text: 'hi there', senderId: '42' })).toEqual({ accepted: true });
    expect(await t.ctx!.onUserMessage({ channel: 'telegram', text: '  !rm -rf /' })).toMatchObject({ accepted: false });
    expect(await t.ctx!.onUserMessage({ channel: 'telegram', text: '!!ls' })).toMatchObject({ accepted: false });
    expect(await t.ctx!.onUserMessage({ channel: 'telegram', text: '   ' })).toMatchObject({ accepted: false });
    expect(sent).toEqual([['hi there', 'telegram']]);
    await d.stop();
    expect(t.stopped).toBe(true);
    expect(await t.ctx!.onUserMessage({ channel: 'telegram', text: 'late' })).toMatchObject({ accepted: false });
  });

  it('output is delivered to the channel of its CURRENT destination only', async () => {
    const t = new FakeChannel('telegram');
    const w = new FakeChannel('webpush');
    const events = new FakeEvents();
    const d = new ChannelDispatcher({ controller: { send: async () => {} }, pool: events, channels: [t, w] });
    await d.start();
    events.emit('/a.jsonl', 'message_update', 'telegram');
    events.emit('/a.jsonl', 'message_update', 'telegram:chat-7');
    events.emit('/a.jsonl', 'message_update', 'none');
    events.emit('/a.jsonl', 'message_update', 'schedule:j1');
    events.emit('/a.jsonl', 'message_update', null);
    events.emit('/a.jsonl', 'message_update', 'telegramx');
    expect(t.replies.map((r) => r.destination)).toEqual(['telegram', 'telegram:chat-7']);
    expect(w.replies).toEqual([]);
    await d.stop();
    events.emit('/a.jsonl', 'message_update', 'telegram');
    expect(t.replies).toHaveLength(2);
  });

  it('destinationIsChannel matches the name or a name:<sub>', () => {
    expect(destinationIsChannel('telegram', 'telegram')).toBe(true);
    expect(destinationIsChannel('telegram:1', 'telegram')).toBe(true);
    expect(destinationIsChannel('telegramx', 'telegram')).toBe(false);
    expect(destinationIsChannel(null, 'telegram')).toBe(false);
  });
});

/** A pool fake for the REAL controller: one streaming session with queued messages and their origins. */
class QueuePool implements AssistantPoolPort {
  streaming = true;
  queues = new Map<string, { steering: string[]; followUp: string[]; origins: { steering: Array<string | null>; followUp: Array<string | null> } }>();
  private n = 0;
  constructor(private root: string) {}
  async createNewSession(cwd: string) {
    this.n += 1;
    const tracked = { sessionId: `id-${this.n}`, sessionFile: path.join(this.root, `s${this.n}.jsonl`), cwd };
    return { tracked };
  }
  async loadSession(sessionFile: string) {
    return { tracked: { sessionId: 'x', sessionFile, cwd: this.root } };
  }
  getSession(sessionFile: string) {
    return { sessionId: 'x', sessionFile, cwd: this.root };
  }
  isStreaming() {
    return this.streaming;
  }
  async abortSession() {
    this.streaming = false;
  }
  clearQueuedMessages(sessionFile: string) {
    const q = this.queues.get(sessionFile) ?? null;
    this.queues.delete(sessionFile);
    return q;
  }
  async sendUserMessage() {}
  pinSession() {}
  unpinSession() {}
}

describe('dropped messages are reported to the channels of their origins', () => {
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-channels-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const folder = path.join(root, 'assistant');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(folder, { recursive: true });
    const pool = new QueuePool(root);
    const telegram = new FakeChannel('telegram');
    const webpush = new FakeChannel('webpush');
    let dispatcher: ChannelDispatcher | null = null;
    const controller = new AssistantController({ pool, folder, stateDir, onDropped: (d) => dispatcher?.reportDropped(d) });
    dispatcher = new ChannelDispatcher({ controller, pool: new FakeEvents(), channels: [telegram, webpush] });
    return { pool, controller, dispatcher, telegram, webpush };
  }

  it('by a reset', async () => {
    const { pool, controller, dispatcher, telegram, webpush } = setup();
    await dispatcher.start();
    const cur = await controller.ensureCurrent();
    pool.queues.set(cur.sessionFile, {
      steering: ['steer from telegram', 'steer from the web', 'older, unknown'],
      followUp: ['follow-up from telegram', 'a job'],
      origins: { steering: ['telegram', 'none', null], followUp: ['telegram:chat-1', 'schedule:j1'] },
    });
    await controller.reset();
    await tick();
    expect(telegram.dropped).toEqual([
      {
        sessionFile: cur.sessionFile,
        reason: 'reset',
        messages: ['steer from telegram', 'follow-up from telegram'],
        at: expect.any(String),
      },
    ]);
    // The web, the scheduler and unknown origins are reported to nobody.
    expect(webpush.dropped).toEqual([]);
  });

  it('by an aborted settle (the scheduler clears after it)', async () => {
    const { pool, controller, dispatcher, telegram } = setup();
    await dispatcher.start();
    const cur = await controller.ensureCurrent();
    pool.queues.set(cur.sessionFile, { steering: ['are you there?'], followUp: [], origins: { steering: ['telegram'], followUp: [] } });
    controller.clearAfterAbort(cur.sessionFile);
    await tick();
    expect(telegram.dropped).toEqual([{ sessionFile: cur.sessionFile, reason: 'aborted', messages: ['are you there?'], at: expect.any(String) }]);
  });

  it('a record without origins (an older pool) attributes nothing', () => {
    const d: DroppedMessages = { sessionFile: '/s', reason: 'reset', steering: ['a'], followUp: ['b'], at: 'now' };
    expect(droppedByOrigin(d)).toEqual(new Map());
    expect(
      droppedByOrigin({ ...d, origins: { steering: ['telegram'], followUp: ['telegram'] } }),
    ).toEqual(new Map([['telegram', ['a', 'b']]]));
  });
});

describe('channel commands and the dispatch hook (telegram-conversation)', () => {
  it('a channel message is sent as a steer-if-busy with the dispatch hook; reset and abort reach the controller', async () => {
    const calls: Array<unknown[]> = [];
    const controller = {
      send: async (text: string, origin: string, behavior?: string, opts?: { onDispatch?: (d: { sessionFile: string; steered: boolean }) => void }) => {
        calls.push(['send', text, origin, behavior]);
        opts?.onDispatch?.({ sessionFile: '/s.jsonl', steered: true });
      },
      reset: async () => {
        calls.push(['reset']);
      },
      abortCurrent: async () => {
        calls.push(['abort']);
        return true;
      },
    };
    const t = new FakeChannel('telegram');
    const d = new ChannelDispatcher({ controller, pool: new FakeEvents(), channels: [t] });
    await d.start();
    const dispatched: boolean[] = [];
    expect(await t.ctx!.onUserMessage({ channel: 'telegram', text: '/skill:x go' }, { onDispatched: (r) => dispatched.push(r.steered) })).toEqual({ accepted: true });
    expect(dispatched).toEqual([true]);
    expect(await t.ctx!.resetSession()).toEqual({ ok: true });
    expect(await t.ctx!.abortTurn()).toEqual({ aborted: true });
    expect(calls).toEqual([['send', '/skill:x go', 'telegram', 'steer'], ['reset'], ['abort']]);

    // A controller failing to reset answers an error, never throws to the channel.
    const failing = new ChannelDispatcher({
      controller: { send: async () => {}, reset: async () => Promise.reject(new Error('disk full')), abortCurrent: async () => false },
      pool: new FakeEvents(),
      channels: [new FakeChannel('telegram')],
    });
    await failing.start();
    const ft = (failing as any).channels[0] as FakeChannel;
    expect(await ft.ctx!.resetSession()).toEqual({ ok: false, error: 'disk full' });
    expect(await ft.ctx!.abortTurn()).toEqual({ aborted: false });
  });
});
