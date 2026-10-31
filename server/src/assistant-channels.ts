import type { DroppedMessages } from './assistant-controller.js';

/**
 * The assistant's CHANNEL SEAM (spec `assistant-session-and-channels`, ADRs 0014
 * and 0017): the one interface every transport implements (Web Push now,
 * Telegram next, WhatsApp later), and the dispatcher that connects the channels
 * to the controller and the session pool.
 *
 * A channel's `name` is also its ROUTING ORIGIN (ADR 0014): a user message it
 * feeds in is sent with `origin = name`, and output whose current destination
 * is that origin is handed back to it as a reply. Everything else the assistant
 * says reaches a channel ONLY through `notify` (`assistant_notify`), which is
 * always immediate: it never waits for a running turn.
 *
 * Every capability but `start` / `stop` is optional: Web Push implements
 * `notify` only (it never originates a message and never shows replies).
 *
 * Channels exist only while the assistant is ACTIVE (configured AND this server
 * holds the folder lock): `server/src/index.ts` builds the dispatcher beside the
 * controller and scheduler, so with `assistantFolder` unset or refused no
 * channel is built, started or polled.
 */

/** A file a channel received with a user message (downloaded to a local path by the channel). */
export interface ChannelFile {
  path: string;
  name?: string;
  mimeType?: string;
}

/** A user message a channel received (Telegram text, ...). */
export interface ChannelUserMessage {
  /** The channel's name (= the routing origin the reply comes back to). */
  channel: string;
  text: string;
  files?: ChannelFile[];
  /** The channel-side sender (a Telegram user id, ...), for logs. */
  senderId?: string;
}

/** What `onUserMessage` answers: refused messages never reach the pool. */
export type ChannelInboundResult = { accepted: true } | { accepted: false; reason: string };

/** The context a channel gets at `start`. */
export interface ChannelContext {
  /** Feed a user message to the CURRENT assistant session (controller `send`, origin = the channel). */
  onUserMessage(message: ChannelUserMessage): Promise<ChannelInboundResult>;
}

/**
 * One `assistant_notify`, channel-agnostic. `navigate` is the SESSION ID a tap
 * opens (each channel builds its own link: Web Push `/#<sessionId>`).
 */
export interface ChannelNotification {
  title: string;
  body: string;
  /** Who notified: the origin folder (or session) name. */
  source: string;
  /** The session id the notification opens. */
  navigate: string;
  files?: ChannelFile[];
}

export type ChannelNotifyResult = { ok: true; detail?: string } | { ok: false; error: string };

/** A pool event whose current destination is this channel (a reply to its message). */
export interface ChannelReply {
  sessionFile: string;
  /** The routing destination (the channel's name, possibly `name:<sub>`). */
  destination: string;
  event: { type: string; [k: string]: unknown };
}

/** Queued messages from this channel that a reset or an aborted settle dropped. */
export interface ChannelDroppedReport {
  sessionFile: string;
  reason: DroppedMessages['reason'];
  /** The dropped texts that came from this channel, oldest first. */
  messages: string[];
  at: string;
}

export interface AssistantChannel {
  /** Unique channel name, also its routing origin (`webpush`, `telegram`). */
  readonly name: string;
  start(ctx: ChannelContext): void | Promise<void>;
  stop(): void | Promise<void>;
  /** Deliver a notification NOW (never waits for a turn). */
  notify?(notification: ChannelNotification): Promise<ChannelNotifyResult>;
  /** Output answering a message this channel fed in. */
  deliverReply?(reply: ChannelReply): void | Promise<void>;
  /** Report messages from this channel that were dropped. */
  reportDropped?(report: ChannelDroppedReport): void | Promise<void>;
}

/** The slice of the controller the dispatcher drives (faked in tests). */
export interface ChannelControllerPort {
  send(text: string, origin: string): Promise<void>;
}

/** The slice of the session pool the dispatcher listens to (faked in tests). */
export interface ChannelPoolPort {
  subscribeEvents(listener: (sessionFile: string, event: { type: string; [k: string]: unknown }, destination: string | null) => void): () => void;
}

/** One channel's answer to a notify. */
export interface NotifyDelivery {
  channel: string;
  result: ChannelNotifyResult;
}

/** The whole notify: ok when at least one channel delivered. */
export type NotifyOutcome =
  | { ok: true; deliveries: NotifyDelivery[] }
  | { ok: false; error: string; deliveries: NotifyDelivery[] };

/** The error `assistant_notify` answers when no channel can notify. */
export const NO_CHANNEL_ERROR =
  'no notification channel is enabled on this server (turn on push notifications in the wherever settings on a device, or configure a channel such as Telegram)';

/** True when a routing destination belongs to `channel` (`telegram`, or `telegram:<sub>`). */
export function destinationIsChannel(destination: string | null, channel: string): boolean {
  return !!destination && (destination === channel || destination.startsWith(`${channel}:`));
}

/**
 * Group dropped texts by their routing origin. `origins` is aligned with the
 * texts (null = not known); a record without origins attributes nothing.
 */
export function droppedByOrigin(dropped: DroppedMessages): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (texts: string[], origins: Array<string | null> | undefined) => {
    texts.forEach((text, i) => {
      const origin = origins?.[i];
      if (!origin) return;
      const list = out.get(origin) ?? [];
      list.push(text);
      out.set(origin, list);
    });
  };
  add(dropped.steering, dropped.origins?.steering);
  add(dropped.followUp, dropped.origins?.followUp);
  return out;
}

