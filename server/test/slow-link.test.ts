import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { WebSocket } from 'ws';
import { startHarness, type Harness } from './harness.js';

// Slow-link resilience: large frames are chunked for clients that ask
// (frames=chunk.v1), WS frames are deflated, and static assets are compressed.

let h: Harness;
let sessionFile: string;
const BIG = 'q'.repeat(200_000);
const IMG = Buffer.from(Array.from({ length: 60_000 }, (_, i) => (i * 7919) % 251));
const SMALL_IMG = Buffer.from([1, 2, 3, 4]);
// A LATER result reusing the same toolCallId (some providers reuse ids per turn).
const IMG2 = Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * 31) % 253));
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">' + ' '.repeat(30_000) + '</svg>');

function toolResultLine(id: string, toolCallId: string, images: { mimeType: string; data: Buffer }[]): string {
  return JSON.stringify({
    type: 'message',
    id,
    timestamp: new Date().toISOString(),
    message: {
      role: 'toolResult',
      toolName: 'read',
      toolCallId,
      content: [
        { type: 'text', text: 'Read image file' },
        ...images.map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data.toString('base64') })),
      ],
    },
  });
}

beforeAll(async () => {
  h = await startHarness({ initial: { kind: 'reply', text: 'hi there' }, idleTimeoutMs: 0 });
  const c = await h.connect();
  await c.waitForType('connected');
  c.send({ type: 'session_new', cwd: c.workspace });
  const created = await c.waitForType('session_created');
  c.send({ type: 'message', message: 'hello', sessionId: created.sessionId });
  await c.waitForType('agent_end');
  sessionFile = created.sessionFile as string;
  c.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.appendFileSync(
    sessionFile,
    JSON.stringify({
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'toolResult', toolName: 'read', toolCallId: 'tc1', content: [{ type: 'text', text: BIG }] },
    }) +
      '\n' +
      toolResultLine('e-img-1', 'tc-img', [
        { mimeType: 'image/png', data: SMALL_IMG },
        { mimeType: 'image/png', data: IMG },
      ]) +
      '\n' +
      toolResultLine('e-img-2', 'tc-img', [{ mimeType: 'image/png', data: IMG2 }]) +
      '\n' +
      toolResultLine('e-svg', 'tc-svg', [{ mimeType: 'image/svg+xml', data: SVG }]) +
      '\n',
  );
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
});

