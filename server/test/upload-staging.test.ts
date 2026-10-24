import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UploadStaging,
  encodeChunkFrame,
  isValidUploadId,
  parseChunkFrame,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_STAGING_MAX_AGE_MS,
} from '../src/upload-staging.js';

// In-process unit tests of the staging module (docs/adr/0012): the per-id serial
// queue, the EXDEV fallback (injectable rename), idempotent completion, GC, and
// the chunk frame codec. Everything lives under a throwaway temp dir.

const ID = 'AAAAAAAAAAAAAAAAAAAAAA'; // 22 chars
let root: string | undefined;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function setup(opts?: { rename?: (a: string, b: string) => Promise<void>; now?: () => number }) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-staging-unit-'));
  const target = path.join(root, 'target');
  const staging = new UploadStaging({ dir: path.join(root, 'upload-staging'), ...opts });
  return { staging, target };
}

function begin(staging: UploadStaging, target: string, size: number, extra?: Partial<{ sessionId: string; filename: string; uploadId: string }>) {
  return staging.begin({
    uploadId: extra?.uploadId ?? ID,
    sessionId: extra?.sessionId ?? 'sess-1',
    filename: extra?.filename ?? 'photo.jpg',
    size,
    targetDir: () => target,
  });
}

describe('upload staging module', () => {
  it('validates upload ids', () => {
    expect(isValidUploadId(ID)).toBe(true);
    expect(isValidUploadId('short')).toBe(false);
    expect(isValidUploadId('A'.repeat(65))).toBe(false);
    expect(isValidUploadId('../../etc/passwd-xxxxxxxxxxx')).toBe(false);
    expect(isValidUploadId(42)).toBe(false);
  });

  it('round-trips the chunk frame and refuses an oversized or malformed one', () => {
    const f = parseChunkFrame(encodeChunkFrame(ID, 1234, Buffer.from('abc')));
    expect(f).toEqual({ ok: true, uploadId: ID, offset: 1234, payload: Buffer.from('abc') });
    const big = parseChunkFrame(encodeChunkFrame(ID, 0, Buffer.alloc(UPLOAD_CHUNK_MAX_BYTES + 1)));
    expect(big.ok).toBe(false);
    expect(big.uploadId).toBe(ID);
    if (!big.ok) expect(big.error).toMatch(/too large/i);
    expect(parseChunkFrame(Buffer.from([2, 1, 0])).ok).toBe(false);
    const badVersion = encodeChunkFrame(ID, 0, Buffer.alloc(1));
    badVersion[1] = 9;
    expect(parseChunkFrame(badVersion).ok).toBe(false);
  });

  it('serialises concurrent chunks for one id: exactly one write wins each offset', async () => {
    const { staging, target } = setup();
    await begin(staging, target, 4);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => staging.writeChunk(ID, 0, Buffer.from([i, i, i, i]))),
    );
    const accepted = results.filter((r) => r.ok && r.accepted);
    expect(accepted).toHaveLength(1);
    for (const r of results) expect(r.ok && r.offset).toBe(4);
    const bytes = fs.readFileSync(staging.partialPath(ID));
    expect(bytes.length).toBe(4);
    expect(new Set(bytes).size).toBe(1); // one writer's bytes, never interleaved
  });

  it('answers an offset mismatch with the true offset and refuses an overrun', async () => {
    const { staging, target } = setup();
    await begin(staging, target, 6);
    expect(await staging.writeChunk(ID, 0, Buffer.from('abc'))).toMatchObject({ ok: true, offset: 3, accepted: true });
    expect(await staging.writeChunk(ID, 0, Buffer.from('abc'))).toMatchObject({ ok: true, offset: 3, accepted: false });
    expect(await staging.writeChunk(ID, 5, Buffer.from('x'))).toMatchObject({ ok: true, offset: 3, accepted: false });
    const over = await staging.writeChunk(ID, 3, Buffer.from('defg'));
    expect(over.ok).toBe(false);
  });

  it('a known id must match sessionId, size and filename', async () => {
    const { staging, target } = setup();
    await begin(staging, target, 3);
    expect(await begin(staging, target, 3)).toMatchObject({ ok: true, offset: 0 });
    expect((await begin(staging, target, 3, { sessionId: 'other' })).ok).toBe(false);
    expect((await begin(staging, target, 4)).ok).toBe(false);
    expect((await begin(staging, target, 3, { filename: 'other.jpg' })).ok).toBe(false);
  });

  it('finish moves into the target dir; a repeated finish (even a fresh instance) returns the same path', async () => {
    const { staging, target } = setup();
    await begin(staging, target, 3);
    await staging.writeChunk(ID, 0, Buffer.from('xyz'));
    const done = await staging.finish(ID, 'sess-1');
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(path.dirname(done.savedPath)).toBe(path.resolve(target));
    expect(path.basename(done.savedPath)).toMatch(/^\d+_photo\.jpg$/);
    expect(fs.readFileSync(done.savedPath, 'utf8')).toBe('xyz');
    expect(fs.existsSync(staging.partialPath(ID))).toBe(false);

    const again = new UploadStaging({ dir: staging.dir });
    expect(await again.finish(ID, 'sess-1')).toMatchObject({ ok: true, savedPath: done.savedPath });
    expect(await again.begin({ uploadId: ID, sessionId: 'sess-1', filename: 'photo.jpg', size: 3, targetDir: () => target })).toMatchObject({
      ok: true,
      offset: 3,
      done: true,
      savedPath: done.savedPath,
    });
    expect(fs.readdirSync(target)).toHaveLength(1);
  });

  it('refuses a finish before every byte is staged', async () => {
    const { staging, target } = setup();
    await begin(staging, target, 3);
    await staging.writeChunk(ID, 0, Buffer.from('x'));
    const r = await staging.finish(ID, 'sess-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/incomplete/i);
  });

  it('falls back to copy + unlink when rename fails with EXDEV', async () => {
    let calls = 0;
    const { staging, target } = setup({
      rename: async () => {
        calls++;
        const err = new Error('cross-device link') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      },
    });
    await begin(staging, target, 2);
    await staging.writeChunk(ID, 0, Buffer.from('ok'));
    const r = await staging.finish(ID, 'sess-1');
    expect(calls).toBe(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fs.readFileSync(r.savedPath, 'utf8')).toBe('ok');
    expect(fs.existsSync(staging.partialPath(ID))).toBe(false);
  });

  it('a non-EXDEV rename failure is surfaced, not swallowed', async () => {
    const { staging, target } = setup({
      rename: async () => {
        const err = new Error('nope') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    });
    await begin(staging, target, 1);
    await staging.writeChunk(ID, 0, Buffer.from('a'));
    await expect(staging.finish(ID, 'sess-1')).rejects.toThrow(/nope/);
  });

  it('abort deletes the partial; a later begin starts fresh', async () => {
    const { staging, target } = setup();
    await begin(staging, target, 3);
    await staging.writeChunk(ID, 0, Buffer.from('ab'));
    expect(await staging.abort(ID, 'other')).toMatch(/different session/);
    expect(await staging.abort(ID, 'sess-1')).toBeNull();
    expect(fs.existsSync(staging.partialPath(ID))).toBe(false);
    expect(fs.existsSync(staging.sidecarPath(ID))).toBe(false);
    expect(await begin(staging, target, 5)).toMatchObject({ ok: true, offset: 0 });
  });

  it('runs authorize inside the queue against the recorded sidecar', async () => {
    const { staging, target } = setup();
    await begin(staging, target, 3);
    const r = await staging.writeChunk(ID, 0, Buffer.from('abc'), (s) => (s.sessionId === 'sess-1' ? 'read-only' : null));
    expect(r).toMatchObject({ ok: false, error: 'read-only' });
    expect(fs.statSync(staging.partialPath(ID)).size).toBe(0);
  });

  it('GC removes entries untouched for 24 h and keeps fresh ones', async () => {
    let now = Date.now();
    const { staging, target } = setup({ now: () => now });
    const OLD = 'BBBBBBBBBBBBBBBBBBBBBB';
    await begin(staging, target, 3, { uploadId: OLD });
    await begin(staging, target, 3);
    // Age OLD's files past the cutoff.
    const past = new Date(now - UPLOAD_STAGING_MAX_AGE_MS - 60_000);
    fs.utimesSync(staging.partialPath(OLD), past, past);
    fs.utimesSync(staging.sidecarPath(OLD), past, past);
    expect(await staging.gc()).toBe(1);
    expect(fs.existsSync(staging.partialPath(OLD))).toBe(false);
    expect(fs.existsSync(staging.sidecarPath(OLD))).toBe(false);
    expect(fs.existsSync(staging.partialPath(ID))).toBe(true);

    now += UPLOAD_STAGING_MAX_AGE_MS + 60_000;
    expect(await staging.gc()).toBe(1);
    expect(fs.readdirSync(staging.dir)).toEqual([]);
  });

  it('contains() recognises the staging dir and paths under it', () => {
    const { staging } = setup();
    expect(staging.contains(staging.dir)).toBe(true);
    expect(staging.contains(path.join(staging.dir, ID))).toBe(true);
    expect(staging.contains(path.dirname(staging.dir))).toBe(false);
    expect(staging.contains(staging.dir + '-sibling')).toBe(false);
  });
});
