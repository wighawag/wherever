/**
 * Tool images by reference in `message_history`.
 *
 * A history window inlines every tool image as base64 (a `read` on a screenshot
 * is often 1-3 MB), and the window is re-sent on every load AND on every
 * reconnect. Over a slow link that made a session with a few screenshots take
 * minutes to resync, every time the phone dropped its socket. A socket that asks
 * for refs (`imageRefs=1` on the socket URL) gets large images WITHOUT their
 * bytes; the web loads each one lazily from `GET /session/tool-image`, which the
 * browser caches (a tool result never changes), so a reconnect costs text only.
 *
 * Opt-in so an older cached web build, which only knows inline `data`, keeps
 * getting it. Only images with a `toolCallId` to address them by are stripped,
 * and small ones stay inline (a fetch costs more than it saves).
 */
import type { HistoryMessage } from './session-types.js';

export const IMAGE_REFS_PARAM = 'imageRefs';
/** Base64 characters above which an image is sent by reference. */
export const INLINE_IMAGE_MAX_CHARS = 16 * 1024;

export function wantsImageRefs(searchParams: URLSearchParams): boolean {
  return searchParams.get(IMAGE_REFS_PARAM) === '1';
}

/** Approximate decoded size of a base64 string. */
function base64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

/**
 * A copy of `messages` with large tool images replaced by references. Messages
 * without such images are returned as is (same objects), so the common case
 * allocates nothing.
 */
export function stripHistoryImages(messages: HistoryMessage[]): HistoryMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    if (!m.toolCallId || !m.images?.some(byRef)) return m;
    changed = true;
    return {
      ...m,
      images: m.images.map((i, index) =>
        byRef(i)
          ? {
              mimeType: i.mimeType,
              bytes: base64Bytes(i.data!),
              toolCallId: m.toolCallId,
              ...(m.entryId ? { entryId: m.entryId } : {}),
              index,
            }
          : i,
      ),
    };
  });
  return changed ? out : messages;
}

function byRef(i: { mimeType: string; data?: string }): boolean {
  return typeof i.data === 'string' && i.data.length > INLINE_IMAGE_MAX_CHARS && SERVABLE_IMAGE_TYPES.has(i.mimeType);
}

/**
 * Raster types the endpoint will serve inline (and so the only ones sent by
 * reference). SVG is excluded on purpose (it can carry script; see
 * dispositionTypeFor in index.ts), as is anything unexpected.
 */
export const SERVABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);
