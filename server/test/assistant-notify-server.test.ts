import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startHarness, type Harness, type TestClient } from './harness.js';
import { b64urlEncode, SUBSCRIPTIONS_FILE, VAPID_FILE } from '../src/web-push.ts';

/**
 * `assistant_notify` and Web Push against the REAL server (real pi, fake LLM),
 * with the push service mocked at the HTTP boundary (a local HTTP server the
 * subscriptions point at, which decrypts nothing: the test decrypts as the
 * "browser" holding the subscription's private key):
 *  - active: a coding session's `assistant_notify` pushes the service worker's
 *    payload to EVERY subscribed device during its turn, opening that session; a
 *    410 prunes; a scheduled job that does not notify pushes nothing; an
 *    isolated job's notify opens the session that scheduled it;
 *  - the `/push/*` routes are token-gated;
 *  - `assistantFolder` unset, or the folder lock held by another server: no
 *    VAPID key, the push routes answer exactly like an unknown route, and
 *    `assistant_notify` is absent from server sessions.
 *
 * Isolation: `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR`
 * are temp dirs, and the real ~/.wherever is asserted untouched.
 */

const REAL_WHEREVER_DIR = path.join(os.homedir(), '.wherever');
function snapshotDir(dir: string): string {
  if (!fs.existsSync(dir)) return 'ABSENT';
  const entries: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        entries.push(`${prefix}${name}/`);
        walk(full, `${prefix}${name}/`);
      } else if (st.isFile()) {
        const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
        entries.push(`${prefix}${name}:${h}`);
      }
    }
  };
  walk(dir, '');
  return entries.join('\n');
}
const realBefore = snapshotDir(REAL_WHEREVER_DIR);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(() => {
  expect(snapshotDir(REAL_WHEREVER_DIR)).toBe(realBefore);
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-notify-srv-')));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function dirsFor(root: string, name: string) {
  const configDir = path.join(root, `${name}-config`);
  const stateDir = path.join(root, `${name}-state`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { configDir, stateDir };
}

async function boot(root: string, name: string, config: Record<string, unknown>, env: Record<string, string> = {}): Promise<Harness> {
  const { configDir, stateDir } = dirsFor(root, name);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  const h = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir, TZ: 'UTC', ...env } });
  cleanups.push(() => h.cleanup());
  return h;
}

async function client(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

async function assistantStatus(port: number): Promise<any> {
  return (await (await fetch(`http://127.0.0.1:${port}/config`)).json()).assistant;
}

async function until(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function newSession(c: TestClient, cwd: string): Promise<{ sessionId: string; sessionFile: string }> {
  c.send({ type: 'session_new', cwd, forceNew: true });
  const created = await c.waitFor((m) => m.type === 'session_created' && m.cwd === cwd);
  return { sessionId: created.sessionId, sessionFile: created.sessionFile };
}

async function turn(h: Harness, c: TestClient, sessionId: string, text: string, reply: string): Promise<Array<Record<string, any>>> {
  const before = h.fake.requests().length;
  h.setNext({ kind: 'reply', text: reply });
  c.send({ type: 'message', message: text, sessionId });
  await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant' && m.content === reply, 30_000);
  return h.fake.requests().slice(before);
}

async function toolTurn(h: Harness, c: TestClient, sessionId: string, toolName: string, input: Record<string, unknown>, reply: string) {
  h.fake.queue({ kind: 'tool-call', toolName, input, toolCallId: `toolu_${crypto.randomUUID().slice(0, 8)}` });
  return turn(h, c, sessionId, `please use ${toolName}`, reply);
}

const toolNames = (req: Record<string, any>): string[] => (req.tools ?? []).map((t: { name: string }) => t.name);

/** A "browser" device: its subscription for `endpoint`, and the decryption of what it is pushed (RFC 8291, receiver side). */
function device(endpoint: string) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    subscription: { endpoint, expirationTime: null, keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) } },
    decrypt(body: Buffer): any {
      const salt = body.subarray(0, 16);
      const idlen = body[20]!;
      const asPublic = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdh.computeSecret(asPublic), auth, keyInfo, 32));
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
    },
  };
}

/** The push service, mocked at HTTP: `/gone/*` answers 410, everything else 201. */
async function fakePushService() {
  const received: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url?.startsWith('/gone/') ? 410 : 201);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { received, base };
}

