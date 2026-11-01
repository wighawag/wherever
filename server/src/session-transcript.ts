/**
 * Bounded-memory readers for session `.jsonl` transcripts.
 *
 * A pi session file is an append-only JSONL transcript, and on a real machine
 * that corpus is GIGABYTES (measured: 3,831 files / 2.0 GB, single files up to
 * 62 MB). Every reader in this server therefore has ONE hard rule:
 *
 *   **Never materialize a whole transcript.**
 *
 * That rule is not a micro-optimization, it is the difference between a server
 * that idles at tens of MB and one systemd-oomd kills. The two paths that used
 * to break it, and what they cost, are:
 *
 *  - the `/sessions` listing scan, which did `readFile(utf8)` + `split('\n')` +
 *    `JSON.parse` per line into a RETAINED `entries[]` array, per file. One
 *    62 MB transcript becomes a 62 MB string, a ~62 MB array of line strings and
 *    a few hundred MB of parsed objects, all live at once. Startup (which warms
 *    the listing cache) peaked at ~1.0 GB RSS and settled at ~460 MB.
 *  - every history read (`session_load`, `history_page`, `cli_register`), which
 *    went through pi's `SessionManager.open()` (which loads and parses the WHOLE
 *    file TWICE) and then mapped EVERY entry into a `HistoryMessage[]`
 *    (including base64 tool images) only to slice the last 60. Repeated for the
 *    life of the process, so RSS ratchets up and never comes back down.
 *
 * Both are replaced by streaming passes here, in three layers:
 *
 *  1. newlines are found in the BYTES of a pooled 64 KB chunk, so nothing is
 *     decoded just to be looked at;
 *  2. each line is classified from a bounded 512-byte HEAD, and a line the
 *     caller does not want is DISCARDED without ever becoming a string;
 *  3. only the wanted lines are decoded and parsed, and the parse result is
 *     dropped unless it belongs in the answer.
 *
 * So peak memory is bounded by the largest line we actually WANT (tool results,
 * which are most of a transcript's bytes, are never assembled), and the retained
 * result is bounded by what the caller asked for: one small listing record, or
 * one window of history.
 *
 * The readers are async and yield between chunks so a multi-MB transcript can
 * never pin the event loop (which is what made "Loading session..." hang before
 * the listing scan was made async).
 *
 * Measured on that 2.0 GB corpus (built server, same method on both sides):
 * startup peak RSS 990 MB -> 208 MB; opening the largest session (59 MB) 401 ms
 * of blocked loop and ~130 MB per open -> 71 ms non-blocking, plateauing at
 * ~340 MB over 150 consecutive opens with live heap flat at 39 MB.
 * `server/test/bench/` holds the harnesses; re-measure there before trusting a
 * change to this file.
 */
import fs from 'node:fs';
import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { HistoryMessage } from './session-types.js';

/**
 * Chunk size for the streaming line reader. Deliberately modest: the buffer is
 * allocated per open file and the reader is async, so several can be in flight;
 * bigger chunks buy nothing here (the parse dominates) and cost resident bytes.
 */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Cap on a single line the LISTING scan is willing to hand to `JSON.parse`. A
 * parsed object graph costs several times its source text, and the listing only
 * ever needs a 160-char preview and a timestamp out of a line, so an absurd one
 * (a multi-MB pasted payload) falls back to bounded text probes instead. The
 * HISTORY reader has no such cap: there, the line's content IS the answer, and
 * refusing to parse it would silently drop a message from the transcript.
 */
const MAX_LISTING_PARSE_BYTES = 4 * 1024 * 1024;

/**
 * Max length of the first-message PREVIEW shipped in the /sessions list. The
 * sidebar only renders a ~40-char snippet and filters on the text, so the full
 * (often huge: pasted prompts, PRDs, specs) first message must never cross the
 * wire for every session. This caps each entry, which is the dominant factor in
 * the /sessions payload size.
 */
const FIRST_MESSAGE_PREVIEW_MAX = 160;

/**
 * Force a string to be an independent, flat copy.
 *
 * V8 represents `big.slice(0, 160)` as a SlicedString that keeps its PARENT
 * alive. That is free when the preview is transient, but the listing cache
 * holds one preview per session for the process's lifetime, so an un-flattened
 * slice would pin every full first message (pasted PRDs, specs) in memory:
 * measured at ~33 MB of retained parents for ~2800 sessions whose visible
 * previews total under 1 MB. The Buffer round-trip allocates a fresh string.
 */
