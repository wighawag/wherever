import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { DroppedMessages } from './assistant-controller.js';
import { WEB_ORIGIN } from './reply-routing.js';

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

/** Hooks of one inbound message. */
export interface ChannelInboundHooks {
  /**
   * Called once the message is handed to the assistant session, BEFORE the
   * send resolves (which, for a message that starts a turn, is only at the end
   * of that turn): `steered` is true when it went into a running turn as a
   * steer (ADR 0003), false when it started one.
   */
  onDispatched?(d: { steered: boolean }): void;
}

/** A channel command's answer (`/new`, `/reset`). */
export type ChannelCommandResult = { ok: true } | { ok: false; error: string };

/** The context a channel gets at `start`. */
export interface ChannelContext {
  /**
   * Feed a user message to the CURRENT assistant session (controller `send`,
   * origin = the channel). Into a running turn it STEERS, as the web composer
   * does (ADR 0003); `hooks.onDispatched` tells which happened.
   */
  onUserMessage(message: ChannelUserMessage, hooks?: ChannelInboundHooks): Promise<ChannelInboundResult>;
  /** Reset the assistant (a channel's `/new` / `/reset`): the controller's reset. Never throws. */
  resetSession(): Promise<ChannelCommandResult>;
  /** Abort the current assistant session's running turn (a channel's `stop`). Never throws. */
  abortTurn(): Promise<{ aborted: boolean }>;
  /**
   * A reply to a message this channel sent for a notification (a Telegram reply
   * to a kenning question: `ref` is one of the `refs` its `notify` returned).
   * `handled: true` = it answered something (send `reply` back); `handled:
   * false` = treat the message as an ordinary one. Never throws.
   */
  onNotificationReply?(reply: ChannelNotificationReply): Promise<ChannelNotificationReplyResult>;
}

/** A user's reply to a notification message (kenning's attention inbox, wherever ADR 0023). */
export interface ChannelNotificationReply {
  channel: string;
  /** `<channel>:<channel-side id>` of the message replied to, as `notify` returned it in `refs`. */
  ref: string;
  text: string;
}

export type ChannelNotificationReplyResult = { handled: false } | { handled: true; reply: string };

/** Who answers notification replies (the kenning inbox; none = every reply is an ordinary message). */
export type NotificationReplyHandler = (reply: ChannelNotificationReply) => ChannelNotificationReplyResult | Promise<ChannelNotificationReplyResult>;

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
  /**
   * `assistant_notify`'s `attachments`, validated and resolved (real paths). A
   * channel that can carry files sends them (Telegram, after the message); one
   * that cannot (Web Push) ignores them.
   */
  files?: ChannelFile[];
  /**
   * The notification asks the user something, and a reply to it answers
   * (`onNotificationReply`, a kenning question). `options` are its fixed
   * answers: a channel that can offers them as one-tap choices (Telegram
   * buttons), delivered as a reply with the option's text. A channel without
   * replies (Web Push) ignores it.
   */
  question?: { options: string[] };
}

/** How one attached file went out on a channel (`status` is the channel's own word: `document`, `missing`, ...). */
export interface ChannelFileOutcome {
  path: string;
  name: string;
  status: string;
  error?: string;
}

/**
 * `files`: set by a channel that carries files, one entry per `ChannelNotification.files` entry.
 * `refs`: `<channel>:<id>` of each message sent, set by a channel whose user can
 * REPLY to it (Telegram), so a reply can be matched (`onNotificationReply`).
 */
export type ChannelNotifyResult = { ok: true; detail?: string; files?: ChannelFileOutcome[]; refs?: string[] } | { ok: false; error: string };

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
  send(
    text: string,
    origin: string,
    streamingBehavior?: 'steer' | 'followUp',
    opts?: { onDispatch?: (d: { sessionFile: string; steered: boolean }) => void; images?: ImageContent[] },
  ): Promise<void>;
  /** The assistant reset (optional in fakes; a channel's `/new` then answers an error). */
  reset?(): Promise<unknown>;
  /** Abort the current session's running turn; true when one was running. */
  abortCurrent?(): Promise<boolean>;
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

/** Why a channel's `!` / `!!` message is refused (the pool's shell path is never reached). */
export const CHANNEL_SHELL_REFUSAL = 'shell commands ("!") cannot be run from a channel; ask the assistant instead';

/** The error `assistant_notify` answers when no channel can notify. */
export const NO_CHANNEL_ERROR =
  'no notification channel is enabled on this server (turn on push notifications in the wherever settings on a device, or configure a channel such as Telegram)';

