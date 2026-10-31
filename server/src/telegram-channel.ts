import fs from 'node:fs';
import path from 'node:path';
import type {
  AssistantChannel,
  ChannelContext,
  ChannelDroppedReport,
  ChannelNotification,
  ChannelNotifyResult,
  ChannelReply,
} from './assistant-channels.js';
import {
  applyPairing,
  decideInbound,
  effectivePairing,
  generatePairingCode,
  initialPairingState,
  parseCommand,
  repair as repairState,
  type PairedUser,
  type PairingState,
} from './telegram-pairing.js';
import { TelegramReplies, splitTelegramText } from './telegram-replies.js';
import {
  FILES_UNAVAILABLE_REPLY,
  TELEGRAM_DOWNLOAD_MAX_BYTES,
  UNSUPPORTED_MEDIA_REPLY,
  hasUnsupportedMedia,
  inboundFailedNote,
  inboundFilesOf,
  inboundTooLargeNote,
  saveUploaded,
  type TelegramInboundFile,
} from './telegram-files.js';
import type { ChannelFile } from './assistant-channels.js';

/**
 * The assistant's TELEGRAM channel: the secure base (task
 * `telegram-token-and-pairing`: token, polling, pairing) and the CONVERSATION
 * (task `telegram-conversation`):
 *
 * - INBOUND, from the paired user only (telegram-pairing.ts): `stop` / `/stop`
 *   aborts the running turn; `/new` / `/reset` reset the assistant (the
 *   controller's reset, never sent to pi); `!` / `!!` text is refused with an
 *   explanation (it never reaches the pool's shell path); anything else,
 *   including other `/` text such as `/skill:`, goes to the controller
 *   untouched (the origin `telegram` rides the pool's routing queue, never a
 *   text prefix). Into a running turn it STEERS (ADR 0003), shown by a
 *   `STEER_REACTION` on the user's message, or, when reactions are refused,
 *   the short `STEER_NOTE`. Each message is handled once it is DISPATCHED
 *   (not when its turn ends), so messages keep their order and polling goes on.
 * - REPLIES: output whose current destination is `telegram` (ADR 0014), from
 *   the dispatcher, streamed and split by telegram-replies.ts.
 * - NOTIFY (`assistant_notify`): its OWN message `🔔 <source>: <title>`, the
 *   body below, then a link to the target session when `publicUrl` is
 *   configured; sent at once, even mid-reply, never folded into a reply.
 * - DROPPED messages (a reset, an aborted settle): reported back as a list.
 * - FILES (task `telegram-files`, telegram-files.ts): a photo or a document
 *   (an ALBUM is its messages gathered for `mediaGroupDelayMs`, then handled as
 *   one message) is downloaded into the upload dir and reaches the assistant as
 *   paths in the text, as a web upload does; its caption is the text. An
 *   `attach_file` in a Telegram-routed reply sends the file back.
 *
 * Bot API LONG POLLING (`getUpdates` with a server-side `timeout`), the
 * mechanics ported from the MIT `badlogic/pi-telegram` extension, but NOT its
 * pairing (it pairs whoever sends the first `/start`): pairing is the one-time
 * code of telegram-pairing.ts.
 *
 * State, in the STATE dir (ADR 0006), mode 0600, atomic tmp + rename:
 * - `assistant-telegram-offset.json` `{botId, offset}`: the next `getUpdates`
 *   offset, written after EACH handled update, so a restart neither replays
 *   (Telegram drops everything below the offset) nor loses an update (a crash
 *   between handling and writing replays at most that one). It is bound to the
 *   bot id (the token's numeric prefix): update ids are per bot, so an offset
 *   left by another bot is ignored rather than used to skip the new bot's updates.
 * - `assistant-telegram-pairing.json`: the paired user (`PairedUser`).
 * The one-time code lives in memory only (a restart issues a new one), so an
 * unpaired channel writes nothing until someone pairs.
 *
 * Built only while the assistant is ACTIVE (configured AND this server holds the
 * folder lock: two servers must never poll the same bot) AND
 * `assistantTelegram.enabled` is true AND a token resolved (telegram-token.ts);
 * see `server/src/index.ts`.
 *
 * Failure handling: a 401 / 404 from the Bot API means the token is wrong; the
 * channel stops polling and reports `error` (a restart with a fixed token is the
 * cure). Any other failure (network, 409 another poller or a webhook, 429, 5xx)
 * is logged and retried with backoff (honouring `retry_after`).
 */