export function flattenString(s: string): string {
  return s.length === 0 ? s : Buffer.from(s, 'utf8').toString('utf8');
}

/**
 * Collapse whitespace and cap to a short preview. Keeps the /sessions payload
 * tens-of-KB instead of multi-MB while preserving what the sidebar displays and
 * filters on. The result is flattened so caching it cannot retain the (possibly
 * huge) message it was sliced from.
 */
export function previewText(text: string | undefined | null): string {
  const collapsed = (text || '').replace(/\s+/g, ' ').trim();
  return flattenString(
    collapsed.length > FIRST_MESSAGE_PREVIEW_MAX
      ? collapsed.slice(0, FIRST_MESSAGE_PREVIEW_MAX) + '\u2026'
      : collapsed,
  );
}

/** Yield to the event loop between chunks of a large transcript. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Read buffers, reused across files.
 *
 * A 64 KB `Buffer.allocUnsafe` is above V8's pooling threshold, so each one is
 * its own external allocation that only goes away at the next GC. Allocating a
 * fresh one per file meant ~240 MB of external churn for a single pass over a
 * 3,700-file sessions directory, and the process RSS stayed at that high-water
 * mark long after the bytes were dead (glibc does not hand the arena back).
 * Reusing them caps the buffers in play at the number of CONCURRENT readers,
 * which is a handful.
 */
const bufferPool: Buffer[] = [];
const BUFFER_POOL_MAX = 8;

function takeBuffer(): Buffer {
  return bufferPool.pop() ?? Buffer.allocUnsafe(READ_CHUNK_BYTES);
}

function releaseBuffer(buf: Buffer): void {
  if (bufferPool.length < BUFFER_POOL_MAX) bufferPool.push(buf);
}

/**
 * How much of a line a `skip` probe gets to look at, in BYTES. Enough to cover a
 * session entry's fixed header keys (`type`, `id`, `parentId`, `timestamp`, and
 * the opening of `message`), which is all any classification here needs. A head
 * cut mid-character decodes with a replacement char at its end; every probe is
 * anchored on ASCII structure, so that is harmless.
 */
const PROBE_HEAD_BYTES = 512;

export interface JsonlLineReader {
  /**
   * Classify a line from a bounded HEAD of it (the first `PROBE_HEAD_BYTES`
   * bytes of it, or the whole line if shorter). Returning true DISCARDS the rest
   * of that line: it is never assembled into a string, so a 30 MB tool result
   * costs one chunk instead of 30 MB + its parse. Any accounting for a skipped
   * line (counting it, for instance) must therefore happen HERE.
   */
  skip?: (head: string) => boolean;
  /** Called with the full line, unless `skip` claimed it. Return false to stop. */
  line: (line: string) => boolean | void;
}

/**
 * Stream a `.jsonl` file line by line, holding at most one chunk plus the line
 * currently being assembled. Returns false when the file could not be opened.
 *
 * Newlines are found in the BYTES, and only the parts we actually want are
 * decoded to strings: a `skip` probe sees a bounded head (a few hundred bytes),
 * and a claimed line is never decoded at all. Decoding every chunk instead --
 * the obvious implementation -- turns the entire corpus into string garbage
 * (2 GB of transcripts is 2 GB of throwaway strings), which is exactly the churn
 * that keeps a long-lived process's RSS pinned at its high-water mark.
 *
 * The strings handed to the callbacks are TRANSIENT. Anything retained past the
 * callback must be flattened (`flattenString` / `previewText`), or it pins the
 * chunk it came from.
 */
const NEWLINE = 0x0a;

