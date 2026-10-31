/**
 * Telegram REPLY delivery (task `telegram-conversation`): turns the pool events
 * whose current destination is `telegram` (ADR 0014, handed over by the channel
 * dispatcher) into Telegram messages. The mechanics are ported from the MIT
 * `badlogic/pi-telegram` extension (`index.ts`):
 *
 * - STREAMING: while an assistant message streams (`message_update`), its text
 *   is shown as a DRAFT with `sendMessageDraft`; at its `message_end` the final
 *   text is sent as a real message. When the Bot API refuses drafts (an older
 *   Bot API, a self-hosted server), the preview falls back to `sendMessage` +
 *   `editMessageText`, and that is remembered for every later reply
 *   (`draftSupport`).
 * - CLEARING A DRAFT: the Bot API has NO call that removes a draft. An EMPTY
 *   `sendMessageDraft` is not a clear: it shows a "Thinking..." placeholder
 *   (the animated dots), which lingers until the draft's ~30 s expiry. A draft
 *   disappears when the bot SENDS A MESSAGE to the chat. So an empty draft is
 *   never sent, and a visible draft is always ended by a real message: the
 *   final text at `message_end`; the text so far at a `tool_execution_start`,
 *   `turn_end` or `agent_end` that arrives while its message is still open
 *   (and not repeated at that message's `message_end`); on an ABORT, the
 *   partial text the user saw plus `ABORTED_MARK`, silently.
 * - THROTTLE: the first preview of a message goes out at once (the user sees
 *   the assistant started); later ones at most every `throttleMs` (750 ms).
 * - SPLITTING: text longer than `TELEGRAM_TEXT_LIMIT` is split by paragraph,
 *   then by line, then hard (never inside a surrogate pair). A preview is
 *   truncated to the limit; the final message is sent in parts.
 * - ENDS: an assistant message with no text (tool calls only) sends nothing;
 *   an ERROR one is reported as `⚠️ The assistant failed: ...`.
 * - TOOL CALLS (`assistantTelegram.toolCalls`): `off` (default) sends nothing
 *   for a tool call; `compact` sends one plain line per call at its
 *   `tool_execution_start` (`toolCallSummary`: `🔧 bash: <first line>`,
 *   `🔧 read: <path>`, secrets redacted), with `disable_notification`.
 *
 * - FILES (task `telegram-files`): a successful `attach_file` call's
 *   `tool_execution_end` sends its file (`sendPhoto` / `sendDocument`, by
 *   telegram-files.ts's `attachmentPlan`), or a clear note when it is too large
 *   or Telegram refuses it. It joins the same serial chain, so the file lands
 *   after the text the assistant wrote before the call.
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

import { attachedFileOf, attachmentFailedNote, attachmentPlan, attachmentTooLargeNote, fileSize } from './telegram-files.js';

/**
 * The longest text sent in one message. Telegram's limit is 4096 characters;
 * JavaScript lengths are UTF-16 code units (never fewer than Telegram counts),
 * and the margin keeps every part safely UNDER the limit.
 */
export const TELEGRAM_TEXT_LIMIT = 4000;
export const PREVIEW_THROTTLE_MS = 750;
const DRAFT_ID_MAX = 2_147_483_647;
/** Appended to the partial text of an aborted reply (kept, since the user saw it as a draft). */
export const ABORTED_MARK = '⏹ (stopped)';
/** The longest tool-call detail in a compact line (`assistantTelegram.toolCalls: "compact"`). */
export const TOOL_SUMMARY_MAX = 80;

/** `assistantTelegram.toolCalls`: what a tool call shows on Telegram. */
export type TelegramToolCalls = 'off' | 'compact';

/** The `toolCalls` config value, normalized (anything but `"compact"` is `"off"`). */
export function normalizeToolCalls(value: unknown): TelegramToolCalls {
  return value === 'compact' ? 'compact' : 'off';
}

export type BotCall = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

/** A multipart Bot API call sending one local file in `fileField` (`sendPhoto` / `sendDocument`). */
export type BotUpload = (method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string) => Promise<unknown>;

export interface TelegramRepliesOptions {
  call: BotCall;
  /** Sends attached files; without it an `attach_file` is not delivered. */
  upload?: BotUpload;
  /** The paired chat (null while unpaired: nothing is sent). */
  chatId: () => string | null;
  throttleMs?: number;
  /** `assistantTelegram.toolCalls` (default `off`: a tool call sends nothing). */
  toolCalls?: TelegramToolCalls;
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
  /**
   * Text already sent as a real message for this (still open) assistant
   * message, by a boundary that ended its draft early (a tool call start, a
   * turn end); its `message_end` sends only what comes after it.
   */
  delivered?: string;
}