/**
 * The text a channel message reaches the assistant as: its text, then one
 * `[Uploaded file: <path>]` line per file, or, with no text of its own, an
 * explicit "I have uploaded the following file(s) for you:" before them.
 * EXACTLY what the web composer sends for an upload (`buildAttachmentMessage`
 * in web/src/lib/core/attachments.ts; keep the two in step), so the agent reads
 * a Telegram file as it reads a web one.
 */
export function channelMessageText(text: string, files: ChannelFile[] | undefined): string {
  const trimmed = text.trim();
  const paths = (files ?? []).map((f) => f.path).filter((p) => typeof p === 'string' && p);
  if (paths.length === 0) return trimmed;
  const fileLines = paths.map((p) => `[Uploaded file: ${p}]`).join('\n');
  return trimmed ? `${trimmed}\n\n${fileLines}` : `I have uploaded the following file(s) for you:\n${fileLines}`;
}

/** Image extensions recognised for a channel file that carries no MIME type. */
const IMAGE_EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * The model IMAGE INPUTS of a channel message (task `pool-send-images`): every
 * file whose MIME type is `image/*` (a Telegram photo, or an image sent as a
 * document), or, with no MIME type, whose extension is a common image one,
 * read from its saved path as base64. The file stays a path in the text as well
 * (`channelMessageText`), so the agent can still open, move or attach it; pi
 * converts or resizes what the model needs, and drops it with a note for a
 * text-only model. A file that cannot be read is logged and left as a path only.
 */
export async function channelImages(files: ChannelFile[] | undefined): Promise<ImageContent[]> {
  const out: ImageContent[] = [];
  for (const f of files ?? []) {
    if (typeof f?.path !== 'string' || !f.path) continue;
    const mimeType = f.mimeType
      ? f.mimeType.toLowerCase().startsWith('image/')
        ? f.mimeType
        : null
      : (IMAGE_EXTENSION_MIME[path.extname(f.path).toLowerCase()] ?? null);
    if (!mimeType) continue;
    try {
      const bytes = await fs.readFile(f.path);
      out.push({ type: 'image', data: bytes.toString('base64'), mimeType });
    } catch (err) {
      console.warn(`[wherever] assistant channel: could not read image ${f.path} (${errMessage(err)}); sending its path only`);
    }
  }
  return out;
}

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

/** Every dropped text with its routing origin (null = not known), steering first. */
function droppedWithOrigins(dropped: DroppedMessages): Array<{ text: string; origin: string | null }> {
  const out: Array<{ text: string; origin: string | null }> = [];
  const add = (texts: string[], origins: Array<string | null> | undefined) =>
    texts.forEach((text, i) => out.push({ text, origin: origins?.[i] ?? null }));
  add(dropped.steering, dropped.origins?.steering);
  add(dropped.followUp, dropped.origins?.followUp);
  return out;
}

/**
 * The dropped texts the WEB must be told about (task
 * `web-sees-messages-dropped-from-the-assistant-session`): the web's own
 * (`WEB_ORIGIN`) and those of no known origin. An unknown origin is reported
 * nowhere else, and the web is where the session itself is shown, so it is
 * the one place left that keeps such a drop from being silent. Never a text
 * from a channel or a scheduled job.
 */
export function webDroppedMessages(dropped: DroppedMessages): string[] {
  return droppedWithOrigins(dropped)
    .filter((d) => d.origin === null || d.origin === WEB_ORIGIN)
    .map((d) => d.text);
}

/** The dropped texts a scheduled job sent (origin `schedule:<jobId>`, ADR 0014). */
export function scheduleDroppedMessages(dropped: DroppedMessages): Array<{ origin: string; text: string }> {
  return droppedWithOrigins(dropped)
    .filter((d): d is { text: string; origin: string } => !!d.origin && d.origin.startsWith('schedule:'))
    .map((d) => ({ origin: d.origin, text: d.text }));
}

/** The web `session_notice` naming dropped web texts (the web twin of Telegram's `formatDroppedReport`). */
export function formatWebDroppedNotice(reason: DroppedMessages['reason'], texts: string[]): string {
  const n = texts.length;
  const what = n === 1 ? 'this message' : `these ${n} messages`;
  const it = n === 1 ? 'it' : 'them';
  const head =
    reason === 'reset'
      ? `The assistant was reset before it read ${what}; send ${it} again if still needed:`
      : `Stopped before it read ${what}; send ${it} again if still needed:`;
  return [head, ...texts.map((t) => `• ${t}`)].join('\n');
}