export async function forEachJsonlLine(
  filePath: string,
  handler: JsonlLineReader | ((line: string) => boolean | void),
): Promise<boolean> {
  const reader: JsonlLineReader = typeof handler === 'function' ? { line: handler } : handler;
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(filePath, 'r');
  } catch {
    return false;
  }
  const buffer = takeBuffer();
  try {
    // Pieces of the line currently being assembled, as COPIES: `buffer` is
    // overwritten by the next read, so anything that must outlive this chunk has
    // to be copied out. Only lines that span a chunk boundary pay for this; a
    // line contained in one chunk is decoded straight from `buffer`.
    let pieces: Buffer[] = [];
    let piecesLen = 0;
    // Head bytes of the current line, for the classification probe.
    const head = Buffer.allocUnsafe(PROBE_HEAD_BYTES);
    let headLen = 0;
    // undefined = not classified yet, true = discard the rest of this line.
    let skipping: boolean | undefined = reader.skip ? undefined : false;
    let chunks = 0;
    let stopped = false;

    const classify = (): boolean | undefined => {
      if (skipping !== undefined || !reader.skip) return skipping;
      skipping = reader.skip(head.toString('utf8', 0, headLen));
      if (skipping) {
        pieces = [];
        piecesLen = 0;
      }
      return skipping;
    };

    const resetLine = (): void => {
      pieces = [];
      piecesLen = 0;
      headLen = 0;
      skipping = reader.skip ? undefined : false;
    };

    /** Take bytes [from, to) of `buf` into the line being assembled. */
    const addSegment = (buf: Buffer, from: number, to: number): void => {
      if (skipping === true || to <= from) return;
      if (headLen < PROBE_HEAD_BYTES) {
        const n = Math.min(PROBE_HEAD_BYTES - headLen, to - from);
        buf.copy(head, headLen, from, from + n);
        headLen += n;
        if (headLen >= PROBE_HEAD_BYTES && classify() === true) return;
      }
      pieces.push(Buffer.from(buf.subarray(from, to)));
      piecesLen += to - from;
    };

    /** Complete the current line and hand it over (unless it was claimed). */
    const finishLine = (): void => {
      classify();
      if (!skipping && piecesLen > 0) {
        const line = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, piecesLen);
        if (reader.line(line.toString('utf8')) === false) stopped = true;
      }
      resetLine();
    };

    for (;;) {
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      // Yield periodically so a 60 MB transcript cannot pin the loop.
      if (++chunks % 32 === 0) await yieldToEventLoop();
      const view = buffer.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = view.indexOf(NEWLINE, start);
        if (nl === -1) break;
        if (pieces.length === 0 && headLen === 0) {
          // Fast path: the whole line is in this chunk, so it can be classified
          // and decoded in place -- no copy, no per-chunk decode.
          if (reader.skip) {
            const headEnd = Math.min(nl, start + PROBE_HEAD_BYTES);
            skipping = reader.skip(view.toString('utf8', start, headEnd));
          }
          if (!skipping && nl > start) {
            if (reader.line(view.toString('utf8', start, nl)) === false) stopped = true;
          }
          resetLine();
        } else {
          addSegment(view, start, nl);
          finishLine();
        }
        if (stopped) return true;
        start = nl + 1;
      }
      if (start < bytesRead) addSegment(view, start, bytesRead);
    }
    // Trailing line with no final newline.
    if (piecesLen > 0 || headLen > 0) finishLine();
  } finally {
    releaseBuffer(buffer);
    await fh.close();
  }
  return true;
}

