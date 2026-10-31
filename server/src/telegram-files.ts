import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * FILES on the Telegram channel, both ways (task `telegram-files`, story 17).
 * The mechanics are ported from the MIT `badlogic/pi-telegram` extension
 * (`downloadTelegramFile`, `sendQueuedAttachments`):
 *
 * - INBOUND: a photo (its largest size) or a document from the paired user is
 *   fetched with `getFile` + the `/file/bot<token>/<file_path>` download and
 *   written to the UPLOAD DIR (the same place a web upload lands:
 *   `resolveUploadDir(config, <assistantFolder>)` in index.ts, which follows
 *   `uploads.type`), named `<timestamp>_<name>` like a web upload. The channel
 *   then passes the saved paths with the message (`ChannelUserMessage.files`),
 *   and the dispatcher writes them into the text exactly as the web composer
 *   does (`channelMessageText`).
 * - OUTBOUND: a successful `attach_file` call (its `tool_execution_end`) in
 *   output whose destination is `telegram` sends the file: `sendPhoto` for a
 *   jpg / png / webp up to 10 MB, `sendDocument` otherwise (and when Telegram
 *   refuses the photo), up to 50 MB. A bigger file gets a clear note instead.
 *
 * Decisions (recorded in work/notes/observations/telegram-files-decisions.md):
 * "upload staging" in the task is the upload DIR, not `<state>/upload-staging`
 * (that is the chunked-upload scratch area: garbage-collected after 24 h and
 * never downloadable); the limits are the cloud Bot API's (20 MB download,
 * 10 MB photo, 50 MB upload), whatever `apiBaseUrl` points at.
 */

/** The cloud Bot API's download limit (`getFile`). */
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** The largest file `sendPhoto` takes. */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** The largest file a bot can send (`sendDocument`). */
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** The slice of a Bot API `Message`'s media this channel reads. */
export interface TelegramMediaFields {
  message_id: number;
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

/** One file to fetch from Telegram. */
export interface TelegramInboundFile {
  fileId: string;
  /** The name it is saved under (before the timestamp prefix). */
  name: string;
  mimeType?: string;
  /** The size Telegram announced, when it did. */
  size?: number;
}

/** Message fields that carry media this channel does NOT take (voice notes are out of the spec's scope). */
const UNSUPPORTED_MEDIA = ['voice', 'video', 'video_note', 'audio', 'animation', 'sticker'] as const;

/** The photo (largest size) and document of a message, in that order. */
export function inboundFilesOf(m: TelegramMediaFields): TelegramInboundFile[] {
  const out: TelegramInboundFile[] = [];
  if (Array.isArray(m.photo) && m.photo.length > 0) {
    const best = [...m.photo].sort((a, b) => area(a) - area(b) || (a.file_size ?? 0) - (b.file_size ?? 0)).pop()!;
    out.push({ fileId: best.file_id, name: `photo-${m.message_id}.jpg`, mimeType: 'image/jpeg', ...(best.file_size ? { size: best.file_size } : {}) });
  }
  const d = m.document;
  if (d && typeof d.file_id === 'string') {
    out.push({
      fileId: d.file_id,
      name: safeFileName(d.file_name, `document-${m.message_id}`),
      ...(d.mime_type ? { mimeType: d.mime_type } : {}),
      ...(d.file_size ? { size: d.file_size } : {}),
    });
  }
  return out;
}

function area(p: { width?: number; height?: number }): number {
  return (p.width ?? 0) * (p.height ?? 0);
}

/** True when the message carries media this channel does not take (a voice note, a video, a sticker, ...). */
export function hasUnsupportedMedia(m: Record<string, unknown>): boolean {
  return UNSUPPORTED_MEDIA.some((k) => m[k] !== undefined && m[k] !== null);
}

/** A name safe to save under: the last path segment, no control characters; `fallback` when nothing usable is left. */
export function safeFileName(name: string | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(String(name ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : fallback;
}

/**
 * Write `bytes` into `dir` as `<now>_<name>` (a web upload's naming), never
 * overwriting: a name already taken gets `-1`, `-2`, ... before its extension
 * (an album of documents with one name). Returns the saved path.
 */
export async function saveUploaded(dir: string, name: string, bytes: Uint8Array, now: number = Date.now()): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const file = path.join(dir, `${now}_${i === 0 ? name : `${stem}-${i}${ext}`}`);
    try {
      await fsp.writeFile(file, bytes, { flag: 'wx' });
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST' || i > 1000) throw err;
    }
  }
}

/** How a file the assistant attached goes out on Telegram. */
export type AttachmentPlan =
  | { kind: 'photo' | 'document' }
  | { kind: 'too-large'; limit: number };

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** `sendPhoto` for a still image Telegram can show up to 10 MB, `sendDocument` up to 50 MB, else too large. */
export function attachmentPlan(filePath: string, size: number): AttachmentPlan {
  if (size > TELEGRAM_UPLOAD_MAX_BYTES) return { kind: 'too-large', limit: TELEGRAM_UPLOAD_MAX_BYTES };
  if (size <= TELEGRAM_PHOTO_MAX_BYTES && PHOTO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return { kind: 'photo' };
  return { kind: 'document' };
}

/** Bytes as `12.3 MB`. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/** The note sent instead of a file too large to send. */
export function attachmentTooLargeNote(filename: string, size: number, limit: number, filePath: string): string {
  return `📎 ${filename} is too large to send on Telegram (${formatBytes(size)}; bots can send at most ${formatBytes(limit)}). It is on the server at ${filePath}, and the wherever web app can download it.`;
}

/** The note sent when an attached file could not be sent. */
export function attachmentFailedNote(filename: string, error: string): string {
  return `⚠️ Could not send ${filename} on Telegram: ${error}`;
}

/** The note sent when a file from Telegram could not be received. */
export function inboundTooLargeNote(name: string, size: number | undefined, limit: number): string {
  const what = typeof size === 'number' ? `${formatBytes(size)}; the limit is ${formatBytes(limit)}` : `the limit is ${formatBytes(limit)}`;
  return `⚠️ ${name} is too large for the assistant to receive (${what}).`;
}

/** The note sent when a file from Telegram could not be fetched. */
export function inboundFailedNote(name: string, error: string): string {
  return `⚠️ Could not receive ${name}: ${error}`;
}

/** The reply to media this channel does not take, sent without any text. */
export const UNSUPPORTED_MEDIA_REPLY = 'Only text, photos and documents can be sent to the assistant. Send the file as a document instead.';

/** The reply when files cannot be received at all (no upload dir). */
export const FILES_UNAVAILABLE_REPLY = '⚠️ Files cannot be received on this server.';

/** A successful `attach_file` call's file (`details.path`), from a `tool_execution_end` event, or null. */
export function attachedFileOf(event: { type: string; [k: string]: unknown }): { path: string; filename: string } | null {
  if (event.type !== 'tool_execution_end' || event.toolName !== 'attach_file' || event.isError === true) return null;
  const details = (event.result as { details?: { path?: unknown; filename?: unknown } } | undefined)?.details;
  if (!details || typeof details.path !== 'string' || !path.isAbsolute(details.path)) return null;
  return { path: details.path, filename: typeof details.filename === 'string' && details.filename ? details.filename : path.basename(details.path) };
}

/** The size of a regular file, or null (gone, not a file). */
export function fileSize(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}
