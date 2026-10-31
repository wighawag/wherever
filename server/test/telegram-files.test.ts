import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelDispatcher, channelMessageText, type ChannelControllerPort, type ChannelPoolPort } from '../src/assistant-channels.ts';
import { TELEGRAM_PAIRING_FILE, TelegramChannel, type TelegramChannelOptions } from '../src/telegram-channel.ts';
import {
  FILES_UNAVAILABLE_REPLY,
  TELEGRAM_UPLOAD_MAX_BYTES,
  UNSUPPORTED_MEDIA_REPLY,
  attachedFileOf,
  attachmentPlan,
  inboundFilesOf,
  safeFileName,
  saveUploaded,
} from '../src/telegram-files.ts';
import { FakeBotApi } from './fake-bot-api.ts';

/**
 * FILES on the Telegram channel (task `telegram-files`), through the REAL
 * channel dispatcher and Telegram channel, with a CONTROLLER fake, a POOL event
 * fake and the Bot API mocked at the HTTP boundary:
 *  - INBOUND: a photo / document / album from the paired user is downloaded
 *    into the (temp) upload dir and reaches the controller as
 *    `[Uploaded file: <path>]` lines, the caption as the text; limits refuse
 *    with a note; a stranger's file is never fetched;
 *  - OUTBOUND: `attach_file` in Telegram-routed output sends the file
 *    (`sendPhoto` / `sendDocument`), an oversize file gets a note, and output
 *    routed anywhere else sends nothing.
 * Temp state and upload dirs; the real ~/.wherever is asserted untouched.
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

const TOKEN = '123456:files-token';
const USER = 7;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

class FakePool implements ChannelPoolPort {
  listeners = new Set<(f: string, e: { type: string; [k: string]: unknown }, d: string | null) => void>();
  subscribeEvents(l: (f: string, e: { type: string; [k: string]: unknown }, d: string | null) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(event: { type: string; [k: string]: unknown }, destination: string | null) {
    for (const l of this.listeners) l('/assistant/s.jsonl', event, destination);
  }
}

async function setup(opts: Partial<TelegramChannelOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-tg-files-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const uploads = path.join(root, 'uploads');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, TELEGRAM_PAIRING_FILE), JSON.stringify({ userId: String(USER), chatId: String(USER) }));
  const api = new FakeBotApi(30);
  const sent: Array<{ text: string; origin: string }> = [];
  const controller: ChannelControllerPort = {
    send: async (text, origin, _b, o) => {
      sent.push({ text, origin });
      o?.onDispatch?.({ sessionFile: '/assistant/s.jsonl', steered: false });
    },
  };
  const pool = new FakePool();
  const channel = new TelegramChannel({
    token: TOKEN,
    stateDir,
    configuredUserId: null,
    fetch: api.fetch,
    retryDelayMs: () => 10,
    replyThrottleMs: 0,
    mediaGroupDelayMs: 40,
    uploadDir: () => uploads,
    log: quiet,
    ...opts,
  });
  const dispatcher = new ChannelDispatcher({ controller, pool, channels: [channel] });
  await dispatcher.start();
  cleanups.push(() => dispatcher.stop());
  return { api, sent, pool, channel, uploads, root };
}

const texts = (api: FakeBotApi) => api.of('sendMessage').map((c) => String(c.params.text));

describe('Telegram files: inbound (to the upload dir, as paths in the text)', () => {
  it('a photo with a caption reaches the assistant as a saved path, the caption as the text', async () => {
    const { api, sent, uploads } = await setup();
    const small = api.addFile('small');
    const big = api.addFile('the big photo bytes', { ext: '.jpg' });
    const id = api.media(USER, {
      photo: [
        { file_id: small, width: 90, height: 90, file_size: 5 },
        { file_id: big, width: 1280, height: 960, file_size: 19 },
      ],
      caption: 'what is this?',
    });
    await until(() => sent.length === 1);
    const saved = fs.readdirSync(uploads);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(new RegExp(`^\\d+_photo-${id}\\.jpg$`));
    const file = path.join(uploads, saved[0]!);
    expect(fs.readFileSync(file, 'utf8')).toBe('the big photo bytes');
    expect(sent[0]).toEqual({ text: `what is this?\n\n[Uploaded file: ${file}]`, origin: 'telegram' });
    // Only the largest size was fetched.
    expect(api.of('getFile').map((c) => c.params.file_id)).toEqual([big]);
  });

  it('a document without a caption: the files ARE the message (as a web upload with no text)', async () => {
    const { api, sent, uploads } = await setup();
    const doc = api.addFile('%PDF-1.4');
    api.media(USER, { document: { file_id: doc, file_name: '../../report.pdf', mime_type: 'application/pdf', file_size: 8 } });
    await until(() => sent.length === 1);
    const [name] = fs.readdirSync(uploads);
    expect(name).toMatch(/^\d+_report\.pdf$/);
    expect(sent[0]!.text).toBe(`I have uploaded the following file(s) for you:\n[Uploaded file: ${path.join(uploads, name!)}]`);
  });

  it('an album is gathered into ONE message, before a text sent after it', async () => {
    const { api, sent, uploads } = await setup();
    const a = api.addFile('one');
    const b = api.addFile('two');
    api.media(USER, { media_group_id: 'g1', document: { file_id: a, file_name: 'same.txt' }, caption: 'both of these' });
    api.media(USER, { media_group_id: 'g1', document: { file_id: b, file_name: 'same.txt' } });
    api.message(USER, 'and a question after');
    await until(() => sent.length === 2);
    const files = fs.readdirSync(uploads).sort();
    expect(files).toHaveLength(2);
    expect(files.map((f) => fs.readFileSync(path.join(uploads, f), 'utf8')).sort()).toEqual(['one', 'two']);
    expect(sent[0]!.text.split('\n')[0]).toBe('both of these');
    expect(sent[0]!.text.match(/\[Uploaded file: /g)).toHaveLength(2);
    expect(sent[1]!.text).toBe('and a question after');
  });

  it('a file over the limit is refused with a clear note and never downloaded', async () => {
    const { api, sent } = await setup({ maxUploadBytes: () => 1000 });
    const huge = api.addFile('x', { fileSize: 25 * 1024 * 1024 });
    api.media(USER, { document: { file_id: huge, file_name: 'video.mkv', file_size: 25 * 1024 * 1024 } });
    const over = api.addFile('y'.repeat(2000));
    api.media(USER, { document: { file_id: over, file_name: 'notes.txt' }, caption: 'read this' });
    await until(() => sent.length === 1);
    expect(texts(api)[0]).toMatch(/video\.mkv is too large for the assistant to receive \(25 MB; the limit is 1000 bytes\)/);
    expect(texts(api)[1]).toMatch(/notes\.txt is too large for the assistant to receive/);
    // The first is refused from the announced size: no getFile, no download.
    expect(api.of('getFile').map((c) => c.params.file_id)).toEqual([over]);
    // The caption still reaches the assistant.
    expect(sent[0]!.text).toBe('read this');
  });

  it('a stranger\'s file is never fetched; unsupported media gets a short reply', async () => {
    const { api, sent } = await setup();
    const f = api.addFile('secret');
    api.media(99, { document: { file_id: f, file_name: 'a.txt' } });
    api.media(USER, { voice: { file_id: 'v1', duration: 2 } });
    await until(() => texts(api).length === 1);
    expect(texts(api)).toEqual([UNSUPPORTED_MEDIA_REPLY]);
    expect(api.of('getFile')).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('without an upload dir, files are refused out loud', async () => {
    const { api, sent } = await setup({ uploadDir: undefined });
    api.media(USER, { document: { file_id: api.addFile('z'), file_name: 'a.txt' } });
    await until(() => texts(api).length === 1);
    expect(texts(api)).toEqual([FILES_UNAVAILABLE_REPLY]);
    expect(sent).toEqual([]);
  });

  it('a "!" caption is refused before anything is downloaded', async () => {
    const { api, sent } = await setup();
    api.media(USER, { document: { file_id: api.addFile('z'), file_name: 'a.sh' }, caption: '!bash a.sh' });
    await until(() => texts(api).length === 1);
    expect(api.of('getFile')).toEqual([]);
    expect(sent).toEqual([]);
  });
});

const attachEnd = (p: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool_execution_end',
  toolName: 'attach_file',
  isError: false,
  result: { content: [{ type: 'text', text: 'Attached' }], details: { path: p, filename: path.basename(p), size: 1 } },
  ...extra,
});

describe('Telegram files: outbound (attach_file)', () => {
  it('in a Telegram-routed reply: an image as a photo, anything else as a document', async () => {
    const { api, pool, channel, root } = await setup();
    const png = path.join(root, 'chart.png');
    const pdf = path.join(root, 'report.pdf');
    fs.writeFileSync(png, 'PNGDATA');
    fs.writeFileSync(pdf, 'PDFDATA');
    pool.emit(attachEnd(png), 'telegram');
    pool.emit(attachEnd(pdf), 'telegram');
    await channel.replyIdle();
    const photo = api.of('sendPhoto');
    const doc = api.of('sendDocument');
    expect(photo).toHaveLength(1);
    expect(photo[0]!.params.chat_id).toBe(String(USER));
    expect(photo[0]!.params.photo).toMatchObject({ name: 'chart.png', size: 7 });
    expect(photo[0]!.params.photo.bytes.toString()).toBe('PNGDATA');
    expect(doc).toHaveLength(1);
    expect(doc[0]!.params.document).toMatchObject({ name: 'report.pdf', size: 7 });
  });

  it('an oversize file produces a clear note instead; a refused photo falls back to a document', async () => {
    const { api, pool, channel, root } = await setup();
    const huge = path.join(root, 'dump.tar');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, TELEGRAM_UPLOAD_MAX_BYTES + 1);
    pool.emit(attachEnd(huge), 'telegram');
    await channel.replyIdle();
    expect(api.of('sendDocument')).toEqual([]);
    expect(texts(api)).toHaveLength(1);
    expect(texts(api)[0]).toMatch(/dump\.tar is too large to send on Telegram \(50 MB; bots can send at most 50 MB\)/);
    expect(texts(api)[0]).toContain(huge);

    api.failMethods.add('sendPhoto');
    const img = path.join(root, 'wide.jpg');
    fs.writeFileSync(img, 'JPG');
    pool.emit(attachEnd(img), 'telegram');
    await channel.replyIdle();
    expect(api.of('sendDocument').map((c) => c.params.document.name)).toEqual(['wide.jpg']);
  });

  it('files from non-Telegram turns, failed attach_file calls and other tools are never sent', async () => {
    const { api, pool, channel, root } = await setup();
    const f = path.join(root, 'x.txt');
    fs.writeFileSync(f, 'x');
    pool.emit(attachEnd(f), 'none');
    pool.emit(attachEnd(f), 'schedule:job1');
    pool.emit(attachEnd(f), null);
    pool.emit(attachEnd(f, { isError: true }), 'telegram');
    pool.emit(attachEnd(f, { toolName: 'read' }), 'telegram');
    await channel.replyIdle();
    expect(api.calls.filter((c) => ['sendPhoto', 'sendDocument', 'sendMessage'].includes(c.method))).toEqual([]);
  });

  it('the file goes out after the text written before the call', async () => {
    const { api, pool, channel, root } = await setup();
    const f = path.join(root, 'r.txt');
    fs.writeFileSync(f, 'r');
    pool.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Here it is' }], stopReason: 'toolUse' } }, 'telegram');
    pool.emit(attachEnd(f), 'telegram');
    await channel.replyIdle();
    const order = api.calls.filter((c) => ['sendMessage', 'sendDocument'].includes(c.method)).map((c) => c.method);
    expect(order).toEqual(['sendMessage', 'sendDocument']);
  });
});

describe('telegram-files helpers', () => {
  it('channelMessageText matches the web composer', () => {
    expect(channelMessageText(' hi ', undefined)).toBe('hi');
    expect(channelMessageText('hi', [{ path: '/a' }, { path: '/b' }])).toBe('hi\n\n[Uploaded file: /a]\n[Uploaded file: /b]');
    expect(channelMessageText('  ', [{ path: '/a' }])).toBe('I have uploaded the following file(s) for you:\n[Uploaded file: /a]');
  });

  it('attachmentPlan: photo up to 10 MB for jpg/png/webp, document up to 50 MB, else too large', () => {
    expect(attachmentPlan('/a.PNG', 10)).toEqual({ kind: 'photo' });
    expect(attachmentPlan('/a.gif', 10)).toEqual({ kind: 'document' });
    expect(attachmentPlan('/a.jpg', 11 * 1024 * 1024)).toEqual({ kind: 'document' });
    expect(attachmentPlan('/a.zip', TELEGRAM_UPLOAD_MAX_BYTES + 1)).toEqual({ kind: 'too-large', limit: TELEGRAM_UPLOAD_MAX_BYTES });
  });

  it('attachedFileOf reads a successful attach_file result only', () => {
    expect(attachedFileOf(attachEnd('/x/y.txt'))).toEqual({ path: '/x/y.txt', filename: 'y.txt' });
    expect(attachedFileOf(attachEnd('relative.txt'))).toBeNull();
    expect(attachedFileOf({ type: 'tool_execution_start', toolName: 'attach_file', args: { path: '/x' } })).toBeNull();
  });

  it('safeFileName and saveUploaded never escape the dir nor overwrite', async () => {
    expect(safeFileName('../../etc/passwd', 'f')).toBe('passwd');
    expect(safeFileName('a\\b\\c.txt', 'f')).toBe('c.txt');
    expect(safeFileName('..', 'f')).toBe('f');
    expect(safeFileName(undefined, 'f')).toBe('f');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-tg-save-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const a = await saveUploaded(dir, 'n.txt', Buffer.from('1'), 5);
    const b = await saveUploaded(dir, 'n.txt', Buffer.from('2'), 5);
    expect(path.basename(a)).toBe('5_n.txt');
    expect(path.basename(b)).toBe('5_n-1.txt');
    expect(fs.readFileSync(a, 'utf8')).toBe('1');
  });

  it('inboundFilesOf takes the largest photo and the document', () => {
    expect(
      inboundFilesOf({
        message_id: 3,
        photo: [{ file_id: 'b', width: 800, height: 600 }, { file_id: 's', width: 80, height: 60 }],
        document: { file_id: 'd', mime_type: 'text/plain' },
      }),
    ).toEqual([
      { fileId: 'b', name: 'photo-3.jpg', mimeType: 'image/jpeg' },
      { fileId: 'd', name: 'document-3', mimeType: 'text/plain' },
    ]);
  });
});
