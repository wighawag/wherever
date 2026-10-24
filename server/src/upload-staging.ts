/**
 * Server-side staging for RESUMABLE, CHUNKED uploads (docs/adr/0012).
 *
 * One server-owned directory, `getWhereverStateDir()/upload-staging/`, holds every
 * in-flight upload as two entries keyed by the client-generated `uploadId`:
 *
 *   - `<uploadId>`       the partial file; its SIZE is the acknowledged offset;
 *   - `<uploadId>.json`  the sidecar (`UploadSidecar`), the durable record of what
 *                        the upload is (`sessionId`, `filename`, `size`), where it
 *                        goes (`targetDir`, resolved ONCE at begin) and, once
 *                        finished, where it went (`done`, `savedPath`).
 *
 * The sidecar is what makes completion idempotent across a lost reply or a server
 * restart: a repeated begin or finish of a finished id answers with the recorded
 * `savedPath` instead of writing a second copy.
 *
 * Every operation on one `uploadId` runs through a per-id SERIAL QUEUE, and the
 * `offset === currentOffset` check of a chunk runs INSIDE it, so two sockets
 * racing chunks for the same id (a resumed upload whose old socket is still
 * flushing) can never interleave writes or both be accepted for one offset.
 *
 * This module knows nothing about WebSockets, sessions or the write gate: the
 * caller passes an `authorize(sidecar)` callback that runs inside the queue, so a
 * gate verdict is taken against the sidecar the write will actually use.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Wire capability advertised in `connected.capabilities`. */
export const UPLOAD_CAPABILITY = 'upload.v1';

/** Hard cap on one chunk's payload. Small enough that heartbeat frames interleave. */
export const UPLOAD_CHUNK_MAX_BYTES = 1024 * 1024;

/** Staging entries untouched for this long are garbage-collected. */
export const UPLOAD_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** First byte of a binary chunk frame. */
export const CHUNK_FRAME_KIND = 1;
/** Second byte of a binary chunk frame. */
export const CHUNK_FRAME_VERSION = 1;

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** A client-generated upload id: URL-safe, 22..64 chars (>= 128 random bits base64url). */
export function isValidUploadId(id: unknown): id is string {
  return typeof id === 'string' && UPLOAD_ID_RE.test(id);
}

export interface UploadSidecar {
  uploadId: string;
  sessionId: string;
  filename: string;
  size: number;
  mime?: string;
  /** Absolute target folder, resolved once at begin from the painted cwd. */
  targetDir: string;
  createdAt: number;
  /** True once the file has been moved to `savedPath`. */
  done?: boolean;
  /**
   * The final path. Written BEFORE the move (with `done` unset), so a crash
   * between the move and recording `done` is completed by the next finish rather
   * than producing a second, differently-named copy.
   */
  savedPath?: string;
}

export type ParsedChunkFrame =
  | { ok: true; uploadId: string; offset: number; payload: Buffer }
  | { ok: false; uploadId: string; error: string };

/**
 * Parse `[u8 kind=1][u8 version=1][u8 idLen][uploadId ascii][u64 offset BE][payload]`.
 * `uploadId` is returned whenever it could be read, so the refusal can be routed.
 */
export function parseChunkFrame(buf: Buffer): ParsedChunkFrame {
  if (buf.length < 3) return { ok: false, uploadId: '', error: 'Malformed upload chunk (too short).' };
  if (buf[0] !== CHUNK_FRAME_KIND) return { ok: false, uploadId: '', error: 'Unknown binary frame kind.' };
  if (buf[1] !== CHUNK_FRAME_VERSION) {
    return { ok: false, uploadId: '', error: `Unsupported upload chunk version ${buf[1]}.` };
  }
  const idLen = buf[2];
  const headerLen = 3 + idLen + 8;
  if (buf.length < headerLen) return { ok: false, uploadId: '', error: 'Malformed upload chunk (truncated header).' };
  const uploadId = buf.subarray(3, 3 + idLen).toString('latin1');
  if (!isValidUploadId(uploadId)) return { ok: false, uploadId: '', error: 'Invalid uploadId.' };
  const big = buf.readBigUInt64BE(3 + idLen);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, uploadId, error: 'Invalid chunk offset.' };
  const payload = buf.subarray(headerLen);
  if (payload.length > UPLOAD_CHUNK_MAX_BYTES) {
    return {
      ok: false,
      uploadId,
      error: `Upload chunk too large (${payload.length} bytes, the limit is ${UPLOAD_CHUNK_MAX_BYTES} bytes).`,
    };
  }
  return { ok: true, uploadId, offset: Number(big), payload };
}