export interface ChannelDispatcherOptions {
  controller: ChannelControllerPort;
  pool: ChannelPoolPort;
  channels: AssistantChannel[];
}

export class ChannelDispatcher {
  private readonly controller: ChannelControllerPort;
  private readonly pool: ChannelPoolPort;
  private readonly channels: AssistantChannel[];
  private started = new Set<AssistantChannel>();
  private unsubscribe: (() => void) | null = null;

  constructor(opts: ChannelDispatcherOptions) {
    const names = new Set<string>();
    for (const c of opts.channels) {
      if (names.has(c.name)) throw new Error(`two assistant channels are named "${c.name}"`);
      names.add(c.name);
    }
    this.controller = opts.controller;
    this.pool = opts.pool;
    this.channels = [...opts.channels];
  }

  /**
   * Start every channel (one that fails to start is logged and left out, so it
   * never takes the others or the server down) and subscribe to the pool's
   * event fan-out for replies.
   */
  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = this.pool.subscribeEvents((file, event, destination) => this.route(file, event, destination));
    for (const channel of this.channels) {
      try {
        await channel.start({ onUserMessage: (m) => this.onUserMessage(channel, m) });
        this.started.add(channel);
      } catch (err) {
        console.error(`[wherever] assistant channel "${channel.name}" failed to start: ${errMessage(err)}`);
      }
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const running = [...this.started];
    this.started.clear();
    await Promise.all(
      running.map(async (c) => {
        try {
          await c.stop();
        } catch (err) {
          console.error(`[wherever] assistant channel "${c.name}" failed to stop: ${errMessage(err)}`);
        }
      }),
    );
  }

  /** The started channels that can notify. */
  notifyChannels(): string[] {
    return this.channels.filter((c) => this.started.has(c) && c.notify).map((c) => c.name);
  }

  /**
   * Deliver to EVERY started channel that can notify, in parallel and at once.
   * Ok when at least one delivered; with none able to notify, the clear
   * `NO_CHANNEL_ERROR`.
   */
  async notify(n: ChannelNotification): Promise<NotifyOutcome> {
    const targets = this.channels.filter((c) => this.started.has(c) && c.notify);
    if (targets.length === 0) return { ok: false, error: NO_CHANNEL_ERROR, deliveries: [] };
    const deliveries = await Promise.all(
      targets.map(async (c): Promise<NotifyDelivery> => {
        try {
          return { channel: c.name, result: await c.notify!(n) };
        } catch (err) {
          return { channel: c.name, result: { ok: false, error: errMessage(err) } };
        }
      }),
    );
    if (deliveries.some((d) => d.result.ok)) return { ok: true, deliveries };
    const why = deliveries.map((d) => `${d.channel}: ${d.result.ok ? 'ok' : d.result.error}`).join('; ');
    return { ok: false, error: `the notification reached no device (${why})`, deliveries };
  }

  /**
   * The controller's `onDropped`: report each dropped message to the channel of
   * its routing origin. Messages from the web (`none`), the scheduler or no
   * known origin are reported to nobody (the web shows the session itself).
   */
  reportDropped(dropped: DroppedMessages): void {
    const byOrigin = droppedByOrigin(dropped);
    for (const channel of this.channels) {
      if (!this.started.has(channel) || !channel.reportDropped) continue;
      const messages: string[] = [];
      for (const [origin, texts] of byOrigin) if (destinationIsChannel(origin, channel.name)) messages.push(...texts);
      if (messages.length === 0) continue;
      const report: ChannelDroppedReport = { sessionFile: dropped.sessionFile, reason: dropped.reason, messages, at: dropped.at };
      void Promise.resolve()
        .then(() => channel.reportDropped!(report))
        .catch((err) => console.error(`[wherever] assistant channel "${channel.name}" failed to report dropped messages: ${errMessage(err)}`));
    }
  }

  /**
   * A channel's inbound message: to the controller with origin = the channel.
   * `!` / `!!` (the pool's shell path) is refused here for every channel, so no
   * transport can run a shell command without an agent turn (story 16).
   * Attached files are not forwarded yet (`telegram-files` adds them).
   */
  private async onUserMessage(channel: AssistantChannel, m: ChannelUserMessage): Promise<ChannelInboundResult> {
    if (!this.started.has(channel)) return { accepted: false, reason: 'the channel is not running' };
    if (typeof m.text !== 'string' || !m.text.trim()) return { accepted: false, reason: 'empty message' };
    if (m.text.trimStart().startsWith('!')) {
      return { accepted: false, reason: 'shell commands ("!") cannot be run from a channel; ask the assistant instead' };
    }
    await this.controller.send(m.text, channel.name);
    return { accepted: true };
  }

  private route(sessionFile: string, event: { type: string; [k: string]: unknown }, destination: string | null): void {
    if (!destination) return;
    for (const channel of this.channels) {
      if (!channel.deliverReply || !this.started.has(channel) || !destinationIsChannel(destination, channel.name)) continue;
      try {
        const out = channel.deliverReply({ sessionFile, destination, event });
        if (out && typeof (out as Promise<void>).then === 'function') {
          (out as Promise<void>).catch((err) => console.error(`[wherever] assistant channel "${channel.name}" reply failed: ${errMessage(err)}`));
        }
      } catch (err) {
        console.error(`[wherever] assistant channel "${channel.name}" reply failed: ${errMessage(err)}`);
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
