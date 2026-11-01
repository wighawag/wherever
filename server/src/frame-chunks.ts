/**
 * Frame chunking (`frames=chunk.v1`): split one large server -> client JSON frame
 * into several small TEXT frames that the client reassembles.
 *
 * Why: a browser hands a WebSocket message to the page only once ALL of it has
 * arrived. Over a slow link (a phone on a weak cell) a multi-MB frame, typically
 * a `message_history` carrying base64 tool images, takes longer to arrive than
 * the client's liveness watchdog tolerates silence (`STALE_SOCKET_MS`), so the
 * client tore down a healthy socket mid-transfer, reconnected, asked for the
 * same history and looped forever without ever painting it. Small frames make
 * every piece an inbound frame, which is the watchdog's proof of life.
 *
 * Opt-in per connection: the client says it understands chunks with the
 * `frames=chunk.v1` query parameter on the socket URL, so an older cached web
 * build (or the CLI bridge socket, which never asks) never receives a frame it cannot parse.
 *
 * Wire format of one chunk (a text frame): `\u0001<id> <seq> <count>\n<data>`.
 * The leading U+0001 can never start a JSON document, so a chunk is told apart
 * from an ordinary frame by its first character. `id` names the message, `seq`
 * is 0-based, `count` is the number of chunks; concatenating every chunk's data
 * in order gives back the original JSON text. The chunks of one message are sent
 * back to back, so frame ORDER on the socket is unchanged.
 *
 * The client half lives in `client/src/frame-chunks.ts` (kept in sync by hand:
 * the server does not depend on the client package).
 */

export const FRAME_CHUNK_PARAM = 'frames';
export const FRAME_CHUNK_VERSION = 'chunk.v1';
export const FRAME_CHUNK_MARK = '\u0001';
/** Chunk payload size in UTF-16 code units. ~32 KB keeps each piece a few
 *  seconds long even on a ~10 KB/s link. */
export const FRAME_CHUNK_CHARS = 32 * 1024;

/**
 * Split `json` into chunk frames, or return `[json]` unchanged when it fits in
 * one. Never splits a surrogate pair: a lone surrogate would be replaced by
 * U+FFFD when the frame is UTF-8 encoded, corrupting the text.
 */
export function splitFrame(json: string, id: number, maxChars = FRAME_CHUNK_CHARS): string[] {
  if (json.length <= maxChars) return [json];
  const pieces: string[] = [];
  let at = 0;
  while (at < json.length) {
    let end = Math.min(at + maxChars, json.length);
    if (end < json.length) {
      const c = json.charCodeAt(end - 1);
      // Back off one so the pair stays whole; with a 1-char budget that would
      // make no progress, so take the whole pair instead.
      if (c >= 0xd800 && c <= 0xdbff) end = end - 1 > at ? end - 1 : end + 1;
    }
    pieces.push(json.slice(at, end));
    at = end;
  }
  return pieces.map((data, seq) => `${FRAME_CHUNK_MARK}${id} ${seq} ${pieces.length}\n${data}`);
}

/** True when the socket URL's query string asks for chunked frames. */
export function wantsFrameChunks(searchParams: URLSearchParams): boolean {
  return searchParams.getAll(FRAME_CHUNK_PARAM).includes(FRAME_CHUNK_VERSION);
}