/** `JSON.parse` a line, tolerating a malformed one (pi skips those too). */
function parseLine(line: string, maxBytes = Infinity): any | null {
  if (line.length > maxBytes) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Decode a bounded prefix of the first JSON string value found after `"text":`
 * or `"content":` in a line HEAD. Used only for the listing preview of a
 * message too large to parse, so a pasted-1000-page first message still shows a
 * sensible snippet instead of nothing. Stops at the first unescaped quote or
 * `maxChars` decoded characters, whichever comes first.
 */
function probeTextPrefix(head: string, maxChars = 400): string {
  const at = (() => {
    const t = head.indexOf('"text":"');
    if (t !== -1) return t + 8;
    const c = head.indexOf('"content":"');
    return c === -1 ? -1 : c + 11;
  })();
  if (at === -1) return '';
  let out = '';
  for (let i = at; i < head.length && out.length < maxChars; i++) {
    const ch = head[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const esc = head[++i];
    if (esc === 'n') out += '\n';
    else if (esc === 't') out += '\t';
    else if (esc === 'r') out += '\r';
    else if (esc === 'u') {
      const code = parseInt(head.slice(i + 1, i + 5), 16);
      if (Number.isFinite(code)) out += String.fromCharCode(code);
      i += 4;
    } else if (esc !== undefined) out += esc;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cheap structural probes
// ---------------------------------------------------------------------------
//
// pi writes each entry with `type` FIRST and, for a message entry, the fixed
// header keys (`id`, `parentId`, `timestamp`) before the `message` object:
//
//   {"type":"message","id":"..","parentId":"..","timestamp":"..","message":{"role":"..
//
// So the FIRST occurrence of these patterns in a line is always the structural
// one (everything before it is fixed, simple values), even if the payload text
// happens to contain the same bytes later. That lets us classify a line, and
// skip parsing it, without trusting user content. Probes only ever look at a
// bounded HEAD of the line, so a 30 MB tool result costs a slice, not a parse.

const TYPE_PROBE = /^\{"type":"([a-zA-Z_]+)"/;
const TIMESTAMP_PROBE = /"timestamp":"([^"]{1,64})"/;
const ROLE_PROBE = /"message":\{"role":"([a-zA-Z]+)"/;

function lineType(head: string): string | null {
  const m = TYPE_PROBE.exec(head);
  return m ? m[1] : null;
}

/**
 * Role of a `message` entry, from the structural probe. Returns null when the
 * head does not contain the `message.role` pair (unexpected shape), in which
 * case the caller must fall back to a real parse.
 */
function messageRole(head: string): string | null {
  const m = ROLE_PROBE.exec(head);
  return m ? m[1] : null;
}

export interface SessionHeader {
  id: string;
  cwd: string;
  timestamp?: string;
  parentSession?: string;
}

/**
 * Read ONLY the header (first line) of a session `.jsonl`. Costs one 8 KB read
 * regardless of file size. Returns null when the file is missing, empty, or
 * does not start with a `session` header.
 */
export async function readSessionHeader(filePath: string): Promise<SessionHeader | null> {
  try {
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const text = buf.toString('utf8', 0, bytesRead);
      const nl = text.indexOf('\n');
      // No newline in the first 8 KB means the first line is not a header
      // (a session header is a few hundred bytes).
      if (nl === -1 && bytesRead === buf.length) return null;
      const firstLine = nl === -1 ? text : text.slice(0, nl);
      const header = JSON.parse(firstLine);
      if (header?.type !== 'session') return null;
      return {
        id: typeof header.id === 'string' ? header.id : '',
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        timestamp: typeof header.timestamp === 'string' ? header.timestamp : undefined,
        parentSession:
          typeof header.parentSession === 'string' && header.parentSession
            ? header.parentSession
            : undefined,
      };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listing info (the /sessions scan)
// ---------------------------------------------------------------------------

export interface DiskSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  /** Parent session path from the header (`parentSession`), if forked. */
  parentSessionPath?: string;
}

/**
 * Extract the text a listing preview would show from a message payload, using
 * the same rules as the old whole-file parser: a string content, or the
 * concatenation of its parts' `text` fields.
 */
function listingText(message: any): string {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

/**
 * Build the listing record for ONE session file in a single streaming pass.
 *
 * Replaces the old `parseDiskSessionInfo(content)`, which needed the whole file
 * as a string AND every line parsed into a retained array. Semantics are
 * preserved exactly, including the subtle ones:
 *  - `messageCount` counts EVERY `message` entry (any role);
 *  - `modified` is the newest timestamp among user/assistant messages that
 *    actually carry text (never a tool result), falling back to the file mtime;
 *  - `firstMessage` is the first USER message's text, capped to a preview;
 *  - `name` is the LAST `session_info` name seen.
 *
 * Lines that cannot affect any of those (tool results, thinking-level changes,
 * ...) are classified by a bounded probe and never parsed, which is what keeps a
 * 62 MB transcript to a few MB of transient allocation.
 */
export async function readSessionListingInfo(
  filePath: string,
  mtime: Date,
): Promise<DiskSessionInfo | null> {
  let header: any = null;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = '';
  let lastMessageTime = 0;
  let sawHeaderLine = false;
  /** Head of the line currently being handed to `line()` (set by `skip`). */
  let currentHead = '';
  /** Whether `skip` already counted the current line as a message. */
  let countedCurrent = false;

  const ok = await forEachJsonlLine(filePath, {
    skip: (head) => {
      currentHead = head;
      countedCurrent = false;
      if (!head.trim()) return true;
      if (!sawHeaderLine) return false; // the header is always read

      const type = lineType(head);
      // Unclassifiable head (a shape this probe does not know: a different key
      // order from another pi version, a truncated line): NEVER skip on a guess.
      // Read it and let the parse decide, which is the old whole-file behaviour.
      if (type === null) return false;
      if (type === 'session_info') return false;
      if (type !== 'message') return true; // model changes etc: nothing to learn

      // From here the line IS a message, so it counts -- whether or not we go on
      // to read it. Counting here is what lets the body be discarded. NOTE: this
      // counts a TRUNCATED trailing message entry (a session killed mid-write)
      // that the old whole-file parser dropped because `JSON.parse` threw. The
      // message is really there and only its tail is missing, so counting it is
      // if anything more accurate; it moves one number in the sidebar, for
      // corrupt files only.
      messageCount++;
      countedCurrent = true;

      // Only user/assistant messages carrying text can move `modified` or supply
      // the first-message preview. Every other role (toolResult, bashExecution)
      // is pure weight for the listing, and tool results (file reads, bash
      // output, base64 images) are most of a transcript's bytes.
      const role = messageRole(head);
      if (role !== null && role !== 'user' && role !== 'assistant') return true;
      // User/assistant messages ARE parsed: "does it carry text" cannot be
      // answered from a bounded head (a thinking block can push the text block
      // past it), and `modified` -- which orders the whole sidebar -- depends on
      // that answer. They are also the small ones; the bytes are in what we just
      // skipped.
      return false;
    },
    line: (line) => {
      const head = currentHead;

      if (!sawHeaderLine) {
        sawHeaderLine = true;
        // The header is the first parseable entry and must be a `session` entry;
        // anything else means this is not a pi session file. Parsed WITHOUT the
        // listing cap: a header is a few hundred bytes, and capping it could only
        // ever turn a readable session into an invisible one.
        header = parseLine(line);
        if (header?.type !== 'session') {
          header = null;
          return false;
        }
        return;
      }

      // Dispatch on the PARSED type, never on the probe: the probe is an
      // optimization for deciding what to read, the parse is the truth.
      const entry = parseLine(line, MAX_LISTING_PARSE_BYTES);
      if (entry?.type === 'session_info') {
        name = (entry.name && String(entry.name).trim()) || undefined;
        return;
      }
      if (!entry) {
        // Too large (or malformed) to parse: keep what the probes can tell us
        // rather than losing the session's preview and modified time entirely.
        if (messageRole(head) === 'user' && !firstMessage) {
          const probed = probeTextPrefix(head);
          if (probed) firstMessage = previewText(probed);
        }
        const tm = TIMESTAMP_PROBE.exec(head);
        const probedTime = tm ? new Date(tm[1]).getTime() : NaN;
        if (Number.isFinite(probedTime)) lastMessageTime = Math.max(lastMessageTime, probedTime);
        return;
      }
      if (entry.type !== 'message') return;
      // A message the probe could not classify (unknown key order) was not
      // counted in `skip`; count it here so the total never depends on the
      // probe recognising the shape.
      if (!countedCurrent) messageCount++;
      const message = entry.message;
      const role = message?.role;
      if (role !== 'user' && role !== 'assistant') return;
      const textContent = listingText(message);
      if (!textContent) return;
      if (!firstMessage && role === 'user') firstMessage = previewText(textContent);
      const t = typeof entry.timestamp === 'string' ? new Date(entry.timestamp).getTime() : NaN;
      if (Number.isFinite(t)) lastMessageTime = Math.max(lastMessageTime, t);
    },
  });

  if (!ok || !header) return null;

  const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
  const created = Number.isFinite(headerTime) ? new Date(headerTime) : new Date(NaN);
  const modified = lastMessageTime > 0 ? new Date(lastMessageTime) : mtime;
  const parentSessionPath =
    typeof header.parentSession === 'string' && header.parentSession ? header.parentSession : undefined;

  return {
    path: filePath,
    id: typeof header.id === 'string' ? header.id : '',
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    name,
    created,
    modified,
    messageCount,
    // Store the CAPPED preview, never the raw first message: the cache holds one
    // entry per session on disk, so keeping full first messages (pasted PRDs,
    // specs) resident would cost megabytes of heap for no benefit.
    firstMessage: firstMessage || '(no messages)',
    ...(parentSessionPath ? { parentSessionPath } : {}),
  };
}

// ---------------------------------------------------------------------------
// History (what a client actually reads)
// ---------------------------------------------------------------------------

/** Text of a user/assistant message, as the UI and the fork prefill use it. */
export function extractMessageText(msg: any): string {
  if (msg?.role === 'user' || msg?.role === 'assistant') {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
    }
  }
  return '';
}

/**
 * Map ONE session entry to the UI-facing history messages it produces (0..N).
 * Pure, so the streaming reader and any caller with entries already in memory
 * produce byte-identical history.
 */
export function mapEntryToHistory(entry: SessionEntry): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  if (entry.type !== 'message') return out;

  const msgEntry = entry as SessionMessageEntry;
  const msg: any = msgEntry.message;
  const ts = Date.parse(msgEntry.timestamp);

  if (msg.role === 'user') {
    const content = extractMessageText(msg);
    if (content) {
      // Carry the source entry id so the client can "Fork from here"
      // (fork BEFORE this user entry, pi's default position:'before').
      const entryId = typeof msgEntry.id === 'string' ? msgEntry.id : undefined;
      out.push({ role: 'user', content, timestamp: ts, ...(entryId ? { entryId } : {}) });
    }
  } else if (msg.role === 'assistant') {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'thinking') {
          const thinking = (block as any).thinking || '';
          if (thinking) out.push({ role: 'thinking', content: thinking, timestamp: ts });
        } else if (block.type === 'text') {
          const text = (block as any).text || '';
          if (text) out.push({ role: 'assistant', content: text, timestamp: ts });
        } else if (block.type === 'toolCall') {
          const tc = block as any;
          const toolName = tc.name || tc.toolName || 'unknown';
          const rawArgs = tc.arguments || tc.args;
          const args = rawArgs ? JSON.stringify(rawArgs) : '';
          const toolCallId = typeof tc.id === 'string' ? tc.id : undefined;
          out.push({
            role: 'tool_call',
            content: args,
            timestamp: ts,
            toolName,
            ...(toolCallId ? { toolCallId } : {}),
          });
        }
      }
    } else if (typeof content === 'string' && content) {
      out.push({ role: 'assistant', content, timestamp: ts });
    }
  } else if (msg.role === 'toolResult') {
    const resultMsg = msg as any;
    const toolName = resultMsg.toolName || 'unknown';
    let resultText = '';
    const resultImages: { mimeType: string; data: string }[] = [];
    if (Array.isArray(resultMsg.content)) {
      resultText = resultMsg.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text || '')
        .join('\n');
      // Pull image blocks (e.g. `read` on an image file) so reloaded history
      // renders them inline, mirroring live tool_end.
      for (const c of resultMsg.content) {
        if (c && c.type === 'image' && typeof c.data === 'string' && c.data) {
          resultImages.push({
            mimeType: typeof c.mimeType === 'string' ? c.mimeType : 'image/png',
            data: c.data,
          });
        }
      }
    } else if (typeof resultMsg.content === 'string') {
      resultText = resultMsg.content;
    }
    const toolCallId = typeof resultMsg.toolCallId === 'string' ? resultMsg.toolCallId : undefined;
    // The entry id addresses an image sent by reference (history-images.ts):
    // unlike a toolCallId, which a provider may reuse, it is unique in the file.
    const entryId = resultImages.length > 0 && typeof msgEntry.id === 'string' ? msgEntry.id : undefined;
    out.push({
      role: 'tool_result',
      content: resultText,
      timestamp: ts,
      toolName,
      isError: !!resultMsg.isError,
      ...(toolCallId ? { toolCallId } : {}),
      ...(entryId ? { entryId } : {}),
      ...(resultImages.length > 0 ? { images: resultImages } : {}),
    });
  } else if (msg.role === 'bashExecution') {
    const bashMsg = msg as any;
    out.push({
      role: 'tool_call',
      content: bashMsg.command || '',
      timestamp: ts,
      toolName: 'bash',
      // A bashExecution entry is, by definition, a user `!command` (force
      // command), never an agent tool call. Mark it so the web can auto-expand
      // it on reload, mirroring the live tool_start flag.
      forceCommand: true,
    });
    if (bashMsg.output) {
      out.push({
        role: 'tool_result',
        content: bashMsg.output,
        timestamp: ts,
        toolName: 'bash',
        isError: bashMsg.exitCode !== undefined && bashMsg.exitCode !== 0,
      });
    }
  }
  return out;
}