/** The argument a compact tool-call line shows, per tool (anything else shows the name only). */
const SUMMARY_ARG: Record<string, string> = {
  bash: 'command',
  read: 'path',
  write: 'path',
  edit: 'path',
  ls: 'path',
  find: 'path',
  grep: 'path',
  attach_file: 'path',
};

/**
 * Replace secret-looking values with `***`: `key=value` / `key: value` for
 * secret-ish names, `Bearer` / `Basic` credentials, `--password x`-style flags,
 * `user:pass@` in URLs, and any long opaque run of letters AND digits (API
 * keys, bot tokens, hashes).
 */
export function redactSecrets(text: string): string {
  const secretName = String.raw`[\w.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|auth\w*|credential|private[_-]?key|access[_-]?key|session)[\w.-]*`;
  return text
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://***@')
    // curl -u user:pass, --user user:pass
    .replace(/(\s(?:-u|--user)\s+)[^\s:]+:\S+/g, '$1***')
    // mysql -pPASS (attached), sshpass -p PASS
    .replace(/(\bmysql\b[^\n]*?\s-p)(?!\s)\S+/g, '$1***')
    .replace(/(\bsshpass\s+-p\s+)\S+/g, '$1***')
    .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(new RegExp(String.raw`(--?${secretName})(=|\s+)("[^"]*"|'[^']*'|\S+)`, 'gi'), '$1$2***')
    .replace(new RegExp(String.raw`\b(${secretName})(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)`, 'gi'), '$1$2***')
    .replace(/[A-Za-z0-9_+=-]{20,}/g, (run) => (/[0-9]/.test(run) && /[A-Za-z]/.test(run) ? '***' : run));
}

/**
 * The compact line for one tool call: `🔧 <tool>`, plus `: <detail>` for the
 * tools in `SUMMARY_ARG` (bash: the command's first non-empty line; file tools:
 * the path). Control characters are dropped, secrets redacted BEFORE the cut,
 * and the detail truncated to `TOOL_SUMMARY_MAX` characters. Never any other
 * argument and never tool output.
 */
export function toolCallSummary(toolName: string, args: unknown): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const name = truncateWithEllipsis(clean(toolName) || 'tool', 60);
  const field = SUMMARY_ARG[toolName];
  const raw = field && args && typeof args === 'object' ? (args as Record<string, unknown>)[field] : undefined;
  if (typeof raw !== 'string') return `🔧 ${name}`;
  // Bounded before the regexes (a one-line heredoc can be huge); only the first
  // TOOL_SUMMARY_MAX characters are shown, so a secret there is redacted whole.
  const firstLine = (raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').slice(0, 1000);
  const detail = truncateWithEllipsis(clean(redactSecrets(firstLine)), TOOL_SUMMARY_MAX);
  return detail ? `🔧 ${name}: ${detail}` : `🔧 ${name}`;
}

function truncateWithEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  let j = max;
  if (/[\uD800-\uDBFF]/.test(text[j - 1]!)) j -= 1;
  return `${text.slice(0, j).trimEnd()}…`;
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
  private readonly upload: BotUpload | undefined;
  private readonly chatId: () => string | null;
  private readonly throttleMs: number;
  private readonly toolCalls: TelegramToolCalls;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly streams = new Map<string, Stream>();
  private draftSupport: 'unknown' | 'supported' | 'unsupported' = 'unknown';
  private nextDraftId = 0;
  private chain: Promise<void> = Promise.resolve();
  private timers = 0;

  constructor(opts: TelegramRepliesOptions) {
    this.call = opts.call;
    this.upload = opts.upload;
    this.chatId = opts.chatId;
    this.throttleMs = opts.throttleMs ?? PREVIEW_THROTTLE_MS;
    this.toolCalls = normalizeToolCalls(opts.toolCalls);
    this.log = opts.log ?? console;
  }

  /** One pool event whose destination is Telegram. */
  handle(sessionFile: string, event: { type: string; [k: string]: unknown }): void {
    const attached = attachedFileOf(event);
    if (attached) {
      this.enqueue(() => this.sendAttachment(attached.path, attached.filename));
      return;
    }
    if (event.type === 'tool_execution_start') {
      // A user `!` command (forceCommand) is not the assistant's tool call.
      if (event.forceCommand === true) return;
      this.closeOpenDraft(sessionFile);
      if (this.toolCalls === 'compact' && typeof event.toolName === 'string') {
        const line = toolCallSummary(event.toolName, event.args);
        this.enqueue(() => this.sendSilent(line));
      }
      return;
    }
    if (event.type === 'turn_end' || event.type === 'agent_end') {
      this.closeOpenDraft(sessionFile);
      return;
    }
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
      // The already-sent prefix (`delivered`) is cut inside the chain, in
      // finish(): a queued boundary may not have recorded it yet.
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

  /**
   * A boundary (tool call start, turn end) while an assistant message's draft
   * may still be showing: send its text so far as a real message (the only way
   * to end a draft) and remember it, so the message's `message_end` sends only
   * what comes after. Nothing happens without a shown draft.
   */
  private closeOpenDraft(sessionFile: string): void {
    const stream = this.streams.get(sessionFile);
    if (!stream || stream.mode !== 'draft') return;
    if (stream.timer) {
      clearTimeout(stream.timer);
      stream.timer = undefined;
      this.timers -= 1;
    }
    this.enqueue(async () => {
      // Decided in the chain: an earlier flush may have just shown a draft.
      if (stream.draftId === undefined || !stream.lastSent) return;
      const chatId = this.chatId();
      if (!chatId) return;
      const text = afterDelivered(stream, stream.pending);
      if (text) {
        for (const part of splitTelegramText(text)) await this.call('sendMessage', { chat_id: chatId, text: part });
      }
      stream.delivered = stream.pending;
      // The next text of this message (if any) is a new draft.
      stream.draftId = undefined;
      stream.lastSent = '';
      stream.flushed = false;
    });
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
    const text = truncate(afterDelivered(stream, stream.pending));
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

  private async finish(stream: Stream | undefined, fullText: string, stopReason: string | undefined, errorMessage: string | undefined): Promise<void> {
    const chatId = this.chatId();
    if (!chatId) return;
    const text = stream ? afterDelivered(stream, fullText) : fullText.trim();
    if (stopReason === 'aborted') {
      // A shown draft can only be ended by a message: keep what the user saw, silently.
      if (stream?.mode === 'draft' && stream.draftId !== undefined && stream.lastSent) {
        const partial = text || stream.lastSent;
        for (const part of splitTelegramText(`${partial}\n\n${ABORTED_MARK}`)) {
          await this.call('sendMessage', { chat_id: chatId, text: part, disable_notification: true });
        }
      }
      return;
    }
    if (text) {
      // Sending the final message also ends the draft (Telegram removes a draft
      // once the bot sends a message); no empty draft, which would show "Thinking...".
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
    }
    if (stopReason === 'error') {
      await this.call('sendMessage', { chat_id: chatId, text: `⚠️ The assistant failed: ${errorMessage || 'unknown error'}` });
    }
  }

  /** A compact tool-call line: plain text, without a notification of its own. */
  private async sendSilent(text: string): Promise<void> {
    const chatId = this.chatId();
    if (!chatId || !text.trim()) return;
    await this.call('sendMessage', { chat_id: chatId, text, disable_notification: true });
  }

  /** An `attach_file`'s file: sent as a photo or a document, else a note saying why not. */
  private async sendAttachment(filePath: string, filename: string): Promise<void> {
    const chatId = this.chatId();
    if (!chatId || !this.upload) return;
    const size = fileSize(filePath);
    if (size === null) {
      await this.call('sendMessage', { chat_id: chatId, text: attachmentFailedNote(filename, 'the file is no longer there') });
      return;
    }
    const plan = attachmentPlan(filePath, size);
    if (plan.kind === 'too-large') {
      await this.call('sendMessage', { chat_id: chatId, text: attachmentTooLargeNote(filename, size, plan.limit, filePath) });
      return;
    }
    if (plan.kind === 'photo') {
      try {
        await this.upload('sendPhoto', { chat_id: chatId }, 'photo', filePath, filename);
        return;
      } catch (err) {
        // Telegram refuses some images as photos (dimensions, ratio): send the file as is.
        this.log.log(`[wherever] telegram: sendPhoto refused ${filename} (${errMessage(err)}); sending it as a document`);
      }
    }
    try {
      await this.upload('sendDocument', { chat_id: chatId }, 'document', filePath, filename);
    } catch (err) {
      this.log.warn(`[wherever] telegram: sending ${filename} failed: ${errMessage(err)}`);
      await this.call('sendMessage', { chat_id: chatId, text: attachmentFailedNote(filename, errMessage(err)) });
    }
  }
}

/** `text` without the prefix a boundary already sent as a message (`delivered`), trimmed. */
function afterDelivered(stream: Stream, text: string): string {
  const d = stream.delivered;
  if (d !== undefined && d.length > 0) {
    if (text.startsWith(d)) return text.slice(d.length).trim();
    if (text.trimStart().startsWith(d.trim())) return text.trimStart().slice(d.trim().length).trim();
  }
  return text.trim();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
