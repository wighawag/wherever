import fs from 'node:fs';
import path from 'node:path';
import type { AssistantChannel, ChannelContext } from './assistant-channels.js';
import {
  applyPairing,
  decideInbound,
  effectivePairing,
  generatePairingCode,
  initialPairingState,
  repair as repairState,
  type PairedUser,
  type PairingState,
} from './telegram-pairing.js';

/**
 * The assistant's TELEGRAM channel, the secure base (task
 * `telegram-token-and-pairing`; the conversation itself, replies, steer marker,
 * commands and notifications, is `telegram-conversation`'s).
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

/** The HTTP boundary (the global `fetch` by default; mocked in tests). */
export type TelegramFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The slice of a Bot API `Update` this channel reads. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}

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
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
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

  /** One Bot API call; resolves `result`, throws `BotApiError` on `ok: false`. */
  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
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

  // -------------------------------------------------------------------------

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
    if (!m || !m.from || m.from.is_bot || typeof m.text !== 'string') return;
    const fromId = String(m.from.id);
    const name = m.from.username ? `@${m.from.username}` : m.from.first_name;
    const decision = decideInbound(this.pairing, {
      fromId,
      chatId: String(m.chat.id),
      chatType: m.chat.type,
      text: m.text,
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
        // Not awaited: the send resolves when the turn ends, and polling must go
        // on meanwhile. The conversation (replies, steer marker, refusals shown
        // on Telegram) is `telegram-conversation`'s.
        const ctx = this.ctx;
        if (!ctx) return;
        void ctx
          .onUserMessage({ channel: TELEGRAM_CHANNEL, text: m.text, senderId: fromId })
          .then((r) => {
            if (!r.accepted) this.log.log(`[wherever] telegram: message not sent to the assistant (${r.reason})`);
          })
          .catch((err) => this.log.error(`[wherever] telegram: sending a message to the assistant failed: ${errMessage(err)}`));
        return;
      }
    }
  }

  private async reply(chatId: number, text: string): Promise<void> {
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