/** Load the session over a raw socket and return every raw text frame until message_history. */
async function loadRaw(query: string): Promise<{ frames: string[]; extensions: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws?${query}`);
  const frames: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session_load', sessionFile })));
    ws.on('message', (d) => {
      const s = d.toString();
      frames.push(s);
      if (s.charCodeAt(0) !== 1) {
        if (s.includes('"type":"message_history"')) resolve();
        return;
      }
      // A chunk: done once the LAST chunk of a message_history has arrived.
      const [, seq, count] = s.slice(1, s.indexOf('\n')).split(' ').map(Number);
      if (seq === count - 1 && frames.some((f) => f.charCodeAt(0) === 1 && f.includes('{"type":"message_history"'))) {
        resolve();
      }
    });
    setTimeout(() => reject(new Error('no history')), 20_000);
  });
  const extensions = ws.extensions;
  ws.close();
  return { frames, extensions };
}

function historyOf(frames: string[]): any {
  const chunks = frames.filter((f) => f.charCodeAt(0) === 1);
  if (chunks.length > 0) return JSON.parse(chunks.map((c) => c.slice(c.indexOf('\n') + 1)).join(''));
  return JSON.parse(frames.find((f) => f.includes('"type":"message_history"'))!);
}

function imagesOf(history: any, nth = 0): any[] {
  return history.messages.filter((m: any) => m.toolCallId === 'tc-img')[nth].images;
}

describe('history images by reference', () => {
  it('sends large images by reference to a socket that asks, and serves them', async () => {
    const { frames } = await loadRaw('frames=chunk.v1&imageRefs=1');
    const sessionId = JSON.parse(frames.find((f) => f.includes('"type":"session_created"'))!).sessionId;
    const images = imagesOf(historyOf(frames));
    // The tiny one stays inline; the big one is an address.
    expect(images[0]).toEqual({ mimeType: 'image/png', data: SMALL_IMG.toString('base64') });
    expect(images[1]).toEqual({ mimeType: 'image/png', bytes: IMG.length, toolCallId: 'tc-img', entryId: 'e-img-1', index: 1 });
    const later = imagesOf(historyOf(frames), 1)[0];
    expect(later).toEqual({ mimeType: 'image/png', bytes: IMG2.length, toolCallId: 'tc-img', entryId: 'e-img-2', index: 0 });

    const base = `http://127.0.0.1:${h.port}/session/tool-image?sessionId=${sessionId}`;
    const r = await fetch(`${base}&toolCallId=tc-img&entryId=e-img-1&index=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await r.arrayBuffer()).equals(IMG)).toBe(true);

    // The entry id disambiguates a reused toolCallId.
    const r2 = await fetch(`${base}&toolCallId=tc-img&entryId=e-img-2&index=0`);
    expect(Buffer.from(await r2.arrayBuffer()).equals(IMG2)).toBe(true);

    expect((await fetch(`${base}&toolCallId=nope&index=0`)).status).toBe(404);
    expect((await fetch(`${base}&toolCallId=tc-img&entryId=e-img-1`)).status).toBe(400);
    // SVG is never sent by reference, and never served inline.
    expect(historyOf(frames).messages.find((m: any) => m.toolCallId === 'tc-svg').images[0].data).toBeTruthy();
    expect((await fetch(`${base}&toolCallId=tc-svg&entryId=e-svg&index=0`)).status).toBe(415);
  }, 30_000);

  it('gates the endpoint behind the token like every /session/ route', async () => {
    const t = await startHarness({ env: { PI_REMOTE_TOKEN: 'sekrit' } });
    try {
      const url = `http://127.0.0.1:${t.port}/session/tool-image?sessionId=x&toolCallId=y&index=0`;
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(`${url}&token=sekrit`)).status).toBe(404);
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it('keeps images inline for a socket that did not ask', async () => {
    const { frames } = await loadRaw('clientKey=old-web');
    const images = imagesOf(historyOf(frames));
    expect(images[1].data).toBe(IMG.toString('base64'));
  }, 30_000);
});

describe('slow-link transport', () => {
  it('chunks a large frame for a client that asks, and reassembles to the original', async () => {
    const { frames, extensions } = await loadRaw('frames=chunk.v1');
    expect(extensions).toContain('permessage-deflate');
    const chunks = frames.filter((f) => f.charCodeAt(0) === 1);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThan(33 * 1024 + 64);
    const text = chunks.map((c) => c.slice(c.indexOf('\n') + 1)).join('');
    const msg = JSON.parse(text);
    expect(msg.type).toBe('message_history');
    expect(JSON.stringify(msg.messages)).toContain(BIG);
  }, 30_000);

  it('never chunks for a client that did not ask', async () => {
    const { frames } = await loadRaw('clientKey=plain');
    expect(frames.some((f) => f.charCodeAt(0) === 1)).toBe(false);
    const history = frames.find((f) => f.includes('"type":"message_history"'))!;
    expect(JSON.parse(history).messages.length).toBeGreaterThan(0);
  }, 30_000);

  it('serves static text assets compressed, and leaves them alone when not accepted', async () => {
    const get = (enc?: string) =>
      new Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port: h.port, path: '/', headers: enc ? { 'accept-encoding': enc } : {} }, (res) => {
            const parts: Buffer[] = [];
            res.on('data', (d) => parts.push(d));
            res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(parts) }));
          })
          .on('error', reject);
      });
    const plain = await get();
    expect(plain.headers['content-encoding']).toBeUndefined();
    const br = await get('gzip, deflate, br');
    expect(br.headers['content-encoding']).toBe('br');
    expect(zlib.brotliDecompressSync(br.body).equals(plain.body)).toBe(true);
    const gz = await get('gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(gz.body).equals(plain.body)).toBe(true);
  }, 30_000);
});
