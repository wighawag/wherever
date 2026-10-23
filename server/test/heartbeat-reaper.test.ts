import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { startHarness, type Harness } from './harness.js';

// The server's WebSocket liveness reaper (ADR 0011). It pings every
// WHEREVER_HEARTBEAT_MS and terminates a socket only after TWO consecutive
// unanswered pings; ANY inbound message counts as proof of life, like a pong.
//
// These tests open a raw `ws` client with `autoPong: false`, so the client never
// answers the server's ping frames on its own. The client still sees each ping
// (the 'ping' event fires regardless), which lets the tests count intervals by
// the server's own clock instead of guessing with sleeps.

const HEARTBEAT_MS = 200;

let h: Harness | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try { s.terminate(); } catch {}
  }
  await h?.cleanup();
  h = undefined;
});

interface SilentClient {
  ws: WebSocket;
  pings: () => number;
  /** Resolves when the n-th server ping frame (1-based) has arrived. */
  waitForPing: (n: number, timeoutMs?: number) => Promise<void>;
  closed: Promise<number>;
  isClosed: () => boolean;
}

async function openSilent(port: number): Promise<SilentClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false });
  sockets.push(ws);
  let pings = 0;
  let closed = false;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  ws.on('ping', () => {
    pings++;
    for (const w of waiters.splice(0)) {
      if (pings >= w.n) w.resolve();
      else waiters.push(w);
    }
  });
  const closedP = new Promise<number>((resolve) => {
    ws.on('close', (code) => {
      closed = true;
      resolve(code);
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    pings: () => pings,
    waitForPing: (n, timeoutMs = 10_000) =>
      new Promise<void>((resolve, reject) => {
        if (pings >= n) return resolve();
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ping #${n} (got ${pings})`)), timeoutMs);
        waiters.push({ n, resolve: () => { clearTimeout(timer); resolve(); } });
      }),
    closed: closedP,
    isClosed: () => closed,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('server heartbeat reaper', () => {
  it('tolerates one missed pong and reaps on the second consecutive miss', async () => {
    h = await startHarness({ env: { WHEREVER_HEARTBEAT_MS: String(HEARTBEAT_MS) } });
    const c = await openSilent(h.port);

    // Ping #1 goes unanswered. The next tick must NOT reap: it sends ping #2.
    await c.waitForPing(1);
    await c.waitForPing(2);
    expect(c.isClosed()).toBe(false);

    // Ping #2 also unanswered: two consecutive misses, the next tick reaps.
    await Promise.race([
      c.closed,
      sleep(HEARTBEAT_MS * 10).then(() => { throw new Error('socket was not reaped'); }),
    ]);
    expect(c.isClosed()).toBe(true);
    // Reaped on the tick after ping #2, never pinged a third time.
    expect(c.pings()).toBe(2);
  }, 60_000);

  it('runs the normal close teardown when it reaps a socket', async () => {
    // The reaped viewer must be detached from its session like any closed
    // socket. Otherwise it would keep "holding" its folder, and a different
    // viewer's session_new there would open read-only behind a folder conflict.
    h = await startHarness({ env: { WHEREVER_HEARTBEAT_MS: String(HEARTBEAT_MS) }, idleTimeoutMs: 300_000 });
    const cwd = h.workspace + '/reaped';
    const c = await openSilent(h.port);
    const created = new Promise<any>((resolve) => {
      c.ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m.type === 'session_created') resolve(m);
      });
    });
    c.ws.send(JSON.stringify({ type: 'session_new', cwd }));
    await created;
    // Now silent: reaped after two missed pings.
    await c.closed;

    const other = await h.connect('other-viewer');
    await other.waitForType('connected');
    other.send({ type: 'session_new', cwd });
    const reply = await other.waitForType('session_created');
    expect(reply.readOnly).toBeFalsy();
    expect(reply.folderConflict).toBeFalsy();
  }, 60_000);

  it('never reaps a socket that keeps sending messages while never ponging', async () => {
    h = await startHarness({ env: { WHEREVER_HEARTBEAT_MS: String(HEARTBEAT_MS) } });
    const c = await openSilent(h.port);

    const tick = setInterval(() => {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'ping' }));
    }, HEARTBEAT_MS / 2);
    try {
      // Far past the two-miss threshold: six server pings, none answered.
      await c.waitForPing(6);
      expect(c.isClosed()).toBe(false);
    } finally {
      clearInterval(tick);
    }
  }, 60_000);

  it('keeps the 30s default when WHEREVER_HEARTBEAT_MS is unset or invalid', async () => {
    for (const env of [{}, { WHEREVER_HEARTBEAT_MS: 'abc' }, { WHEREVER_HEARTBEAT_MS: '0' }] as Array<Record<string, string>>) {
      // An ambient WHEREVER_HEARTBEAT_MS must not leak into the "unset" case.
      h = await startHarness({ env: { WHEREVER_HEARTBEAT_MS: '', ...env } });
      const c = await openSilent(h.port);
      // With a 30 s interval no ping arrives in this window (a short override
      // would have pinged several times and reaped by now).
      await sleep(HEARTBEAT_MS * 6);
      expect(c.pings()).toBe(0);
      expect(c.isClosed()).toBe(false);
      c.ws.terminate();
      await h.cleanup();
      h = undefined;
    }
  }, 120_000);
});