export const TELEGRAM_CHANNEL = 'telegram';
export const TELEGRAM_OFFSET_FILE = 'assistant-telegram-offset.json';
export const TELEGRAM_PAIRING_FILE = 'assistant-telegram-pairing.json';
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * The HTTP boundary (the global `fetch` by default; mocked in tests): JSON
 * calls, multipart file sends (a `FormData` body) and file downloads (`GET`).
 */
export type TelegramFetch = (
  url: string,
  init: { method: 'POST' | 'GET'; headers?: Record<string, string>; body?: string | FormData; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown>; arrayBuffer?(): Promise<ArrayBuffer> }>;

/** The slice of a Bot API `Update` this channel reads. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/** The slice of a Bot API `Message` this channel reads. */
export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  [k: string]: unknown;
}

/** How long an album's messages are gathered before it is handled (pi-telegram's 1200 ms). */
export const MEDIA_GROUP_DELAY_MS = 1200;

/** What the web shows (`GET /config` `assistant.telegram`, beside `enabled`). */
export type TelegramChannelStatus =
  | { state: 'starting'; bot: string | null; error?: string }
  | { state: 'unpaired'; code: string | null; bot: string | null; error?: string }
  | { state: 'paired'; user: { id: string; name?: string; source: 'config' | 'pairing' }; bot: string | null; error?: string }
  | { state: 'error'; error: string; bot: string | null };