async function post(port: number, p: string, body: unknown, method = 'POST', query = ''): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}${query}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Status + body of a request, to compare a push route with an unknown route. */
async function answer(port: number, p: string, method = 'GET'): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, method === 'GET' ? {} : { method, body: '{}' });
  return `${res.status} ${res.headers.get('content-type')} ${await res.text()}`;
}

async function expectPushRoutesUnknown(port: number): Promise<void> {
  const unknownGet = await answer(port, '/no-such-route-xyz');
  expect(await answer(port, '/push/vapid-public-key')).toBe(unknownGet.replace('/no-such-route-xyz', '/push/vapid-public-key'));
  expect(await answer(port, '/push/subscription', 'POST')).toBe((await answer(port, '/no-such-route-xyz', 'POST')).replace('/no-such-route-xyz', '/push/subscription'));
}

describe('assistant_notify and Web Push (real server)', () => {
  it('active: notify pushes to every device and opens the caller; 410 prunes; a silent job pushes nothing; a job notify opens its origin', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const push = await fakePushService();
    const h = await boot(root, 'on', { assistantFolder: folder });
    const stateDir = path.join(root, 'on-state');

    // Web Push is on, and nothing is written until a device asks for the key.
    expect((await assistantStatus(h.port)).webPush).toEqual({ enabled: true, publicKey: null, subscriptions: 0 });
    expect(fs.existsSync(path.join(stateDir, VAPID_FILE))).toBe(false);
    const keyRes = await (await fetch(`http://127.0.0.1:${h.port}/push/vapid-public-key`)).json();
    expect(Buffer.from(keyRes.publicKey, 'base64url')).toHaveLength(65);
    expect(fs.statSync(path.join(stateDir, VAPID_FILE)).mode & 0o777).toBe(0o600);

    const phone = device(`${push.base}/ok/phone`);
    const laptop = device(`${push.base}/ok/laptop`);
    const stale = device(`${push.base}/gone/old-tablet`);
    for (const d of [phone, laptop, stale]) expect((await post(h.port, '/push/subscription', d.subscription)).status).toBe(200);
    expect((await post(h.port, '/push/subscription', { endpoint: 'nope' })).status).toBe(400);
    expect((await assistantStatus(h.port)).webPush).toEqual({ enabled: true, publicKey: keyRes.publicKey, subscriptions: 3 });
    const check = await (await fetch(`http://127.0.0.1:${h.port}/push/subscription?endpoint=${encodeURIComponent(phone.subscription.endpoint)}`)).json();
    expect(check).toEqual({ subscribed: true });
    expect(fs.statSync(path.join(stateDir, SUBSCRIPTIONS_FILE)).mode & 0o777).toBe(0o600);

    // From a coding session: delivered during its turn, to every device.
    const web = await client(h);
    const coding = await newSession(web, web.workspace);
    const reqs = await toolTurn(h, web, coding.sessionId, 'assistant_notify', { title: 'Deploy finished', body: 'all green' }, 'told you');
    expect(toolNames(reqs[0]!)).toContain('assistant_notify');
    // The tool result the model saw: the push service had already answered.
    expect(JSON.stringify(reqs[1]!.messages)).toContain('Notified the user via webpush (2 devices)');
    expect(push.received.map((r) => r.path).sort()).toEqual(['/gone/old-tablet', '/ok/laptop', '/ok/phone']);
    const expected = {
      web_push: 8030,
      notification: { title: `${path.basename(web.workspace)}: Deploy finished`, body: 'all green', navigate: `/#${coding.sessionId}` },
    };
    for (const [d, p] of [
      [phone, '/ok/phone'],
      [laptop, '/ok/laptop'],
      [stale, '/gone/old-tablet'],
    ] as const) {
      const r = push.received.find((x) => x.path === p)!;
      expect(r.headers['content-encoding']).toBe('aes128gcm');
      expect(r.headers.authorization).toMatch(/^vapid t=.+, k=/);
      expect(d.decrypt(r.body)).toEqual(expected);
    }
    // The 410 pruned the stale device.
    expect((await assistantStatus(h.port)).webPush.subscriptions).toBe(2);

    // A scheduled job that does not call assistant_notify pushes nothing; one
    // that does opens the session that scheduled it. `at` a few seconds ahead,
    // so the job's turn starts after this turn and the fake's queue is set.
    const pushedBefore = push.received.length;
    const at = new Date(Date.now() + 3_000).toISOString();
    await toolTurn(h, web, coding.sessionId, 'assistant_schedule_add', { name: 'Silent', at, mode: 'isolated', prompt: 'just look' }, 'scheduled');
    const runs = path.join(stateDir, 'assistant-runs.jsonl');
    await until(() => fs.existsSync(runs) && fs.readFileSync(runs, 'utf8').includes('"fired"'), 30_000);
    await until(() => h.fake.requests().filter((r) => JSON.stringify(r.messages).includes('[schedule:Silent]')).length >= 1, 30_000);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(push.received.length).toBe(pushedBefore);

    const at2 = new Date(Date.now() + 3_000).toISOString();
    await toolTurn(h, web, coding.sessionId, 'assistant_schedule_add', { name: 'Tell me', at: at2, mode: 'isolated', prompt: 'check CI and tell me' }, 'scheduled 2');
    h.fake.queue({ kind: 'tool-call', toolName: 'assistant_notify', input: { title: 'CI', body: 'red' }, toolCallId: 'toolu_jobnotify' });
    await until(() => push.received.length >= pushedBefore + 2, 30_000);
    const jobPushes = push.received.slice(pushedBefore);
    const fromJob = jobPushes.map((r) => (r.path === '/ok/phone' ? phone : laptop).decrypt(r.body));
    for (const p of fromJob) {
      expect(p.notification).toEqual({ title: `${path.basename(web.workspace)}: CI`, body: 'red', navigate: `/#${coding.sessionId}` });
    }
  }, 180_000);

  it('the push routes are token-gated', async () => {
    const root = tmp();
    const h = await boot(root, 'tok', { assistantFolder: path.join(root, 'assistant') }, { WHEREVER_TOKEN: 'sekret' });
    const base = `http://127.0.0.1:${h.port}`;
    expect((await fetch(`${base}/push/vapid-public-key`)).status).toBe(401);
    expect((await fetch(`${base}/push/subscription?endpoint=x`)).status).toBe(401);
    expect((await post(h.port, '/push/subscription', device('https://push.example/a').subscription)).status).toBe(401);
    expect((await post(h.port, '/push/subscription', { endpoint: 'https://push.example/a' }, 'DELETE')).status).toBe(401);
    expect(fs.existsSync(path.join(root, 'tok-state', VAPID_FILE))).toBe(false);
    expect((await fetch(`${base}/push/vapid-public-key?token=sekret`)).status).toBe(200);
    const sub = device('https://push.example/a').subscription;
    expect((await post(h.port, '/push/subscription', sub, 'POST', '?token=sekret')).status).toBe(200);
    expect((await post(h.port, '/push/subscription', { endpoint: sub.endpoint }, 'DELETE', '?token=sekret')).json).toEqual({ subscribed: false, removed: true });
  }, 60_000);

  it('assistantFolder unset: no key, unknown push routes, no assistant_notify, nothing written', async () => {
    const root = tmp();
    const { stateDir } = dirsFor(root, 'off');
    fs.writeFileSync(path.join(stateDir, 'keep.txt'), 'pre-existing');
    const before = snapshotDir(stateDir);
    const h = await boot(root, 'off', {});
    await expectPushRoutesUnknown(h.port);
    expect(await assistantStatus(h.port)).toEqual({ configured: false, folder: null, active: false, lock: null });
    const c = await client(h);
    const s = await newSession(c, c.workspace);
    const [req] = await turn(h, c, s.sessionId, 'hello', 'hi');
    expect(toolNames(req!)).not.toContain('assistant_notify');
    await h.stop();
    expect(snapshotDir(stateDir)).toBe(before);
  }, 90_000);

  it('folder lock held by another server: no key, unknown push routes, no assistant_notify', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const first = await boot(root, 'first', { assistantFolder: folder });
    expect((await assistantStatus(first.port)).active).toBe(true);
    const second = await boot(root, 'second', { assistantFolder: folder });
    const status = await assistantStatus(second.port);
    expect(status.lock.state).toBe('refused');
    expect(status.webPush).toBeUndefined();
    await expectPushRoutesUnknown(second.port);
    const c = await client(second);
    const s = await newSession(c, c.workspace);
    const [req] = await turn(second, c, s.sessionId, 'hello', 'hi');
    expect(toolNames(req!)).toContain('assistant_schedule_add');
    expect(toolNames(req!)).not.toContain('assistant_notify');
    expect(fs.existsSync(path.join(root, 'second-state', VAPID_FILE))).toBe(false);
    expect(fs.existsSync(path.join(root, 'second-state', SUBSCRIPTIONS_FILE))).toBe(false);
  }, 120_000);
});