/** Where the drops the channels do not take go (the server wires these, index.ts). */
export interface DroppedSinks {
  /** Tell the web viewers of `sessionFile` (a `session_notice`). */
  notifyWebViewers(sessionFile: string, message: string): void;
  /** Log a line (defaults to `console.log`). */
  log?(line: string): void;
}

/**
 * The rest of the controller's `onDropped`, beside `ChannelDispatcher.reportDropped`
 * (which reports channel-origin texts to their channel): the web's texts become
 * a notice to the session's web viewers, and a scheduled job's texts are logged,
 * so no drop is silent. Nothing at all for a drop with neither.
 */
export function reportDroppedBeyondChannels(dropped: DroppedMessages, sinks: DroppedSinks): void {
  const web = webDroppedMessages(dropped);
  if (web.length > 0) sinks.notifyWebViewers(dropped.sessionFile, formatWebDroppedNotice(dropped.reason, web));
  const log = sinks.log ?? ((line: string) => console.log(line));
  const what = dropped.reason === 'reset' ? 'reset' : 'aborted turn';
  for (const { origin, text } of scheduleDroppedMessages(dropped)) {
    const shown = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    log(`[wherever] assistant ${what} dropped the queued message of scheduled job ${origin} in ${dropped.sessionFile}: ${shown}`);
  }
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
  private notificationReplies: NotificationReplyHandler | null = null;

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
        await channel.start({
          onUserMessage: (m, hooks) => this.onUserMessage(channel, m, hooks),
          resetSession: () => this.resetSession(channel),
          abortTurn: () => this.abortTurn(channel),
          onNotificationReply: (r) => this.onNotificationReply(channel, r),
        });
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

  /** Who answers a reply to a notification (the kenning inbox, set in index.ts). */
  setNotificationReplyHandler(handler: NotificationReplyHandler | null): void {
    this.notificationReplies = handler;
  }

  private async onNotificationReply(channel: AssistantChannel, r: ChannelNotificationReply): Promise<ChannelNotificationReplyResult> {
    const handler = this.notificationReplies;
    if (!handler || !this.started.has(channel)) return { handled: false };
    try {
      return await handler({ ...r, channel: channel.name });
    } catch (err) {
      console.error(`[wherever] assistant channel "${channel.name}": a notification reply failed: ${errMessage(err)}`);
      return { handled: false };
    }
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
   * known origin are not a channel's: `reportDroppedBeyondChannels` shows the
   * web's (and the unknown) to the session's web viewers and logs the jobs'.
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
   * Attached files (already saved by the channel) are written into the text
   * as the web composer does (`channelMessageText`), and image files are also
   * sent as model image inputs (`channelImages`).
   */
  private async onUserMessage(channel: AssistantChannel, m: ChannelUserMessage, hooks?: ChannelInboundHooks): Promise<ChannelInboundResult> {
    if (!this.started.has(channel)) return { accepted: false, reason: 'the channel is not running' };
    const raw = typeof m.text === 'string' ? m.text : '';
    const text = channelMessageText(raw, m.files);
    if (!text) return { accepted: false, reason: 'empty message' };
    if (raw.trimStart().startsWith('!')) {
      return { accepted: false, reason: CHANNEL_SHELL_REFUSAL };
    }
    // Always 'steer': pi only uses it when a turn is running (ADR 0003), and it
    // keeps a message that races the start of a turn from being refused by pi
    // ("already processing") instead of steering it.
    const images = await channelImages(m.files);
    await this.controller.send(m.files?.length ? text : raw, channel.name, 'steer', {
      ...(images.length ? { images } : {}),
      onDispatch: (d) => {
        try {
          hooks?.onDispatched?.({ steered: d.steered });
        } catch (err) {
          console.error(`[wherever] assistant channel "${channel.name}" dispatch hook failed: ${errMessage(err)}`);
        }
      },
    });
    return { accepted: true };
  }

  /** A channel's `/new` / `/reset`: the controller's reset. */
  private async resetSession(channel: AssistantChannel): Promise<ChannelCommandResult> {
    if (!this.started.has(channel)) return { ok: false, error: 'the channel is not running' };
    if (!this.controller.reset) return { ok: false, error: 'reset is not available' };
    try {
      await this.controller.reset();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  /** A channel's `stop`: abort the current session's running turn. */
  private async abortTurn(channel: AssistantChannel): Promise<{ aborted: boolean }> {
    if (!this.started.has(channel) || !this.controller.abortCurrent) return { aborted: false };
    try {
      return { aborted: await this.controller.abortCurrent() };
    } catch (err) {
      console.error(`[wherever] assistant channel "${channel.name}": stopping the turn failed: ${errMessage(err)}`);
      return { aborted: false };
    }
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
