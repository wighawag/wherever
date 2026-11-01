/**
 * Slow-link benchmark: does a session with a large tool image in its history
 * load over a weak connection, and how long does it take?
 *
 * Boots the REAL server (test harness, fake LLM, throwaway dirs), seeds a
 * session whose last tool result carries a random (incompressible) image,
 * then drives the real `WhereverClient` through a TCP proxy that throttles the
 * server -> client direction. It logs every socket open/close and inbound frame
 * and ends with a RESULT line. Healthy: one socket, one `message_history`.
 * The failure this guards (CONTEXT.md, "Slow links"): the watchdog kept killing
 * the socket mid-transfer, so sockets grew and `message_history` stayed at 0.
 *
 * Usage (from the repo root; takes RUN_MS, default 60 s):
 *   server/node_modules/.bin/tsx server/test/bench/slow-link.ts
 *
 * Env:
 *   RATE=30000     server -> client bytes per second
 *   IMG=3000000    image size in bytes (base64 in the transcript is 4/3 of it)
 *   RUN_MS=60000   how long to watch after joining the session
 *   LEGACY=1       drop the client's slow-link opt-ins (frames=chunk.v1,
 *                  imageRefs=1) from the socket URL, to see what an older
 *                  client gets. Use RUN_MS=240000 to watch it loop.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { startHarness } from '../harness.js';
import { WhereverClient } from '../../../client/src/client.js';

const RATE = Number(process.env.RATE ?? 30_000);
const IMG_BYTES = Number(process.env.IMG ?? 3_000_000);
const RUN_MS = Number(process.env.RUN_MS ?? 60_000);
const LEGACY = process.env.LEGACY === '1';

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const h = await startHarness({ initial: { kind: 'reply', text: 'hi there' }, idleTimeoutMs: 0 });
let proxy: net.Server | undefined;
try {
  // Seed: one real turn, then append a tool result carrying a big image (like
  // `read` on a screenshot). Idle timeout 0 makes the load below a cold read.
  const seed = await h.connect();
  await seed.waitForType('connected');
  seed.send({ type: 'session_new', cwd: seed.workspace });
  const created = await seed.waitForType('session_created');
  seed.send({ type: 'message', message: 'hello', sessionId: created.sessionId });
  await seed.waitForType('agent_end');
  const sessionFile = created.sessionFile as string;
  seed.close();
  await new Promise((r) => setTimeout(r, 500));
  const data = crypto.randomBytes(IMG_BYTES).toString('base64');
  fs.appendFileSync(
    sessionFile,
    JSON.stringify({
      type: 'message',
      timestamp: new Date().toISOString(),
      message: {
        role: 'toolResult',
        toolName: 'read',
        toolCallId: 'tc-bench',
        content: [{ type: 'image', mimeType: 'image/png', data }],
      },
    }) + '\n',
  );
  log(`seeded a ${(IMG_BYTES / 1e6).toFixed(1)} MB image; link ${(RATE / 1000).toFixed(0)} KB/s${LEGACY ? '; LEGACY client' : ''}`);

  // Throttling proxy. Upstream (client -> server) is unthrottled; downstream is
  // released in 100 ms slices of RATE / 10 bytes.
  proxy = net.createServer((down) => {
    const up = net.connect(h.port, '127.0.0.1');
    down.pipe(up);
    const queue: Buffer[] = [];
    let upClosed = false;
    up.on('data', (b) => queue.push(b));
    const tick = setInterval(() => {
      let budget = RATE / 10;
      while (budget > 0 && queue.length) {
        const b = queue[0];
        if (b.length <= budget) {
          down.write(queue.shift()!);
          budget -= b.length;
        } else {
          down.write(b.subarray(0, budget));
          queue[0] = b.subarray(budget);
          budget = 0;
        }
      }
      if (upClosed && !queue.length) {
        clearInterval(tick);
        down.end();
      }
    }, 100);
    up.on('close', () => (upClosed = true));
    up.on('error', () => {});
    down.on('error', () => {});
    down.on('close', () => {
      clearInterval(tick);
      up.destroy();
    });
  });
  await new Promise<void>((r) => proxy!.listen(0, '127.0.0.1', () => r()));
  const proxyPort = (proxy.address() as net.AddressInfo).port;

  // A spying WebSocket: logs opens/closes/frames and counts loads/histories.
  let sockets = 0;
  let closes = 0;
  let histories = 0;
  let loads = 0;
  let historyAt: number | null = null;
  const Base = (globalThis as any).WebSocket;
  class SpyWS extends Base {
    constructor(url: string) {
      super(LEGACY ? url.replace(/&(frames=chunk\.v1|imageRefs=1)/g, '') : url);
      const id = ++sockets;
      log(`socket #${id} connecting`);
      this.addEventListener('open', () => log(`socket #${id} open`));
      this.addEventListener('close', () => {
        closes++;
        log(`socket #${id} closed`);
      });
      let chunks = 0;
      this.addEventListener('message', (e: any) => {
        const s = typeof e.data === 'string' ? e.data : '';
        if (s.charCodeAt(0) === 1) {
          // A frame chunk: report progress every ~10 chunks, and the last one.
          const [, seq, count] = s.slice(1, s.indexOf('\n')).split(' ').map(Number);
          if (seq === 0 && s.includes('"type":"message_history"')) histories++;
          if (++chunks % 10 === 0 || seq === count - 1) log(`socket #${id} <- chunk ${seq + 1}/${count}`);
          if (seq === count - 1 && historyAt === null && histories > 0) historyAt = Date.now();
          return;
        }
        const type = /"type":"([^"]+)"/.exec(s.slice(0, 200))?.[1];
        if (type === 'message_history') {
          histories++;
          historyAt ??= Date.now();
        }
        if (type !== 'pong') log(`socket #${id} <- ${type} (${(s.length / 1e3).toFixed(0)} KB)`);
      });
    }
    send(d: any) {
      if (typeof d === 'string' && d.includes('"session_load"')) {
        loads++;
        log('-> session_load');
      }
      super.send(d);
    }
  }

  const client = new WhereverClient({
    host: '127.0.0.1',
    port: proxyPort,
    secure: false,
    WebSocketCtor: SpyWS as any,
    imageRefs: !LEGACY,
  });
  client.connect();
  await new Promise((r) => setTimeout(r, 1000));
  const joinedAt = Date.now();
  client.joinSession(sessionFile);
  await new Promise((r) => setTimeout(r, RUN_MS));
  const took = historyAt === null ? 'never' : `${((historyAt - joinedAt) / 1000).toFixed(1)}s`;
  log(`RESULT sockets=${sockets} closes=${closes} session_load=${loads} message_history=${histories} history_after=${took}`);
  client.disconnect(true);
} finally {
  proxy?.close();
  await h.cleanup();
  process.exit(0);
}
