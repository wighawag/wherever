/**
 * Coalesce streamed deltas into fewer WebSocket frames, per socket.
 *
 * Every streamed token used to be its own frame: a ~4-character `text_delta`
 * wrapped in ~60 bytes of JSON (type + a 36-character session id), below the
 * permessage-deflate threshold and so uncompressed, then TLS/TCP framing on top.
 * On a slow phone link that was over an order of magnitude more bytes than the
 * text itself, plus one client re-render per token.
 *
 * Rules (the reason this is safe for every client, old or new):
 * - Only APPEND-ONLY deltas are held: `message_update`, `thinking_update` (keyed
 *   by session) and `tool_update` (keyed by session + tool name). For each, the
 *   client appends `delta` to the streaming message, so one frame carrying
 *   `d1 + d2` renders exactly like `d1` then `d2`.
 * - ORDER IS NEVER CHANGED: any other frame (and a delta with another key)
 *   flushes the held delta first, then goes out. So `message_end`, `tool_end`,
 *   `agent_end` etc. always follow every delta that preceded them.
 * - A held delta goes out after `windowMs` (default 50 ms, imperceptible), or at
 *   once when it reaches `maxChars` (keeps frames well under the chunking size).
 * - Backpressure: while the socket still has unsent data (`isBackedUp`), the
 *   held delta keeps growing instead of queueing yet another frame behind it, up
 *   to `maxHoldMs`. A client that fell behind thus catches up in a few large
 *   frames instead of thousands of tiny ones. Nothing is ever dropped.
 */

export type DeltaMessage =
  | { type: 'message_update'; sessionId: string; delta: string }
  | { type: 'thinking_update'; sessionId: string; delta: string }
  | { type: 'tool_update'; sessionId: string; toolName: string; delta: string };

export interface DeltaCoalescerOptions {
  windowMs?: number;
  maxChars?: number;
  maxHoldMs?: number;
  /** True while the transport still has unsent data queued. */
  isBackedUp?: () => boolean;
  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

export const DELTA_WINDOW_MS = 50;
export const DELTA_MAX_CHARS = 16 * 1024;
export const DELTA_MAX_HOLD_MS = 1_000;

function isDelta(msg: { type: string }): msg is DeltaMessage {
  return msg.type === 'message_update' || msg.type === 'thinking_update' || msg.type === 'tool_update';
}

function keyOf(msg: DeltaMessage): string {
  return msg.type === 'tool_update' ? `${msg.type}\0${msg.sessionId}\0${msg.toolName}` : `${msg.type}\0${msg.sessionId}`;
}

export class DeltaCoalescer<M extends { type: string }> {
  private held: DeltaMessage | null = null;
  private heldKey = '';
  private heldSince = 0;
  private timer: unknown = null;
  private readonly windowMs: number;
  private readonly maxChars: number;
  private readonly maxHoldMs: number;
  private readonly isBackedUp: () => boolean;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly now: () => number;

  constructor(
    private readonly write: (msg: M) => void,
    opts: DeltaCoalescerOptions = {},
  ) {
    this.windowMs = opts.windowMs ?? DELTA_WINDOW_MS;
    this.maxChars = opts.maxChars ?? DELTA_MAX_CHARS;
    this.maxHoldMs = opts.maxHoldMs ?? DELTA_MAX_HOLD_MS;
    this.isBackedUp = opts.isBackedUp ?? (() => false);
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as any).unref?.();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as any));
    this.now = opts.now ?? Date.now;
  }

  /** Send `msg`, holding it briefly if it is a delta that can be merged. */
  send(msg: M): void {
    if (!isDelta(msg)) {
      this.flush();
      this.write(msg);
      return;
    }
    const key = keyOf(msg);
    if (this.held && this.heldKey === key) {
      this.held = { ...this.held, delta: this.held.delta + msg.delta };
    } else {
      this.flush();
      this.held = { ...msg };
      this.heldKey = key;
      this.heldSince = this.now();
      this.arm();
    }
    if (this.held.delta.length >= this.maxChars) this.flush();
  }

  /** Send the held delta now, if any. */
  flush(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const held = this.held;
    this.held = null;
    this.heldKey = '';
    if (held) this.write(held as unknown as M);
  }

  /** Forget the held delta without sending it (the socket is gone). */
  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.held = null;
    this.heldKey = '';
  }

  private arm(): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.held) return;
      if (this.isBackedUp() && this.now() - this.heldSince < this.maxHoldMs) {
        this.arm();
        return;
      }
      this.flush();
    }, this.windowMs);
  }
}
