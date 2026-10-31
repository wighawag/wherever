/**
 * Telegram REPLY delivery (task `telegram-conversation`): turns the pool events
 * whose current destination is `telegram` (ADR 0014, handed over by the channel
 * dispatcher) into Telegram messages. The mechanics are ported from the MIT
 * `badlogic/pi-telegram` extension (`index.ts`):
 *
 * - STREAMING: while an assistant message streams (`message_update`), its text
 *   is shown as a DRAFT with `sendMessageDraft`; at its `message_end` the final
 *   text is sent as a real message and the draft is cleared (an empty draft).
 *   When the Bot API refuses drafts (an older Bot API, a self-hosted server),
 *   the preview falls back to `sendMessage` + `editMessageText`, and that is
 *   remembered for every later reply (`draftSupport`).
 * - THROTTLE: the first preview of a message goes out at once (the user sees
 *   the assistant started); later ones at most every `throttleMs` (750 ms).
 * - SPLITTING: text longer than `TELEGRAM_TEXT_LIMIT` is split by paragraph,
 *   then by line, then hard (never inside a surrogate pair). A preview is
 *   truncated to the limit; the final message is sent in parts.
 * - ENDS: an assistant message with no text (tool calls only) sends nothing;
 *   an ABORTED one (`stop`) clears its draft (a fallback preview message stays
 *   as it was); an ERROR one is reported as `⚠️ The assistant failed: ...`.
 *
 * One stream per session file (a reply in an old session, after a reset, never
 * mixes with the new one), and every Bot API call of every stream goes through
 * ONE serial chain, so the messages arrive in the order the events did.
 *
 * Decision (recorded in work/notes/observations/telegram-conversation-decisions.md):
 * EACH assistant message with text is delivered at its own `message_end` (a
 * turn with tool calls in between may send several messages), rather than only
 * the last one at `agent_end` as pi-telegram does: per-message routing (ADR
 * 0014) can change the destination in the middle of a run (a steer), so the
 * natural unit is the message, and `message_start` is not forwarded for CLI
 * sessions.
 */

/**
 * The longest text sent in one message. Telegram's limit is 4096 characters;
 * JavaScript lengths are UTF-16 code units (never fewer than Telegram counts),
 * and the margin keeps every part safely UNDER the limit.
 */
export const TELEGRAM_TEXT_LIMIT = 4000;
export const PREVIEW_THROTTLE_MS = 750;
const DRAFT_ID_MAX = 2_147_483_647;

export type BotCall = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

