import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TelegramFetch, TelegramUpdate } from '../src/telegram-channel.ts';

/**
 * A fake Telegram Bot API at the HTTP boundary, with Telegram's `getUpdates`
 * semantics: an update below the requested `offset` is CONFIRMED and gone for
 * good; with nothing pending the call is held (long polling) until an update
 * arrives or a short hold expires. Usable two ways: `fetch` (injected into
 * `TelegramChannel`) or `listen()` (a real local HTTP server, for the
 * spawned-server tests via `assistantTelegram.apiBaseUrl`).
 */

export interface BotApiCall {
  token: string;
  method: string;
  params: Record<string, any>;
}

export class FakeBotApi {
  readonly calls: BotApiCall[] = [];
  private pending: TelegramUpdate[] = [];
  private nextId = 1000;
  private nextSentId = 1;
  private waiters: Array<() => void> = [];
  private server: http.Server | null = null;
  /** Tokens the fake accepts (any other answers 401). Empty = accept all. */
  validTokens = new Set<string>();
  username = 'wherever_test_bot';

  constructor(private readonly holdMs = 150) {}

  /** Queue an incoming text message from `fromId` (private chat). */
  message(fromId: number, text: string, opts: { chatType?: string; chatId?: number; username?: string } = {}): number {
    const update_id = this.nextId++;
    this.pending.push({
      update_id,
      message: {
        message_id: update_id,
        from: { id: fromId, first_name: `user${fromId}`, ...(opts.username ? { username: opts.username } : {}) },
        chat: { id: opts.chatId ?? fromId, type: opts.chatType ?? 'private' },
        text,
      },
    });
    for (const w of this.waiters.splice(0)) w();
    return update_id;
  }

  /** Calls of `method` (optionally for one token). */
  of(method: string, token?: string): BotApiCall[] {
    return this.calls.filter((c) => c.method === method && (token === undefined || c.token === token));
  }

  /** Pending (unconfirmed) update ids. */
  pendingIds(): number[] {
    return this.pending.map((u) => u.update_id);
  }

  readonly fetch: TelegramFetch = async (url, init) => {
    const answered = await this.answer(url, init.body, init.signal);
    if (!answered) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { status: answered.status, json: async () => answered.body };
  };

  async listen(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        const answered = await this.answer(req.url ?? '', raw, ac.signal);
        if (!answered) return void res.destroy();
        res.writeHead(answered.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answered.body));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const w of this.waiters.splice(0)) w();
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise<void>((r) => this.server!.close(() => r()));
    }
  }

  /** The answer, or null when the caller went away mid long-poll. */
  private async answer(url: string, rawBody: string, signal?: AbortSignal): Promise<{ status: number; body: unknown } | null> {
    const m = /\/bot([^/]+)\/([A-Za-z]+)$/.exec(new URL(url, 'http://x').pathname);
    if (!m) return { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } };
    const token = decodeURIComponent(m[1]!);
    const method = m[2]!;
    const params = rawBody ? JSON.parse(rawBody) : {};
    this.calls.push({ token, method, params });
    if (this.validTokens.size > 0 && !this.validTokens.has(token)) {
      return { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } };
    }
    if (method === 'getMe') return ok({ id: Number(token.split(':')[0]) || 1, is_bot: true, username: this.username });
    if (method === 'sendMessage') return ok({ message_id: this.nextSentId++, chat: { id: params.chat_id }, text: params.text });
    if (method === 'getUpdates') {
      const offset = typeof params.offset === 'number' ? params.offset : undefined;
      if (offset !== undefined) this.pending = this.pending.filter((u) => u.update_id >= offset);
      if (this.pending.length === 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, this.holdMs);
          const self = this;
          function done() {
            clearTimeout(t);
            self.waiters = self.waiters.filter((w) => w !== done);
            resolve();
          }
          this.waiters.push(done);
          signal?.addEventListener('abort', done);
        });
      }
      if (signal?.aborted) return null;
      return ok([...this.pending]);
    }
    return { status: 400, body: { ok: false, error_code: 400, description: `unknown method ${method}` } };
  }
}

function ok(result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { ok: true, result } };
}