const TOOL_CALL_ID_PROBE = /"toolCallId":"((?:[^"\\]|\\.){1,256})"/;
const ENTRY_ID_PROBE = /^\{"type":"message","id":"((?:[^"\\]|\\.){1,256})"/;

/** True when the probe matched a JSON string that is NOT `expected`. A probe
 *  miss, or an unparseable capture, is "unknown": the line must be read. */
function probedOther(re: RegExp, head: string, expected: string): boolean {
  const m = re.exec(head);
  if (m === null) return false;
  try {
    return JSON.parse(`"${m[1]}"`) !== expected;
  } catch {
    return false;
  }
}

/**
 * The `index`-th image block of the tool result answering `toolCallId` (and, when
 * given, stored in entry `entryId`), or null. Serves `GET /session/tool-image`:
 * history sent to a slow-link-aware client references large tool images instead
 * of inlining their base64 (see `stripHistoryImages` in history-images.ts), and
 * the web fetches each one on demand. The entry id is what makes the address
 * unique: a provider may reuse tool-call ids across turns.
 *
 * One streaming pass; only tool-result lines whose head names THESE ids (or does
 * not show them at all, an unexpected shape we must not guess about) are
 * assembled and parsed, so every other multi-MB result costs a head probe.
 */
export async function readToolResultImage(
  filePath: string,
  address: { toolCallId: string; entryId?: string },
  index: number,
): Promise<{ mimeType: string; data: string } | null> {
  const { toolCallId, entryId } = address;
  let found: { mimeType: string; data: string } | null = null;
  await forEachJsonlLine(filePath, {
    skip: (head) => {
      if (lineType(head) !== 'message') return true;
      const role = messageRole(head);
      if (role !== null && role !== 'toolResult') return true;
      if (entryId !== undefined && probedOther(ENTRY_ID_PROBE, head, entryId)) return true;
      return probedOther(TOOL_CALL_ID_PROBE, head, toolCallId);
    },
    line: (line) => {
      const entry = parseLine(line);
      const msg = entry?.type === 'message' ? entry.message : null;
      if (!msg || msg.role !== 'toolResult' || msg.toolCallId !== toolCallId) return;
      if (entryId !== undefined && entry.id !== entryId) return;
      const images = Array.isArray(msg.content)
        ? msg.content.filter((c: any) => c && c.type === 'image' && typeof c.data === 'string' && c.data)
        : [];
      const img = images[index];
      if (img) {
        found = {
          mimeType: typeof img.mimeType === 'string' ? img.mimeType : 'image/png',
          data: flattenString(img.data),
        };
      }
      return false;
    },
  });
  return found;
}

