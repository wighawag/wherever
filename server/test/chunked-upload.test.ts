import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';
import { encodeChunkFrame, UPLOAD_CHUNK_MAX_BYTES, UPLOAD_STAGING_MAX_AGE_MS } from '../src/upload-staging.js';

// Resumable chunked uploads over the WebSocket (`upload.v1`, docs/adr/0012):
// upload_begin -> binary chunk frames -> upload_finish, acked with upload_offset,
// resumable from the server's offset, idempotent across a restart, gated on every
// frame, staged under `<state dir>/upload-staging` and never downloadable there.
//
// Isolation: the harness blanks WHEREVER_STATE_DIR, so state falls back to the
// per-test config dir; every test that writes uploads sets `uploads.type:
// 'session'` (never the default 'tmp'); and the AMBIENT state dir (what the
// server would use without the harness) is checked to be untouched, in
// particular its real `upload-staging`.

const ambientStateDir = (() => {
  const state = process.env.WHEREVER_STATE_DIR?.trim();
  if (state) return path.resolve(state);
  const config = process.env.WHEREVER_CONFIG_DIR?.trim();
  if (config) return path.resolve(config);
  return path.join(os.homedir(), '.wherever');
})();
function snapshotAmbient(): string[] {
  const list = (d: string) => {
    try {
      return fs.readdirSync(d).filter((n) => !n.endsWith('.tmp')).sort();
    } catch {
      return ['<absent>'];
    }
  };
  return [...list(ambientStateDir), '|', ...list(path.join(ambientStateDir, 'upload-staging'))];
}
let ambientBefore: string[];
beforeAll(() => {
  ambientBefore = snapshotAmbient();
});
afterAll(() => {
  expect(snapshotAmbient()).toEqual(ambientBefore);
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Boot a harness with its own wherever config (and, unless given, state dir = config dir). */
async function boot(config: object, opts?: { stateDir?: string; prepare?: (configDir: string) => void }) {
  const configDir = tmpDir('wherever-chunked-cfg-');
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  opts?.prepare?.(configDir);
  const h = await startHarness({
    initial: { kind: 'reply', text: 'hi' },
    idleTimeoutMs: 60_000,
    env: { WHEREVER_CONFIG_DIR: configDir, ...(opts?.stateDir ? { WHEREVER_STATE_DIR: opts.stateDir } : {}) },
  });
  cleanups.push(() => h.cleanup());
  return { h, configDir, stateDir: opts?.stateDir ?? configDir };
}

const newId = () => crypto.randomBytes(16).toString('base64url');

async function openSession(h: Harness, cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  const c = await h.connect();
  const connected = await c.waitForType('connected');
  c.send({ type: 'session_new', cwd });
  const created = await c.waitForType('session_created');
  return { c, connected, sessionId: created.sessionId as string, sessionFile: created.sessionFile as string };
}

async function loadSession(h: Harness, sessionFile: string) {
  const c = await h.connect();
  await c.waitForType('connected');
  c.send({ type: 'session_load', sessionFile });
  const created = await c.waitForType('session_created', 15_000);
  return { c, sessionId: created.sessionId as string };
}

type Msg = { type: string; [k: string]: unknown };
const isFor = (id: string) => (m: Msg) =>
  (m.type === 'upload_offset' || m.type === 'file_upload_error' || m.type === 'file_uploaded') && m.uploadId === id;

/** Send one frame and wait for the NEXT reply about `id` on this socket. */
async function request(c: TestClient, id: string, send: () => void): Promise<Msg> {
  const seen = c.messages.length;
  send();
  return c.waitFor((m) => c.messages.indexOf(m) >= seen && isFor(id)(m));
}

const begin = (c: TestClient, id: string, sessionId: string, size: number, filename = 'clip.bin') =>
  request(c, id, () => c.send({ type: 'upload_begin', uploadId: id, sessionId, filename, size }));
const chunk = (c: TestClient, id: string, offset: number, payload: Buffer) =>
  request(c, id, () => c.sendBinary(encodeChunkFrame(id, offset, payload)));
const finish = (c: TestClient, id: string, sessionId: string) =>
  request(c, id, () => c.send({ type: 'upload_finish', uploadId: id, sessionId }));

/** Send `data` from `from` in `size`-byte chunks, each awaiting its ack. */
async function sendAll(c: TestClient, id: string, data: Buffer, from = 0, size = 64 * 1024) {
  let offset = from;
  while (offset < data.length) {
    const ack = await chunk(c, id, offset, data.subarray(offset, offset + size));
    expect(ack.type).toBe('upload_offset');
    offset = ack.offset as number;
  }
  return offset;
}

const uploadsDir = (cwd: string) => path.join(cwd, '.wherever', 'uploads');
const listFiles = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

describe('resumable chunked uploads (server)', () => {
  it('advertises upload.v1; begin/chunk/finish save the file with the existing naming scheme', async () => {
    const { h, stateDir } = await boot({ uploads: { type: 'session' } });
    const proj = path.join(h.workspace, 'proj');
    const { c, connected, sessionId } = await openSession(h, proj);
    expect(connected.capabilities).toEqual(['upload.v1']);

    const data = crypto.randomBytes(300 * 1024);
    const id = newId();
    expect(await begin(c, id, sessionId, data.length, 'photo.jpg')).toMatchObject({ type: 'upload_offset', offset: 0 });
    // The partial is staged under the state dir, not in the session folder.
    expect(fs.existsSync(path.join(stateDir, 'upload-staging', id))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'upload-staging', `${id}.json`))).toBe(true);
    expect(listFiles(uploadsDir(proj))).toEqual([]);

    expect(await sendAll(c, id, data)).toBe(data.length);
    const done = await finish(c, id, sessionId);
    expect(done).toMatchObject({ type: 'file_uploaded', uploadId: id, sessionId, filename: 'photo.jpg' });
    const saved = String(done.savedPath);
    expect(path.dirname(saved)).toBe(uploadsDir(proj));
    expect(path.basename(saved)).toMatch(/^\d+_photo\.jpg$/);
    expect(fs.readFileSync(saved).equals(data)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'upload-staging', id))).toBe(false);

    // A zero-byte file finishes straight from begin.
    const empty = newId();
    expect(await begin(c, empty, sessionId, 0, 'empty.txt')).toMatchObject({ offset: 0 });
    const emptyDone = await finish(c, empty, sessionId);
    expect(emptyDone.type).toBe('file_uploaded');
    expect(fs.statSync(String(emptyDone.savedPath)).size).toBe(0);

    // Abort deletes the partial; the id then starts afresh.
    const aborted = newId();
    await begin(c, aborted, sessionId, 10);
    await chunk(c, aborted, 0, Buffer.from('abcd'));
    c.send({ type: 'upload_abort', uploadId: aborted, sessionId });
    expect(await begin(c, aborted, sessionId, 20)).toMatchObject({ type: 'upload_offset', offset: 0 });
  }, 90_000);

  it('resumes after a socket close from the server offset; an offset mismatch returns the true offset', async () => {
    const { h } = await boot({ uploads: { type: 'session' } });
    const proj = path.join(h.workspace, 'resume');
    const first = await openSession(h, proj);
    const data = crypto.randomBytes(200 * 1024);
    const id = newId();
    await begin(first.c, id, first.sessionId, data.length);
    await sendAll(first.c, id, data.subarray(0, 120 * 1024));
    first.c.close();

    const second = await loadSession(h, first.sessionFile);
    const resumed = await begin(second.c, id, second.sessionId, data.length);
    expect(resumed).toMatchObject({ type: 'upload_offset', offset: 120 * 1024 });
    expect(resumed.done).toBeUndefined();

    // Re-sending already-acked bytes (or skipping ahead) is not written: the
    // reply is the true offset.
    expect(await chunk(second.c, id, 0, data.subarray(0, 1024))).toMatchObject({ type: 'upload_offset', offset: 120 * 1024 });
    expect(await chunk(second.c, id, 150 * 1024, data.subarray(150 * 1024, 151 * 1024))).toMatchObject({ offset: 120 * 1024 });

    await sendAll(second.c, id, data, 120 * 1024);
    const done = await finish(second.c, id, second.sessionId);
    expect(done.type).toBe('file_uploaded');
    expect(fs.readFileSync(String(done.savedPath)).equals(data)).toBe(true);
  }, 90_000);

  it('serialises concurrent chunks for one id from two sockets (no interleaved or double writes)', async () => {
    const { h } = await boot({ uploads: { type: 'session' } });
    const proj = path.join(h.workspace, 'race');
    const a = await openSession(h, proj);
    const b = await loadSession(h, a.sessionFile);
    const data = crypto.randomBytes(512 * 1024);
    const id = newId();
    await begin(a.c, id, a.sessionId, data.length);
    await begin(b.c, id, b.sessionId, data.length);

    // Both sockets blast every chunk of the same file without waiting for acks
    // (a resumed upload whose old socket is still flushing).
    const step = 32 * 1024;
    for (let off = 0; off < data.length; off += step) {
      a.c.sendBinary(encodeChunkFrame(id, off, data.subarray(off, off + step)));
      b.c.sendBinary(encodeChunkFrame(id, off, data.subarray(off, off + step)));
    }
    const chunks = data.length / step;
    const acksOf = (c: TestClient) => c.messages.filter((m) => m.type === 'upload_offset' && m.uploadId === id);
    await a.c.waitFor(() => acksOf(a.c).length >= chunks + 1, 20_000);
    await b.c.waitFor(() => acksOf(b.c).length >= chunks + 1, 20_000);
    for (const c of [a.c, b.c]) {
      expect(c.messages.some((m) => m.type === 'file_upload_error')).toBe(false);
      const offsets = acksOf(c).map((m) => m.offset as number);
      expect(Math.max(...offsets)).toBeLessThanOrEqual(data.length);
      // Acks on one socket never go backwards.
      expect(offsets).toEqual([...offsets].sort((x, y) => x - y));
    }

    // Top up whatever the races left (none should be missing, but be exact).
    const at = (await begin(a.c, id, a.sessionId, data.length)).offset as number;
    await sendAll(a.c, id, data, at, step);
    const done = await finish(a.c, id, a.sessionId);
    expect(done.type).toBe('file_uploaded');
    expect(fs.readFileSync(String(done.savedPath)).equals(data)).toBe(true);
  }, 90_000);

  it('a finished id survives a server restart; a repeated finish returns the same path; another session is refused', async () => {
    const stateDir = tmpDir('wherever-chunked-state-');
    const config = { uploads: { type: 'session' } };
    const one = await boot(config, { stateDir });
    const proj = path.join(one.h.workspace, 'restart');
    const s1 = await openSession(one.h, proj);
    // One real turn, so the session file exists on disk for server 2 to load.
    s1.c.send({ type: 'message', message: 'hello', sessionId: s1.sessionId });
    await s1.c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant');
    await s1.c.waitForType('agent_end');
    const data = crypto.randomBytes(100 * 1024);
    const id = newId();
    await begin(s1.c, id, s1.sessionId, data.length);
    await sendAll(s1.c, id, data);
    const done = await finish(s1.c, id, s1.sessionId);
    expect(done.type).toBe('file_uploaded');
    const savedPath = String(done.savedPath);
    // A finish whose reply was "lost" is answered with the same path.
    expect(await finish(s1.c, id, s1.sessionId)).toMatchObject({ type: 'file_uploaded', savedPath });
    expect(fs.existsSync(path.join(stateDir, 'upload-staging', `${id}.json`))).toBe(true);

    // Restart: stop server 1 (keeping its session file and workspace), boot a
    // second server on the SAME state dir and repaint the session from its
    // absolute session file.
    await one.h.stop();
    const two = await boot(config, { stateDir });
    const s2 = await loadSession(two.h, s1.sessionFile);
    expect(s2.sessionId).toBe(s1.sessionId);

    expect(await begin(s2.c, id, s2.sessionId, data.length)).toMatchObject({ type: 'upload_offset', offset: data.length, done: true, savedPath });
    expect(await finish(s2.c, id, s2.sessionId)).toMatchObject({ type: 'file_uploaded', savedPath });
    expect(listFiles(uploadsDir(proj))).toEqual([path.basename(savedPath)]);

    // The same id from a different session is refused.
    const other = await openSession(two.h, path.join(two.h.workspace, 'other'));
    const refused = await begin(other.c, id, other.sessionId, data.length);
    expect(refused.type).toBe('file_upload_error');
    expect(String(refused.error)).toMatch(/different session/i);
    expect((await finish(other.c, id, other.sessionId)).type).toBe('file_upload_error');
  }, 120_000);

  it('refuses an invalid uploadId, an oversized size, an oversized chunk and a gate refusal mid-upload, with reasons', async () => {
    const { h, stateDir } = await boot({ uploads: { type: 'session', maxBytes: 4 * 1024 * 1024 } });
    const proj = path.join(h.workspace, 'refusals');
    const { c, sessionId } = await openSession(h, proj);

    const bad = await begin(c, 'too-short', sessionId, 10);
    expect(bad.type).toBe('file_upload_error');
    expect(String(bad.error)).toMatch(/invalid uploadId/i);

    const bigId = newId();
    const big = await begin(c, bigId, sessionId, 4 * 1024 * 1024 + 1);
    expect(big.type).toBe('file_upload_error');
    expect(String(big.error)).toMatch(/too large/i);
    expect(fs.existsSync(path.join(stateDir, 'upload-staging', bigId))).toBe(false);

    const id = newId();
    await begin(c, id, sessionId, 3 * 1024 * 1024);
    const huge = await chunk(c, id, 0, Buffer.alloc(UPLOAD_CHUNK_MAX_BYTES + 1));
    expect(huge.type).toBe('file_upload_error');
    expect(String(huge.error)).toMatch(/chunk too large/i);
    expect(await chunk(c, id, 0, Buffer.alloc(1024))).toMatchObject({ type: 'upload_offset', offset: 1024 });

    // Mid-upload, the socket leaves the session: the next chunk and the finish
    // are refused by the write gate, and nothing more is written.
    c.send({ type: 'session_leave', sessionId });
    await new Promise((r) => setTimeout(r, 300));
    const gated = await chunk(c, id, 1024, Buffer.alloc(1024));
    expect(gated.type).toBe('file_upload_error');
    expect(String(gated.error)).toMatch(/not for the session this connection is on/i);
    expect(fs.statSync(path.join(stateDir, 'upload-staging', id)).size).toBe(1024);
    const gatedFinish = await finish(c, id, sessionId);
    expect(gatedFinish.type).toBe('file_upload_error');
    const gatedBegin = await begin(c, newId(), sessionId, 10);
    expect(gatedBegin.type).toBe('file_upload_error');
    expect(listFiles(uploadsDir(proj))).toEqual([]);
  }, 90_000);

  it('GCs stale staging entries at startup, and /session/download refuses a staging path', async () => {
    const STALE = newId();
    const { h, stateDir } = await boot(
      // The state dir is (deliberately) a download root here, which would
      // otherwise expose the staging dir under it.
      { uploads: { type: 'session' } },
      {
        prepare: (configDir) => {
          const staging = path.join(configDir, 'upload-staging');
          fs.mkdirSync(staging, { recursive: true });
          for (const name of [STALE, `${STALE}.json`]) {
            const p = path.join(staging, name);
            fs.writeFileSync(p, name.endsWith('.json') ? '{}' : 'old');
            const past = new Date(Date.now() - UPLOAD_STAGING_MAX_AGE_MS - 60_000);
            fs.utimesSync(p, past, past);
          }
          fs.writeFileSync(
            path.join(configDir, 'config.json'),
            JSON.stringify({ uploads: { type: 'session' }, downloads: { roots: [configDir, path.join(configDir, 'upload-staging')] } }),
          );
          fs.writeFileSync(path.join(configDir, 'visible.txt'), 'visible');
        },
      },
    );
    const staging = path.join(stateDir, 'upload-staging');
    expect(fs.existsSync(path.join(staging, STALE))).toBe(false);
    expect(fs.existsSync(path.join(staging, `${STALE}.json`))).toBe(false);

    const { c, sessionId } = await openSession(h, path.join(h.workspace, 'dl'));
    const id = newId();
    await begin(c, id, sessionId, 10);
    await chunk(c, id, 0, Buffer.from('secret'));

    const get = (p: string) =>
      fetch(`http://127.0.0.1:${h.port}/session/download?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(p)}`);
    // The root works for an ordinary file...
    expect((await get(path.join(stateDir, 'visible.txt'))).status).toBe(200);
    // ...but never for a partial, nor its sidecar.
    expect((await get(path.join(staging, id))).status).toBe(404);
    expect((await get(path.join(staging, `${id}.json`))).status).toBe(404);
  }, 90_000);

  it('the legacy file_upload frame and a large cli_event frame still work', async () => {
    const { h } = await boot({ uploads: { type: 'session' } });
    const proj = path.join(h.workspace, 'legacy');
    const { c, sessionId } = await openSession(h, proj);
    const legacyData = crypto.randomBytes(2 * 1024 * 1024); // bigger than one chunk
    c.send({ type: 'file_upload', uploadId: 'legacy-1', sessionId, filename: 'old.bin', data: legacyData.toString('base64') });
    const legacy = await c.waitFor((m) => m.type === 'file_uploaded' && m.uploadId === 'legacy-1', 20_000);
    expect(fs.readFileSync(String(legacy.savedPath)).equals(legacyData)).toBe(true);

    // A CLI bridge frame far over the chunk cap (base64 images ride on these).
    const cli = await h.connect();
    await cli.waitForType('connected');
    const sessionFile = path.join(h.workspace, 'cli-session.jsonl');
    cli.send({ type: 'cli_register', sessionFile, cwd: h.workspace, model: 'fake:fake-model' });
    await h.waitForActive(sessionFile);
    const viewer = await h.connect();
    await viewer.waitForType('connected');
    viewer.send({ type: 'session_load', sessionFile });
    await viewer.waitForType('session_created', 15_000);
    await new Promise((r) => setTimeout(r, 300));
    const delta = 'x'.repeat(5 * 1024 * 1024);
    cli.send({
      type: 'cli_event',
      sessionFile,
      event: { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta } },
    });
    const update = await viewer.waitFor((m) => m.type === 'message_update', 20_000);
    expect(String(update.delta).length).toBe(delta.length);
  }, 90_000);
});