export interface TelegramChannelOptions {
  token: string;
  stateDir: string;
  /** `assistantTelegram.userId`, normalized (wins over a stored pairing). */
  configuredUserId: string | null;
  /** The Bot API base URL (`assistantTelegram.apiBaseUrl`; a local Bot API server, or a mock). */
  apiBaseUrl?: string;
  fetch?: TelegramFetch;
  /** `getUpdates` server-side timeout, seconds (default 30). */
  pollTimeoutSeconds?: number;
  /** Delay before retry number `attempt` (1-based), ms. Default: 1 s doubling to 60 s. */
  retryDelayMs?: (attempt: number) => number;
  /** Called whenever the status changes (paired, re-paired, error). */
  onChange?: () => void;
  newCode?: () => string;
  /** The wherever public URL (`publicUrl`): a notification links to `<publicUrl>/#<sessionId>`. */
  publicUrl?: string;
  /** Reply preview throttle, ms (default 750; tests use 0). */
  replyThrottleMs?: number;
  /**
   * Where a file from Telegram is saved: the upload dir a web upload of the
   * assistant session lands in (index.ts: `resolveUploadDir(config, folder)`).
   * Unset: files are refused with `FILES_UNAVAILABLE_REPLY`.
   */
  uploadDir?: () => string;
  /** The upload size limit (`uploads.maxBytes`); a file over it, or over Telegram's 20 MB, is refused with a note. */
  maxUploadBytes?: () => number;
  /** How long an album is gathered, ms (default `MEDIA_GROUP_DELAY_MS`). */
  mediaGroupDelayMs?: number;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** The reaction marking a message that STEERED the running turn (one of Telegram's allowed reaction emoji). */
export const STEER_REACTION = '✍';
/** The fallback when the reaction is refused. */
export const STEER_NOTE = '↪️ Added to the current reply.';
export const SHELL_REFUSAL_REPLY =
  'Shell commands ("!" or "!!") cannot be run from Telegram. Ask the assistant in words instead, and it can run what is needed itself.';
export const RESET_REPLY = '🆕 Started a fresh assistant session. What it wrote down in its folder is kept.';
export const STOPPED_REPLY = '⏹ Stopped the current reply.';
export const NOTHING_RUNNING_REPLY = 'Nothing is running.';

/** The `🔔` notification text (an `assistant_notify`), before splitting. */
export function formatTelegramNotification(n: ChannelNotification, publicUrl?: string): string {
  let text = `🔔 ${n.source}: ${n.title}`;
  if (n.body && n.body.trim()) text += `\n\n${n.body.trim()}`;
  const link = sessionLink(publicUrl, n.navigate);
  if (link) text += `\n\n${link}`;
  return text;
}

/** `<publicUrl>/#<sessionId>`, or null without a usable http(s) public URL. */
export function sessionLink(publicUrl: string | undefined, sessionId: string): string | null {
  if (typeof publicUrl !== 'string' || !publicUrl.trim() || !sessionId) return null;
  try {
    const u = new URL(publicUrl.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return `${publicUrl.trim().replace(/[/#]+$/, '')}/#${sessionId}`;
}

/** The report of messages a reset or an aborted settle dropped, before splitting. */
export function formatDroppedReport(report: ChannelDroppedReport): string {
  const n = report.messages.length;
  const what = n === 1 ? 'this message' : `these ${n} messages`;
  const head =
    report.reason === 'reset'
      ? `⚠️ The assistant was reset before it read ${what}; send again if still needed:`
      : `⚠️ The turn was stopped before the assistant read ${what}; send again if still needed:`;
  return [head, ...report.messages.map((m) => `• ${m}`)].join('\n\n');
}

class BotApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Bot API ${method} failed: HTTP ${status}${description ? ` (${description})` : ''}`);
  }
  /** The token is wrong: retrying cannot help. */
  get fatal(): boolean {
    return this.status === 401 || this.status === 404;
  }
}

export class TelegramChannel implements AssistantChannel {
  readonly name = TELEGRAM_CHANNEL;
  private readonly token: string;
  private readonly botId: string;
  private readonly apiBase: string;
  private readonly fetchImpl: TelegramFetch;
  private readonly pollTimeout: number;
  private readonly retryDelay: (attempt: number) => number;
  private readonly offsetPath: string;
  private readonly pairingPath: string;
  private readonly newCode: () => string;
  private readonly onChange: () => void;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly configuredUserId: string | null;

  private pairing: PairingState;
  private offset: number | undefined;
  private bot: string | null = null;
  private fatalError: string | null = null;
  private lastError: string | null = null;
  private started = false;
  private ctx: ChannelContext | null = null;
  private abort: AbortController | null = null;
  private loopDone: Promise<void> | null = null;
  private readonly publicUrl: string | undefined;
  private readonly replies: TelegramReplies;
  private readonly uploadDir: (() => string) | undefined;
  private readonly maxUploadBytes: () => number;
  private readonly mediaGroupDelayMs: number;
  /** Albums being gathered, by `media_group_id`. */
  private readonly groups = new Map<string, { messages: TelegramMessage[]; fromId: string; timer: ReturnType<typeof setTimeout> }>();
  /** Every inbound message is handled through this one chain (an album's timer and the polling loop never interleave). */
  private inbound: Promise<void> = Promise.resolve();

  constructor(opts: TelegramChannelOptions) {
    this.token = opts.token;
    this.botId = opts.token.split(':')[0] ?? '';
    this.apiBase = (opts.apiBaseUrl ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.pollTimeout = opts.pollTimeoutSeconds ?? 30;
    this.retryDelay = opts.retryDelayMs ?? ((n) => Math.min(60_000, 1000 * 2 ** (n - 1)));
    this.offsetPath = path.join(opts.stateDir, TELEGRAM_OFFSET_FILE);
    this.pairingPath = path.join(opts.stateDir, TELEGRAM_PAIRING_FILE);
    this.newCode = opts.newCode ?? (() => generatePairingCode());
    this.onChange = opts.onChange ?? (() => {});
    this.log = opts.log ?? console;
    this.configuredUserId = opts.configuredUserId;
    this.publicUrl = opts.publicUrl;
    this.uploadDir = opts.uploadDir;
    this.maxUploadBytes = opts.maxUploadBytes ?? (() => TELEGRAM_DOWNLOAD_MAX_BYTES);
    this.mediaGroupDelayMs = opts.mediaGroupDelayMs ?? MEDIA_GROUP_DELAY_MS;
    this.replies = new TelegramReplies({
      call: (method, params) => this.call(method, params),
      upload: (method, fields, fileField, filePath, fileName) => this.callMultipart(method, fields, fileField, filePath, fileName),
      chatId: () => (this.started ? this.pairedChatId() : null),
      throttleMs: opts.replyThrottleMs,
      log: this.log,
    });
    // Nothing is read before start(): the state lives in memory from there.
    this.pairing = { configuredUserId: opts.configuredUserId, stored: null, code: null };
  }

  /** Load the stored pairing and offset, then start polling (not awaited). */
  start(ctx: ChannelContext): void {
    if (this.started) return;
    this.started = true;
    this.ctx = ctx;
    this.pairing = initialPairingState(this.configuredUserId, this.readPairing(), this.newCode);
    this.offset = this.readOffset();
    this.abort = new AbortController();
    this.loopDone = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.abort?.abort();
    this.replies.stop();
    for (const g of this.groups.values()) clearTimeout(g.timer);
    this.groups.clear();
    await this.loopDone?.catch(() => {});
    this.loopDone = null;
    this.ctx = null;
  }

  status(): TelegramChannelStatus {
    if (this.fatalError) return { state: 'error', error: this.fatalError, bot: this.bot };
    const extra = this.lastError ? { error: this.lastError } : {};
    if (!this.started) return { state: 'starting', bot: this.bot, ...extra };
    const eff = effectivePairing(this.pairing);
    if (eff.kind === 'unpaired') return { state: 'unpaired', code: eff.code, bot: this.bot, ...extra };
    return {
      state: 'paired',
      user: { id: eff.userId, ...(eff.name ? { name: eff.name } : {}), source: eff.source },
      bot: this.bot,
      ...extra,
    };
  }

  /** The paired user's chat (null while unpaired), for `telegram-conversation`. */
  pairedChatId(): string | null {
    const eff = effectivePairing(this.pairing);
    return eff.kind === 'paired' ? eff.chatId : null;
  }

  /**
   * The web's RE-PAIR: forget the stored pairing (the file is removed) and
   * issue a new code. Refused while the user id comes from the config.
   */
  repair(): { ok: true } | { ok: false; error: string } {
    if (!this.started) return { ok: false, error: 'the Telegram channel is not running' };
    const r = repairState(this.pairing, this.newCode());
    if (!r.ok) return r;
    this.pairing = r.state;
    try {
      fs.rmSync(this.pairingPath, { force: true });
    } catch (err) {
      this.log.error(`[wherever] telegram: could not remove ${this.pairingPath}: ${errMessage(err)}`);
    }
    this.log.log('[wherever] telegram: pairing reset from the web; a new pairing code was issued');
    this.onChange();
    return { ok: true };
  }

  /** Output answering a Telegram message (its destination is `telegram`): streamed to the paired chat. */
  deliverReply(reply: ChannelReply): void {
    this.replies.handle(reply.sessionFile, reply.event);
  }

  /** Resolves once every pending reply preview and send has run (tests). */
  replyIdle(): Promise<void> {
    return this.replies.idle();
  }

  /** Resolves once every gathered album and inbound message has been handled (tests). */
  async inboundIdle(): Promise<void> {
    for (;;) {
      const chain = this.inbound;
      await chain;
      if (this.groups.size > 0) {
        await new Promise((r) => setTimeout(r, Math.max(5, this.mediaGroupDelayMs)));
        continue;
      }
      if (chain === this.inbound) return;
    }
  }

  /** `assistant_notify`: its own `🔔` message, sent now (never waits for, or joins, a reply). */
  async notify(n: ChannelNotification): Promise<ChannelNotifyResult> {
    const chatId = this.started ? this.pairedChatId() : null;
    if (!chatId) return { ok: false, error: this.started ? 'Telegram is not paired yet' : 'the Telegram channel is not running' };
    try {
      for (const part of splitTelegramText(formatTelegramNotification(n, this.publicUrl))) {
        await this.call('sendMessage', { chat_id: chatId, text: part });
      }
      return { ok: true, detail: 'sent' };
    } catch (err) {
      return { ok: false, error: errMessage(err).split(this.token).join('<token>') };
    }
  }

  /** Messages from Telegram that a reset or an aborted settle dropped: listed back to the user. */
  async reportDropped(report: ChannelDroppedReport): Promise<void> {
    const chatId = this.started ? this.pairedChatId() : null;
    if (!chatId || report.messages.length === 0) return;
    for (const part of splitTelegramText(formatDroppedReport(report))) {
      await this.reply(chatId, part);
    }
  }

  /** One Bot API call; resolves `result`, throws `BotApiError` on `ok: false`. */
  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
    return this.answer<T>(method, res);
  }

  /** A multipart Bot API call sending the local `filePath` as `fileField`. */
  async callMultipart<T>(method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const bytes = await fs.promises.readFile(filePath);
    form.set(fileField, new Blob([bytes]), fileName);
    const res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      body: form,
      ...(this.abort ? { signal: this.abort.signal } : {}),
    });
    return this.answer<T>(method, res);
  }

  // -------------------------------------------------------------------------

  private async answer<T>(method: string, res: { status: number; json(): Promise<unknown> }): Promise<T> {
    let body: any = null;
    try {
      body = await res.json();
    } catch {}
    if (res.status >= 200 && res.status < 300 && body?.ok === true) return body.result as T;
    throw new BotApiError(
      method,
      res.status,
      typeof body?.description === 'string' ? body.description : '',
      typeof body?.parameters?.retry_after === 'number' ? body.parameters.retry_after : undefined,
    );
  }

  private async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    for (;;) {
      if (signal.aborted) return;
      try {
        const me = await this.call<{ username?: string }>('getMe', {}, signal);
        this.bot = me?.username ? `@${me.username}` : null;
        this.log.log(`[wherever] telegram: connected as ${this.bot ?? 'the bot'}${this.pairedChatId() ? '' : ' (unpaired: see the wherever settings for the pairing code)'}`);
        this.onChange();
        break;
      } catch (err) {
        if (signal.aborted) return;
        if (!(await this.failed(err, ++attempt, signal))) return;
      }
    }
    attempt = 0;
    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.call<TelegramUpdate[]>(
          'getUpdates',
          { ...(this.offset !== undefined ? { offset: this.offset } : {}), timeout: this.pollTimeout, allowed_updates: ['message'] },
          signal,
        );
      } catch (err) {
        if (signal.aborted) return;
        if (!(await this.failed(err, ++attempt, signal))) return;
        continue;
      }
      attempt = 0;
      if (this.lastError) {
        this.lastError = null;
        this.onChange();
      }
      for (const u of Array.isArray(updates) ? updates : []) {
        if (signal.aborted) return;
        if (typeof u?.update_id !== 'number') continue;
        try {
          await this.handle(u);
        } catch (err) {
          this.log.error(`[wherever] telegram: handling update ${u.update_id} failed: ${errMessage(err)}`);
        }
        this.offset = u.update_id + 1;
        this.writeOffset(this.offset);
      }
    }
  }

  /** Log a failed call; false = stop polling (fatal), true = retried after the backoff. */
  private async failed(err: unknown, attempt: number, signal: AbortSignal): Promise<boolean> {
    if (err instanceof BotApiError && err.fatal) {
      this.fatalError = `the bot token was rejected by Telegram (${err.message}); fix it and restart wherever`;
      this.log.error(`[wherever] telegram: ${this.fatalError}. Telegram is DISABLED.`);
      this.onChange();
      return false;
    }
    // Never log the token (a network error may quote the request URL).
    const msg = errMessage(err).split(this.token).join('<token>');
    if (this.lastError !== msg) {
      this.lastError = msg;
      this.log.warn(`[wherever] telegram: ${msg}; retrying`);
      this.onChange();
    }
    const wait = err instanceof BotApiError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : this.retryDelay(attempt);
    await sleep(wait, signal);
    return !signal.aborted;
  }

  private async handle(u: TelegramUpdate): Promise<void> {
    const m = u.message;
    if (!m || !m.from || m.from.is_bot) return;
    const text = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : undefined;
    const hasMedia = inboundFilesOf(m).length > 0 || hasUnsupportedMedia(m);
    if (text === undefined && !hasMedia) return;
    const fromId = String(m.from.id);
    const name = m.from.username ? `@${m.from.username}` : m.from.first_name;
    // Pairing decides on the text alone (a caption here), BEFORE anything is
    // downloaded: a stranger's file is never fetched.
    const decision = decideInbound(this.pairing, {
      fromId,
      chatId: String(m.chat.id),
      chatType: m.chat.type,
      text: text ?? '',
      ...(name ? { name } : {}),
    });
    switch (decision.kind) {
      case 'ignore':
        // Never answered; logged without the text (it is a stranger's).
        this.log.log(`[wherever] telegram: ignored a message from user ${fromId} (${decision.why})`);
        return;
      case 'pair':
        this.writePairing(decision.user);
        this.pairing = applyPairing(this.pairing, decision.user);
        this.log.log(`[wherever] telegram: paired with user ${decision.user.userId}${decision.user.name ? ` (${decision.user.name})` : ''}`);
        this.onChange();
        await this.reply(m.chat.id, decision.reply);
        return;
      case 'refuse':
        await this.reply(m.chat.id, decision.reply);
        return;
      case 'forward': {
        const groupId = typeof m.media_group_id === 'string' && m.media_group_id ? m.media_group_id : null;
        if (groupId) {
          // Albums before this one go first, in order.
          for (const key of [...this.groups.keys()]) if (key !== groupId) void this.flushGroup(key);
          this.gather(groupId, m, fromId);
          return;
        }
        // Any album still being gathered was sent before this message.
        for (const key of [...this.groups.keys()]) void this.flushGroup(key);
        await this.serial(() => this.converse([m], fromId));
        return;
      }
    }
  }

  /** Run `fn` after every inbound message before it has been handled. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.inbound.then(fn, fn);
    this.inbound = run.catch((err) => this.log.error(`[wherever] telegram: handling a message failed: ${errMessage(err)}`));
    return this.inbound;
  }

  /** Add an album message; the album is handled `mediaGroupDelayMs` after its LAST message. */
  private gather(groupId: string, m: TelegramMessage, fromId: string): void {
    const g = this.groups.get(groupId);
    if (g) clearTimeout(g.timer);
    const messages = [...(g?.messages ?? []), m];
    const timer = setTimeout(() => void this.flushGroup(groupId), this.mediaGroupDelayMs);
    this.groups.set(groupId, { messages, fromId, timer });
  }

  private flushGroup(groupId: string): Promise<void> {
    const g = this.groups.get(groupId);
    if (!g) return Promise.resolve();
    this.groups.delete(groupId);
    clearTimeout(g.timer);
    return this.serial(() => this.converse(g.messages, g.fromId));
  }

  /**
   * The paired user's message (one, or an album's): a command, a refusal, or a
   * message for the assistant, with its files downloaded into the upload dir.
   */
  private async converse(messages: TelegramMessage[], fromId: string): Promise<void> {
    const ctx = this.ctx;
    const first = messages[0];
    if (!ctx || !first) return;
    const chatId = first.chat.id;
    const messageId = first.message_id;
    const textOf = (m: TelegramMessage) => (typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '');
    // One message's text goes to the assistant untouched; an album's captions are joined.
    const text =
      messages.length === 1
        ? textOf(first)
        : messages
            .map((m) => textOf(m).trim())
            .filter(Boolean)
            .join('\n\n');
    const wanted = messages.flatMap((m) => inboundFilesOf(m));
    const unsupported = messages.some((m) => hasUnsupportedMedia(m));
    const trimmed = text.trim();
    const cmd = parseCommand(trimmed);
    // Commands are a TEXT message's; a caption is text for the assistant.
    if (wanted.length === 0 && !unsupported) {
      if (trimmed.toLowerCase() === 'stop' || cmd?.command === 'stop') {
        const r = await ctx.abortTurn();
        await this.reply(chatId, r.aborted ? STOPPED_REPLY : NOTHING_RUNNING_REPLY);
        return;
      }
      if (cmd && (cmd.command === 'new' || cmd.command === 'reset')) {
        const r = await ctx.resetSession();
        await this.reply(chatId, r.ok ? RESET_REPLY : `⚠️ Could not reset the assistant: ${r.error}`);
        return;
      }
    }
    if (trimmed.startsWith('!')) {
      await this.reply(chatId, SHELL_REFUSAL_REPLY);
      return;
    }
    if (unsupported) await this.reply(chatId, UNSUPPORTED_MEDIA_REPLY);
    const files: ChannelFile[] = [];
    if (wanted.length > 0) {
      const dir = this.uploadDir?.();
      if (!dir) {
        await this.reply(chatId, FILES_UNAVAILABLE_REPLY);
      } else {
        for (const f of wanted) {
          const r = await this.download(f, dir);
          if (r.ok) files.push(r.file);
          else await this.reply(chatId, r.note);
        }
      }
    }
    if (!trimmed && files.length === 0) return;
    // Wait until the message is DISPATCHED (handed to the session as a start or
    // a steer), not until its turn ends: the next message is then decided
    // against the right state (steer vs start), and polling goes on.
    await new Promise<void>((resolve) => {
      let done = false;
      const dispatched = () => {
        if (done) return;
        done = true;
        resolve();
      };
      ctx
        .onUserMessage(
          { channel: TELEGRAM_CHANNEL, text, ...(files.length ? { files } : {}), senderId: fromId },
          {
            onDispatched: ({ steered }) => {
              dispatched();
              if (steered) void this.markSteer(chatId, messageId);
            },
          },
        )
        .then((r) => {
          if (!r.accepted) this.log.log(`[wherever] telegram: message not sent to the assistant (${r.reason})`);
        })
        .catch((err) => {
          this.log.error(`[wherever] telegram: sending a message to the assistant failed: ${errMessage(err)}`);
          void this.reply(chatId, `⚠️ The assistant could not take your message: ${errMessage(err)}`);
        })
        .finally(dispatched);
    });
  }

  /**
   * Fetch one file from Telegram (`getFile`, then its download URL) into `dir`.
   * Refused, with a note for the user, over the upload limit (`maxUploadBytes`,
   * capped at Telegram's 20 MB), before downloading when Telegram announced the
   * size and after it otherwise.
   */
  private async download(f: TelegramInboundFile, dir: string): Promise<{ ok: true; file: ChannelFile } | { ok: false; note: string }> {
    const limit = Math.min(TELEGRAM_DOWNLOAD_MAX_BYTES, this.maxUploadBytes());
    if (typeof f.size === 'number' && f.size > limit) return { ok: false, note: inboundTooLargeNote(f.name, f.size, limit) };
    try {
      const info = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: f.fileId }, this.abort?.signal);
      if (typeof info?.file_size === 'number' && info.file_size > limit) return { ok: false, note: inboundTooLargeNote(f.name, info.file_size, limit) };
      if (!info?.file_path) throw new Error('Telegram gave no download path');
      const res = await this.fetchImpl(`${this.apiBase}/file/bot${this.token}/${info.file_path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'GET',
        ...(this.abort ? { signal: this.abort.signal } : {}),
      });
      if (res.status < 200 || res.status >= 300 || !res.arrayBuffer) throw new Error(`download failed: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > limit) return { ok: false, note: inboundTooLargeNote(f.name, bytes.byteLength, limit) };
      const saved = await saveUploaded(dir, f.name, bytes);
      this.log.log(`[wherever] telegram: received ${f.name} (${bytes.byteLength} bytes) into ${saved}`);
      return { ok: true, file: { path: saved, name: f.name, ...(f.mimeType ? { mimeType: f.mimeType } : {}) } };
    } catch (err) {
      const msg = errMessage(err).split(this.token).join('<token>');
      if (/file is too big/i.test(msg)) return { ok: false, note: inboundTooLargeNote(f.name, f.size, limit) };
      this.log.warn(`[wherever] telegram: receiving ${f.name} failed: ${msg}`);
      return { ok: false, note: inboundFailedNote(f.name, msg) };
    }
  }

  /** Show that a message steered the running turn: a reaction, else a short note replying to it. */
  private async markSteer(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji: STEER_REACTION }] });
    } catch (err) {
      this.log.log(`[wherever] telegram: setMessageReaction failed (${errMessage(err)}); sending the steer note instead`);
      try {
        await this.call('sendMessage', {
          chat_id: chatId,
          text: STEER_NOTE,
          reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
        });
      } catch (err2) {
        this.log.warn(`[wherever] telegram: sending the steer note failed: ${errMessage(err2)}`);
      }
    }
  }

  private async reply(chatId: number | string, text: string): Promise<void> {
    try {
      await this.call('sendMessage', { chat_id: chatId, text });
    } catch (err) {
      this.log.warn(`[wherever] telegram: sendMessage failed: ${errMessage(err)}`);
    }
  }

  private readOffset(): number | undefined {
    const data = readJson(this.offsetPath, this.log);
    if (!data) return undefined;
    if (data.botId !== this.botId) {
      this.log.log('[wherever] telegram: ignoring the stored polling offset of another bot');
      return undefined;
    }
    return typeof data.offset === 'number' && Number.isSafeInteger(data.offset) ? data.offset : undefined;
  }

  private writeOffset(offset: number): void {
    try {
      writeAtomic0600(this.offsetPath, JSON.stringify({ botId: this.botId, offset }) + '\n');
    } catch (err) {
      this.log.error(`[wherever] telegram: could not persist the polling offset to ${this.offsetPath}: ${errMessage(err)}`);
    }
  }

  private readPairing(): PairedUser | null {
    const d = readJson(this.pairingPath, this.log);
    if (!d || typeof d.userId !== 'string' || !/^\d+$/.test(d.userId)) return null;
    return {
      userId: d.userId,
      chatId: typeof d.chatId === 'string' ? d.chatId : d.userId,
      ...(typeof d.name === 'string' ? { name: d.name } : {}),
      ...(typeof d.pairedAt === 'string' ? { pairedAt: d.pairedAt } : {}),
    };
  }

  private writePairing(user: PairedUser): void {
    writeAtomic0600(this.pairingPath, JSON.stringify(user, null, 2) + '\n');
  }
}

function readJson(file: string, log: Pick<Console, 'warn'>): Record<string, any> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const d = JSON.parse(raw);
    return d && typeof d === 'object' ? d : null;
  } catch {
    log.warn(`[wherever] telegram: ignoring an unreadable ${file}`);
    return null;
  }
}

function writeAtomic0600(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