export interface HistoryWindow {
  messages: HistoryMessage[];
  totalCount: number;
  offset: number;
}

export interface TranscriptWindow extends HistoryWindow {
  /** Session header, or null when the file has none (not a pi session). */
  header: SessionHeader | null;
  /** "provider:modelId" from the LAST `model_change` entry, '' when none. */
  model: string;
}

/**
 * One streaming pass over a transcript, materializing ONLY the history messages
 * whose index falls in [`keepFrom`, `keepUntil`).
 *
 * BOTH bounds matter. `keepFrom` is what lets a `toolResult` behind the window
 * be COUNTED from its head and its (often multi-megabyte) body discarded without
 * ever being assembled or parsed -- it always maps to exactly one history
 * message, so counting it needs nothing else. `keepUntil` stops the read as soon
 * as the window is full: without it a "load older" page (`beforeOffset` near the
 * START of a big transcript) would materialize everything from there to EOF and
 * throw most of it away, which is the very failure this module exists to remove.
 * Measured on a 60 MB transcript, a `beforeOffset=5` page went from an 87 MB
 * transient peak to the same ~16 MB as a tail read.
 *
 * Every entry that is not a behind-the-window tool result is read: how many
 * messages it maps to depends on its content.
 */
async function scanTranscript(
  filePath: string,
  keepFrom: number,
  keepUntil = Number.POSITIVE_INFINITY,
): Promise<{ header: SessionHeader | null; model: string; total: number; messages: HistoryMessage[] }> {
  let header: SessionHeader | null = null;
  let model = '';
  let total = 0;
  const messages: HistoryMessage[] = [];
  let sawHeaderLine = false;

  await forEachJsonlLine(filePath, {
    skip: (head) => {
      if (!head.trim()) return true;
      if (!sawHeaderLine) return false; // the header is always read
      const type = lineType(head);
      // Unclassifiable head: read it rather than guess. Skipping on a guess here
      // would silently drop a message from the history a client is reading.
      if (type === null) return false;
      if (type === 'model_change') return false;
      if (type !== 'message') return true; // contributes no history message
      // Exactly one message, and it is behind the window: count and drop it.
      if (messageRole(head) === 'toolResult' && total < keepFrom) {
        total++;
        return true;
      }
      return false;
    },
    line: (line) => {
      if (!sawHeaderLine) {
        sawHeaderLine = true;
        const parsed = parseLine(line);
        if (parsed?.type !== 'session') return false;
        header = {
          id: typeof parsed.id === 'string' ? parsed.id : '',
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
          timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
          parentSession:
            typeof parsed.parentSession === 'string' && parsed.parentSession
              ? parsed.parentSession
              : undefined,
        };
        return;
      }

      // Parsed WITHOUT a size cap: unlike the listing, here the content IS the
      // answer, and refusing a big line would silently drop a message from the
      // transcript the client is reading. Memory stays bounded because the parse
      // is transient -- only messages at/after `keepFrom` survive the loop.
      const entry = parseLine(line);
      if (!entry) return;
      if (entry.type === 'model_change') {
        if ('provider' in entry && 'modelId' in entry) {
          model = `${entry.provider}:${entry.modelId}`;
        }
        return;
      }
      if (entry.type !== 'message') return;
      for (const m of mapEntryToHistory(entry as SessionEntry)) {
        if (total >= keepFrom && total < keepUntil) messages.push(m);
        total++;
      }
      // Window full: stop reading. The caller that set `keepUntil` already knows
      // the total (it comes from the counting pass), so there is nothing left to
      // learn from the rest of the file.
      if (total >= keepUntil) return false;
    },
  });

  return { header, model, total, messages };
}