/** Build a chunk frame (used by tests and as the reference encoder). */
export function encodeChunkFrame(uploadId: string, offset: number, payload: Uint8Array): Buffer {
  const id = Buffer.from(uploadId, 'latin1');
  const head = Buffer.alloc(3 + id.length + 8);
  head[0] = CHUNK_FRAME_KIND;
  head[1] = CHUNK_FRAME_VERSION;
  head[2] = id.length;
  id.copy(head, 3);
  head.writeBigUInt64BE(BigInt(offset), 3 + id.length);
  return Buffer.concat([head, Buffer.from(payload)]);
}

/** Answer of begin / chunk: the server's offset. */
export type OffsetResult =
  | { ok: true; offset: number; size: number; sessionId: string; done?: boolean; savedPath?: string; accepted?: boolean }
  | { ok: false; error: string; sessionId: string };

export type FinishResult =
  | { ok: true; savedPath: string; filename: string; sessionId: string }
  | { ok: false; error: string; sessionId: string };

/** Returns a refusal reason, or null when the operation may proceed. */
export type Authorize = (sidecar: UploadSidecar) => string | null;

export interface UploadStagingOptions {
  /** The staging directory (`<state dir>/upload-staging`). Created lazily. */
  dir: string;
  /** Injectable for the EXDEV test. Defaults to `fs.promises.rename`. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Injectable clock. */
  now?: () => number;
  maxAgeMs?: number;
}

export interface BeginRequest {
  uploadId: string;
  sessionId: string;
  filename: string;
  size: number;
  mime?: string;
  /** Resolved only for a NEW id; a known id keeps its recorded target. */
  targetDir: () => string;
}