export interface TelegramRepliesOptions {
  call: BotCall;
  /** The paired chat (null while unpaired: nothing is sent). */
  chatId: () => string | null;
  throttleMs?: number;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface Stream {
  mode: 'draft' | 'message';
  draftId?: number;
  messageId?: number;
  pending: string;
  lastSent: string;
  flushed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Split `text` into parts of at most `limit` UTF-16 units (paragraph, line, then hard). */
export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let current = '';
  const pushPart = (part: string, sep: string) => {
    const candidate = current.length === 0 ? part : `${current}${sep}${part}`;
    if (candidate.length <= limit) {
      current = candidate;
      return;
    }
    if (current.trim().length > 0) out.push(current);
    current = part;
  };
  for (const paragraph of text.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    if (paragraph.length === 0) continue;
    if (paragraph.length <= limit) {
      pushPart(paragraph, '\n\n');
      continue;
    }
    // A long paragraph: by line, then hard. Its pieces join with '\n'.
    let first = true;
    for (const line of paragraph.split('\n')) {
      const pieces = line.length <= limit ? [line] : hardSplit(line, limit);
      for (const piece of pieces) {
        pushPart(piece, first ? '\n\n' : '\n');
        first = false;
      }
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

function hardSplit(line: string, limit: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    let j = Math.min(line.length, i + limit);
    // Never end a part on a high surrogate (it would split a pair).
    if (j < line.length && /[\uD800-\uDBFF]/.test(line[j - 1]!)) j -= 1;
    out.push(line.slice(i, j));
    i = j;
  }
  return out;
}

/** The first `limit` units of `text`, never ending inside a surrogate pair. */
function truncate(text: string, limit = TELEGRAM_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  let j = limit;
  if (/[\uD800-\uDBFF]/.test(text[j - 1]!)) j -= 1;
  return text.slice(0, j);
}

/** The text blocks of a pi message's `content`, joined and trimmed. */
export function assistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

export class TelegramReplies {
  private readonly call: BotCall;
  private readonly chatId: () => string | null;
  private readonly throttleMs: number;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly streams = new Map<string, Stream>();
  private draftSupport: 'unknown' | 'supported' | 'unsupported' = 'unknown';
  private nextDraftId = 0;
  private chain: Promise<void> = Promise.resolve();
  private timers = 0;

  constructor(opts: TelegramRepliesOptions) {
    this.call = opts.call;
    this.chatId = opts.chatId;
    this.throttleMs = opts.throttleMs ?? PREVIEW_THROTTLE_MS;
    this.log = opts.log ?? console;
  }

  /** One pool event whose destination is Telegram. */
  handle(sessionFile: string, event: { type: string; [k: string]: unknown }): void {
    const message = event.message as { role?: string; content?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
    if (!message || message.role !== 'assistant') return;
    if (event.type === 'message_update') {
      const stream = this.streamFor(sessionFile);
      stream.pending = assistantText(message.content);
      if (!stream.pending) return;
      if (!stream.flushed && !stream.timer) {
        stream.flushed = true;
        this.enqueue(() => this.flush(stream));
      } else if (!stream.timer) {
        this.timers += 1;
        stream.timer = setTimeout(() => {
          this.timers -= 1;
          stream.timer = undefined;
          this.enqueue(() => this.flush(stream));
        }, this.throttleMs);
      }
      return;
    }
    if (event.type === 'message_end') {
      const stream = this.streams.get(sessionFile);
      this.streams.delete(sessionFile);
      if (stream?.timer) {
        clearTimeout(stream.timer);
        stream.timer = undefined;
        this.timers -= 1;
      }
      const text = assistantText(message.content);
      const stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
      const errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
      this.enqueue(() => this.finish(stream, text, stopReason, errorMessage));
    }
  }

  /** Resolves once every pending preview and send has run (tests, shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      await chain;
      if (this.timers > 0) {
        await new Promise((r) => setTimeout(r, Math.max(5, this.throttleMs)));
        continue;
      }
      if (chain === this.chain) return;
    }
  }

  /** Drop every stream's pending preview (the channel stopped). */
  stop(): void {
    for (const s of this.streams.values()) {
      if (s.timer) {
        clearTimeout(s.timer);
        this.timers -= 1;
      }
    }
    this.streams.clear();
  }

  // -------------------------------------------------------------------------

  private streamFor(sessionFile: string): Stream {
    let s = this.streams.get(sessionFile);
    if (!s) {
      s = { mode: this.draftSupport === 'unsupported' ? 'message' : 'draft', pending: '', lastSent: '', flushed: false };
      this.streams.set(sessionFile, s);
    }
    return s;
  }

  private enqueue(op: () => Promise<void>): void {
    this.chain = this.chain.then(op).catch((err) => this.log.warn(`[wherever] telegram: reply delivery failed: ${errMessage(err)}`));
  }

  private allocateDraftId(): number {
    this.nextDraftId = this.nextDraftId >= DRAFT_ID_MAX ? 1 : this.nextDraftId + 1;
    return this.nextDraftId;
  }

  /** Show the stream's pending text (draft, else the fallback preview message). */
  private async flush(stream: Stream): Promise<void> {
    const chatId = this.chatId();
    if (!chatId) return;
    const text = truncate(stream.pending.trim());
    if (!text || text === stream.lastSent) return;
    if (stream.mode === 'draft' && this.draftSupport !== 'unsupported') {
      stream.draftId ??= this.allocateDraftId();
      try {
        await this.call('sendMessageDraft', { chat_id: chatId, draft_id: stream.draftId, text });
        this.draftSupport = 'supported';
        stream.lastSent = text;
        return;
      } catch (err) {
        this.log.log(`[wherever] telegram: sendMessageDraft unavailable (${errMessage(err)}); falling back to sendMessage + editMessageText`);
        this.draftSupport = 'unsupported';
        stream.mode = 'message';
        stream.draftId = undefined;
      }
    }
    stream.mode = 'message';
    if (stream.messageId === undefined) {
      const sent = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text });
      stream.messageId = sent?.message_id;
    } else {
      await this.call('editMessageText', { chat_id: chatId, message_id: stream.messageId, text });
    }
    stream.lastSent = text;
  }

  private async finish(stream: Stream | undefined, text: string, stopReason: string | undefined, errorMessage: string | undefined): Promise<void> {
    const chatId = this.chatId();
    if (!chatId) return;
    if (stopReason === 'aborted') {
      await this.clearDraft(chatId, stream);
      return;
    }
    if (text) {
      const parts = splitTelegramText(text);
      let rest = parts;
      if (stream?.mode === 'message' && stream.messageId !== undefined) {
        // The fallback preview message becomes the first part.
        if (parts[0] !== stream.lastSent) {
          await this.call('editMessageText', { chat_id: chatId, message_id: stream.messageId, text: parts[0] });
        }
        rest = parts.slice(1);
      }
      for (const part of rest) await this.call('sendMessage', { chat_id: chatId, text: part });
      await this.clearDraft(chatId, stream);
    } else {
      await this.clearDraft(chatId, stream);
    }
    if (stopReason === 'error') {
      await this.call('sendMessage', { chat_id: chatId, text: `⚠️ The assistant failed: ${errorMessage || 'unknown error'}` });
    }
  }

  private async clearDraft(chatId: string, stream: Stream | undefined): Promise<void> {
    if (stream?.mode !== 'draft' || stream.draftId === undefined) return;
    try {
      await this.call('sendMessageDraft', { chat_id: chatId, draft_id: stream.draftId, text: '' });
    } catch {
      // An empty draft only hides the preview; nothing to do on failure.
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