/**
 * Read a session transcript and return ONE window of history.
 *
 * Windowing matches the old in-memory `all.slice()` exactly:
 *  - no `beforeOffset`: the LAST `limit` messages, `offset = totalCount - limit`;
 *  - with `beforeOffset`: the `limit` messages ending just before it, clamped to
 *    the real total.
 *
 * Done as TWO bounded passes rather than one. Pass 1 reads the WHOLE file and
 * materializes nothing (every tool result is behind the window by construction),
 * which is what makes `header`, `model` -- the LAST `model_change`, so only a
 * full pass can know it -- and `totalCount` authoritative. Pass 2 then reads only
 * as far as the window and materializes only the window itself. Both read from
 * the page cache and neither ever holds more than the window, which is what a
 * "give me 60 messages" request is allowed to cost on a 60 MB transcript. The
 * old path built a `HistoryMessage` for EVERY entry -- base64 tool images
 * included -- and threw all but 60 away, three whole-file loads deep (two of
 * them inside `SessionManager.open`).
 *
 * Everything except `messages` therefore comes from pass 1, deliberately: pass 2
 * stops early, so its own header/model/total would be partial. An append landing
 * between the passes cannot corrupt the answer either -- entries before the
 * append keep their indices, so the window pass 2 reads is exactly the window
 * pass 1 measured, and the reported total/offset describe that same snapshot.
 */
export async function readTranscriptWindow(
  filePath: string,
  limit: number,
  beforeOffset?: number,
): Promise<TranscriptWindow> {
  // Pass 1: count only.
  const counted = await scanTranscript(filePath, Number.POSITIVE_INFINITY);
  const totalCount = counted.total;

  if (limit <= 0 || totalCount === 0) {
    const end = beforeOffset ?? totalCount;
    return {
      header: counted.header,
      model: counted.model,
      messages: [],
      totalCount,
      offset: Math.max(0, Math.min(end, totalCount)),
    };
  }

  const end =
    beforeOffset === undefined ? totalCount : Math.max(0, Math.min(beforeOffset, totalCount));
  const start = Math.max(0, end - limit);

  // Pass 2: materialize the window, and nothing outside it.
  const read = await scanTranscript(filePath, start, end);
  return {
    header: counted.header,
    model: counted.model,
    messages: read.messages,
    totalCount,
    offset: start,
  };
}