export class UploadStaging {
  readonly dir: string;
  private readonly renameFn: (from: string, to: string) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: UploadStagingOptions) {
    this.dir = path.resolve(opts.dir);
    this.renameFn = opts.rename ?? ((a, b) => fsp.rename(a, b));
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? UPLOAD_STAGING_MAX_AGE_MS;
  }

  partialPath(uploadId: string): string {
    return path.join(this.dir, uploadId);
  }

  sidecarPath(uploadId: string): string {
    return path.join(this.dir, `${uploadId}.json`);
  }

  /** Run `fn` after every earlier operation on `uploadId` has settled. */
  private enqueue<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(uploadId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.queues.set(uploadId, tail);
    tail.then(() => {
      if (this.queues.get(uploadId) === tail) this.queues.delete(uploadId);
    });
    return run;
  }

  async readSidecar(uploadId: string): Promise<UploadSidecar | null> {
    try {
      const raw = await fsp.readFile(this.sidecarPath(uploadId), 'utf8');
      const s = JSON.parse(raw) as UploadSidecar;
      return s && typeof s === 'object' && s.uploadId === uploadId ? s : null;
    } catch {
      return null;
    }
  }

  private async writeSidecar(s: UploadSidecar): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${this.sidecarPath(s.uploadId)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(s));
    await fsp.rename(tmp, this.sidecarPath(s.uploadId));
  }

  private async partialSize(uploadId: string): Promise<number | null> {
    try {
      return (await fsp.stat(this.partialPath(uploadId))).size;
    } catch {
      return null;
    }
  }

  /**
   * Start or resume an upload. Idempotent: a known id must match the sidecar's
   * `sessionId`, `size` and `filename`, and answers with the bytes already
   * staged; a finished id answers `{ offset: size, done: true, savedPath }`.
   */
  begin(req: BeginRequest, authorize?: Authorize): Promise<OffsetResult> {
    return this.enqueue(req.uploadId, async () => {
      const existing = await this.readSidecar(req.uploadId);
      if (existing) {
        if (existing.sessionId !== req.sessionId) {
          return { ok: false, sessionId: req.sessionId, error: 'This upload id belongs to a different session.' };
        }
        if (existing.size !== req.size || existing.filename !== req.filename) {
          return {
            ok: false,
            sessionId: req.sessionId,
            error: 'This upload id is already in use for a different file.',
          };
        }
        const refused = authorize?.(existing);
        if (refused) return { ok: false, sessionId: existing.sessionId, error: refused };
        if (existing.done && existing.savedPath) {
          return { ok: true, offset: existing.size, size: existing.size, sessionId: existing.sessionId, done: true, savedPath: existing.savedPath };
        }
        let offset = await this.partialSize(req.uploadId);
        if (offset === null) {
          await fsp.writeFile(this.partialPath(req.uploadId), Buffer.alloc(0));
          offset = 0;
        }
        return { ok: true, offset, size: existing.size, sessionId: existing.sessionId };
      }
      const sidecar: UploadSidecar = {
        uploadId: req.uploadId,
        sessionId: req.sessionId,
        filename: req.filename,
        size: req.size,
        ...(req.mime ? { mime: req.mime } : {}),
        targetDir: '',
        createdAt: this.now(),
      };
      const refused = authorize?.(sidecar);
      if (refused) return { ok: false, sessionId: req.sessionId, error: refused };
      sidecar.targetDir = path.resolve(req.targetDir());
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(this.partialPath(req.uploadId), Buffer.alloc(0));
      await this.writeSidecar(sidecar);
      return { ok: true, offset: 0, size: req.size, sessionId: req.sessionId };
    });
  }

  /**
   * Write one chunk at `offset`. Accepted only when `offset` equals the bytes
   * already staged (checked inside the serial queue); otherwise answers with the
   * true offset and `accepted: false`, which is how a client realigns.
   */
  writeChunk(uploadId: string, offset: number, payload: Buffer, authorize?: Authorize): Promise<OffsetResult> {
    return this.enqueue(uploadId, async () => {
      const s = await this.readSidecar(uploadId);
      if (!s) return { ok: false, sessionId: '', error: 'Unknown upload (send upload_begin first).' };
      const refused = authorize?.(s);
      if (refused) return { ok: false, sessionId: s.sessionId, error: refused };
      if (s.done) {
        return { ok: true, offset: s.size, size: s.size, sessionId: s.sessionId, done: true, savedPath: s.savedPath, accepted: false };
      }
      const current = await this.partialSize(uploadId);
      if (current === null) return { ok: false, sessionId: s.sessionId, error: 'Upload partial is missing (send upload_begin again).' };
      if (offset !== current) {
        return { ok: true, offset: current, size: s.size, sessionId: s.sessionId, accepted: false };
      }
      if (current + payload.length > s.size) {
        return {
          ok: false,
          sessionId: s.sessionId,
          error: `Upload chunk overruns the declared size (${current + payload.length} > ${s.size} bytes).`,
        };
      }
      const fh = await fsp.open(this.partialPath(uploadId), 'r+');
      try {
        if (payload.length > 0) await fh.write(payload, 0, payload.length, current);
      } finally {
        await fh.close();
      }
      return { ok: true, offset: current + payload.length, size: s.size, sessionId: s.sessionId, accepted: true };
    });
  }

  /**
   * Move a complete upload into its target dir and record it. Repeated finishes
   * (lost reply, restart) return the same `savedPath`.
   *
   * Decision (recorded at the choice site): a finish before every byte is staged
   * is a refusal (`ok: false` with the staged/declared counts), not an
   * `upload_offset` realign. A conforming client only finishes after its last
   * ack reached `size`, so this is a client bug, and answering with an offset
   * would let a buggy client loop silently. The alternative (reply with the true
   * offset so the client resends) was considered and rejected for that reason.
   */
  finish(uploadId: string, sessionId: string, authorize?: Authorize, nameFor?: (filename: string) => string): Promise<FinishResult> {
    return this.enqueue(uploadId, async () => {
      const s = await this.readSidecar(uploadId);
      if (!s) return { ok: false, sessionId, error: 'Unknown upload (send upload_begin first).' };
      if (s.sessionId !== sessionId) {
        return { ok: false, sessionId, error: 'This upload id belongs to a different session.' };
      }
      const refused = authorize?.(s);
      if (refused) return { ok: false, sessionId, error: refused };
      if (s.done && s.savedPath) return { ok: true, savedPath: s.savedPath, filename: s.filename, sessionId };

      const staged = await this.partialSize(uploadId);
      if (staged === null) {
        // A crash after the move but before `done` was recorded: the file is
        // already at the recorded path.
        if (s.savedPath && fs.existsSync(s.savedPath)) {
          await this.writeSidecar({ ...s, done: true });
          return { ok: true, savedPath: s.savedPath, filename: s.filename, sessionId };
        }
        return { ok: false, sessionId, error: 'Upload partial is missing (send upload_begin again).' };
      }
      if (staged !== s.size) {
        return { ok: false, sessionId, error: `Upload incomplete (${staged} of ${s.size} bytes received).` };
      }

      let savedPath = s.savedPath;
      if (!savedPath) {
        const name = nameFor ? nameFor(s.filename) : `${this.now()}_${path.basename(s.filename)}`;
        savedPath = path.join(s.targetDir, name);
        await this.writeSidecar({ ...s, savedPath });
      }
      await fsp.mkdir(path.dirname(savedPath), { recursive: true });
      await this.move(this.partialPath(uploadId), savedPath);
      await this.writeSidecar({ ...s, savedPath, done: true });
      return { ok: true, savedPath, filename: s.filename, sessionId };
    });
  }

  /** Rename, falling back to copy + unlink across filesystems (`EXDEV`). */
  private async move(from: string, to: string): Promise<void> {
    try {
      await this.renameFn(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
      await fsp.copyFile(from, to);
      await fsp.unlink(from);
    }
  }

  /**
   * Delete an unfinished upload's partial and sidecar. A finished id is left
   * alone (its sidecar keeps completion idempotent; the saved file is the
   * user's). Returns a refusal reason or null.
   */
  abort(uploadId: string, sessionId: string): Promise<string | null> {
    return this.enqueue(uploadId, async () => {
      const s = await this.readSidecar(uploadId);
      if (!s) {
        await fsp.rm(this.partialPath(uploadId), { force: true });
        return null;
      }
      if (s.sessionId !== sessionId) return 'This upload id belongs to a different session.';
      if (s.done) return null;
      await fsp.rm(this.partialPath(uploadId), { force: true });
      await fsp.rm(this.sidecarPath(uploadId), { force: true });
      return null;
    });
  }

  /**
   * Remove every staging entry (partial, sidecar, leftover `.tmp`) whose newest
   * mtime is older than `maxAgeMs`, skipping ids with a queued operation.
   * Returns the number of upload ids removed.
   */
  async gc(): Promise<number> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    const newest = new Map<string, number>();
    const files = new Map<string, string[]>();
    for (const name of names) {
      const id = name.split('.')[0];
      let mtime: number;
      try {
        mtime = (await fsp.stat(path.join(this.dir, name))).mtimeMs;
      } catch {
        continue;
      }
      newest.set(id, Math.max(newest.get(id) ?? 0, mtime));
      files.set(id, [...(files.get(id) ?? []), name]);
    }
    const cutoff = this.now() - this.maxAgeMs;
    let removed = 0;
    for (const [id, mtime] of newest) {
      if (mtime >= cutoff || this.queues.has(id)) continue;
      for (const name of files.get(id) ?? []) {
        await fsp.rm(path.join(this.dir, name), { force: true });
      }
      removed++;
    }
    return removed;
  }

  /** Is `p` (already resolved) the staging dir or inside it? Lexical and realpath. */
  contains(p: string): boolean {
    const dirs = new Set<string>([this.dir]);
    try {
      dirs.add(fs.realpathSync(this.dir));
    } catch {}
    const target = path.resolve(p);
    for (const d of dirs) {
      if (target === d || target.startsWith(d.endsWith(path.sep) ? d : d + path.sep)) return true;
    }
    return false;
  }
}
