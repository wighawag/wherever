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
  /** JSON params; for a multipart call (sendPhoto / sendDocument) the fields, the file as `{name, size, bytes}`. */
  params: Record<string, any>;
}

/** A file the fake serves through `getFile` + `/file/bot<token>/<file_path>`. */
interface FakeFile {
  bytes: Buffer;
  filePath: string;
  /** The size `getFile` reports (defaults to the byte length). */
  fileSize: number;
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
  /** Methods answered with a 400 (e.g. `sendMessageDraft` on an older Bot API). */
  failMethods = new Set<string>();
  private files = new Map<string, FakeFile>();
  private nextFileId = 1;
  /** File downloads served (`/file/bot<token>/<path>`), by file path. */
  readonly downloads: string[] = [];

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

  /**
   * Register a file the bot can download; returns its `file_id`. `fileSize`
   * overrides the size `getFile` reports (a "too big" file without its bytes).
   */
  addFile(bytes: Buffer | string, opts: { fileSize?: number; ext?: string } = {}): string {
    const id = `file-${this.nextFileId++}`;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    this.files.set(id, { bytes: buf, filePath: `documents/${id}${opts.ext ?? ''}`, fileSize: opts.fileSize ?? buf.length });
    return id;
  }

  /**
   * Queue an incoming message carrying media (a `photo` size list and/or a
   * `document`), with an optional `caption` and `media_group_id` (an album).
   */
  media(
    fromId: number,
    fields: {
      photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
      document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
      caption?: string;
      media_group_id?: string;
      [k: string]: unknown;
    },
  ): number {
    const update_id = this.nextId++;
    this.pending.push({
      update_id,
      message: {
        message_id: update_id,
        from: { id: fromId, first_name: `user${fromId}` },
        chat: { id: fromId, type: 'private' },
        ...fields,
      } as any,
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
    const file = this.serveFile(url);
    if (file) return { status: file.status, json: async () => ({}), arrayBuffer: async () => toArrayBuffer(file.bytes) };
    const params = init.body instanceof FormData ? await formParams(init.body) : init.body ? JSON.parse(init.body) : {};
    const answered = await this.answer(url, params, init.signal);
    if (!answered) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { status: answered.status, json: async () => answered.body, arrayBuffer: async () => toArrayBuffer(Buffer.from(JSON.stringify(answered.body))) };
  };

  async listen(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const file = this.serveFile(req.url ?? '');
      if (file) {
        res.writeHead(file.status, { 'Content-Type': 'application/octet-stream' });
        res.end(file.bytes);
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        const raw = Buffer.concat(chunks);
        const type = String(req.headers['content-type'] ?? '');
        const params = type.startsWith('multipart/form-data')
          ? await formParams(await new Request('http://x/', { method: 'POST', headers: { 'content-type': type }, body: raw }).formData())
          : raw.length
            ? JSON.parse(raw.toString('utf8'))
            : {};
        const answered = await this.answer(req.url ?? '', params, ac.signal);
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
  /** A `/file/bot<token>/<file_path>` download, or null for an API call. */
  private serveFile(url: string): { status: number; bytes: Buffer } | null {
    const m = /^\/file\/bot([^/]+)\/(.+)$/.exec(new URL(url, 'http://x').pathname);
    if (!m) return null;
    const filePath = decodeURIComponent(m[2]!);
    const file = [...this.files.values()].find((f) => f.filePath === filePath);
    this.downloads.push(filePath);
    return file ? { status: 200, bytes: file.bytes } : { status: 404, bytes: Buffer.from('Not Found') };
  }

  private async answer(url: string, params: Record<string, any>, signal?: AbortSignal): Promise<{ status: number; body: unknown } | null> {
    const m = /\/bot([^/]+)\/([A-Za-z]+)$/.exec(new URL(url, 'http://x').pathname);
    if (!m) return { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } };
    const token = decodeURIComponent(m[1]!);
    const method = m[2]!;
    this.calls.push({ token, method, params });
    if (this.validTokens.size > 0 && !this.validTokens.has(token)) {
      return { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } };
    }
    if (method === 'getMe') return ok({ id: Number(token.split(':')[0]) || 1, is_bot: true, username: this.username });
    if (this.failMethods.has(method)) {
      return { status: 400, body: { ok: false, error_code: 400, description: `Bad Request: ${method} is not available` } };
    }
    if (method === 'sendMessage') return ok({ message_id: this.nextSentId++, chat: { id: params.chat_id }, text: params.text });
    if (method === 'editMessageText') return ok({ message_id: params.message_id, chat: { id: params.chat_id }, text: params.text });
    if (method === 'sendMessageDraft' || method === 'setMessageReaction') return ok(true);
    if (method === 'sendPhoto' || method === 'sendDocument') return ok({ message_id: this.nextSentId++, chat: { id: Number(params.chat_id) } });
    if (method === 'getFile') {
      const f = this.files.get(String(params.file_id));
      if (!f) return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: invalid file_id' } };
      // The cloud Bot API refuses to hand out files over 20 MB.
      if (f.fileSize > 20 * 1024 * 1024) return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: file is too big' } };
      return ok({ file_id: params.file_id, file_unique_id: `u-${params.file_id}`, file_size: f.fileSize, file_path: f.filePath });
    }
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

/** A multipart body as params: text fields as strings, a file as `{name, size, bytes}`. */
async function formParams(form: FormData): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') out[key] = value;
    else {
      const bytes = Buffer.from(await (value as Blob).arrayBuffer());
      out[key] = { name: (value as File).name, size: bytes.length, bytes };
    }
  }
  return out;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function ok(result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { ok: true, result } };
}
