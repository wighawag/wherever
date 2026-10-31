import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SUBSCRIPTIONS_FILE,
  VAPID_FILE,
  WebPushChannel,
  b64urlDecode,
  b64urlEncode,
  encryptPushPayload,
  generateVapidKeys,
  resolveVapidSubject,
  validateSubscription,
  vapidAuthorization,
  webPushPayload,
  type PushFetch,
  type PushSubscriptionRecord,
} from '../src/web-push.ts';

/**
 * The in-process Web Push sender (web-push.ts, ADR 0017), with the push service
 * mocked at the HTTP boundary (`PushFetch`): RFC 8291 encryption against the
 * RFC's own test vector, the VAPID JWT, first-use key generation (0600) in a
 * temp state dir, the subscription store, fan-out to EVERY subscription, and
 * the 404 / 410 prune. The real ~/.wherever is asserted untouched.
 */

const REAL_WHEREVER_DIR = path.join(os.homedir(), '.wherever');
const snapshot = (d: string) => {
  try {
    return fs.readdirSync(d).sort().map((n) => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`).join(',');
  } catch {
    return 'ABSENT';
  }
};
const realBefore = snapshot(REAL_WHEREVER_DIR);
afterAll(() => {
  expect(snapshot(REAL_WHEREVER_DIR)).toBe(realBefore);
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-web-push-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A "browser": a P-256 keypair and an auth secret, able to decrypt what it is sent. */
function fakeBrowser(endpoint: string) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription: PushSubscriptionRecord = {
    endpoint,
    expirationTime: null,
    keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) },
  };
  return { subscription, decrypt: (body: Uint8Array) => decryptPush(Buffer.from(body), ecdh, auth) };
}

/** The receiving side of RFC 8291 (what a browser does), written from the RFC independently of the sender. */
function decryptPush(body: Buffer, ua: crypto.ECDH, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  expect(rs).toBe(4096);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdhSecret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

type Sent = { url: string; headers: Record<string, string>; body: Uint8Array };

/** The push service, mocked at HTTP: answers per endpoint, records every request. */
function fakePushService(statusFor: (url: string) => number = () => 201) {
  const sent: Sent[] = [];
  const fetch: PushFetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    const status = statusFor(url);
    return { status, text: async () => (status >= 400 ? 'gone' : '') };
  };
  return { sent, fetch };
}

describe('RFC 8291 encryption', () => {
  it('matches the RFC 8291 Appendix A / Section 5 test vector', () => {
    const body = encryptPushPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'BTBZMqHH6r4Tts7J_aSIgg',
      { salt: b64urlDecode('DGv6ra1nlYgDCS1FRnbzlw'), asPrivateKey: b64urlDecode('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
    );
    expect(b64urlEncode(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
        'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('round-trips through an independent receiver', () => {
    const browser = fakeBrowser('https://push.example/x');
    const body = encryptPushPayload(Buffer.from('héllo'), browser.subscription.keys.p256dh, browser.subscription.keys.auth);
    expect(browser.decrypt(body)).toBe('héllo');
  });
});

describe('VAPID', () => {
  it('signs an ES256 JWT for the endpoint origin, verifiable with the public key', () => {
    const keys = generateVapidKeys();
    const now = Date.UTC(2026, 9, 30, 12);
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:me@example.com', now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m).not.toBeNull();
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(b64urlDecode(m[1]!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b64urlDecode(m[2]!).toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'mailto:me@example.com',
    });
    const pub = b64urlDecode(keys.publicKey);
    const key = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.subarray(1, 33)), y: b64urlEncode(pub.subarray(33)) },
      format: 'jwk',
    });
    expect(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, b64urlDecode(m[3]!))).toBe(true);
  });

  it('the subject: config, else the public URL origin, else the project homepage', () => {
    expect(resolveVapidSubject({ subject: 'mailto:me@example.com', publicUrl: 'https://w.example/x' })).toBe('mailto:me@example.com');
    expect(resolveVapidSubject({ publicUrl: 'https://w.example/app/' })).toBe('https://w.example');
    expect(resolveVapidSubject({ subject: 'nonsense', publicUrl: 'also nonsense' })).toBe('https://wherever.dev');
    expect(resolveVapidSubject({})).toBe('https://wherever.dev');
  });
});

describe('the Web Push channel (temp state dir, push service mocked at HTTP)', () => {
  it('generates the VAPID keypair on FIRST USE only, mode 0600, and keeps it', () => {
    const stateDir = tmp();
    const channel = new WebPushChannel({ stateDir, subject: 'mailto:x@y.z', fetch: fakePushService().fetch });
    expect(channel.existingPublicKey()).toBeNull();
    expect(fs.readdirSync(stateDir)).toEqual([]);
    const key = channel.publicKey();
    expect(b64urlDecode(key)).toHaveLength(65);
    const file = path.join(stateDir, VAPID_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(channel.existingPublicKey()).toBe(key);
    // A second instance (a restart) reads the same keys.
    expect(new WebPushChannel({ stateDir, subject: 'mailto:x@y.z' }).publicKey()).toBe(key);
  });

  it('refuses to replace an unreadable key file (every device is bound to it)', () => {
    const stateDir = tmp();
    fs.writeFileSync(path.join(stateDir, VAPID_FILE), '{garbage');
    const channel = new WebPushChannel({ stateDir, subject: 'mailto:x@y.z' });
    expect(() => channel.publicKey()).toThrow(/unreadable/);
    expect(fs.readFileSync(path.join(stateDir, VAPID_FILE), 'utf8')).toBe('{garbage');
  });

  it('stores subscriptions (0600), replaces by endpoint, and removes them', async () => {
    const stateDir = tmp();
    const channel = new WebPushChannel({ stateDir, subject: 'mailto:x@y.z' });
    const a = fakeBrowser('https://push.example/a').subscription;
    const b = fakeBrowser('https://push.example/b').subscription;
    expect(await channel.subscribe(a)).toBe(1);
    expect(await channel.subscribe(b)).toBe(2);
    expect(await channel.subscribe({ ...a, keys: b.keys })).toBe(2);
    expect(channel.subscriptions().find((s) => s.endpoint === a.endpoint)!.keys).toEqual(b.keys);
    expect(fs.statSync(path.join(stateDir, SUBSCRIPTIONS_FILE)).mode & 0o777).toBe(0o600);
    expect(channel.isSubscribed(a.endpoint)).toBe(true);
    expect(await channel.unsubscribe(a.endpoint)).toBe(true);
    expect(await channel.unsubscribe(a.endpoint)).toBe(false);
    expect(channel.subscriptions().map((s) => s.endpoint)).toEqual([b.endpoint]);
    // Subscribing never generated keys.
    expect(fs.existsSync(path.join(stateDir, VAPID_FILE))).toBe(false);
  });

  it('notify pushes the service worker payload to EVERY subscription, with VAPID and aes128gcm', async () => {
    const stateDir = tmp();
    const service = fakePushService();
    const channel = new WebPushChannel({ stateDir, subject: 'mailto:x@y.z', fetch: service.fetch });
    const browsers = ['https://push.one.example/a', 'https://push.two.example/b', 'https://push.one.example/c'].map(fakeBrowser);
    for (const b of browsers) await channel.subscribe(b.subscription);

    const r = await channel.notify({ title: 'Deploy finished', body: 'all green', source: 'my-app', navigate: 'session-123' });
    expect(r).toEqual({ ok: true, detail: '3 devices' });
    expect(service.sent.map((s) => s.url).sort()).toEqual(browsers.map((b) => b.subscription.endpoint).sort());
    for (const sent of service.sent) {
      const browser = browsers.find((b) => b.subscription.endpoint === sent.url)!;
      expect(JSON.parse(browser.decrypt(sent.body))).toEqual({
        web_push: 8030,
        notification: { title: 'my-app: Deploy finished', body: 'all green', navigate: '/#session-123' },
      });
      expect(sent.headers['Content-Encoding']).toBe('aes128gcm');
      expect(sent.headers.TTL).toBe(String(24 * 3600));
      expect(sent.headers.Authorization).toMatch(/^vapid t=.+, k=/);
      expect(sent.headers.Authorization).toContain(`k=${channel.existingPublicKey()}`);
    }
    expect(webPushPayload({ title: 't', body: 'b', source: '', navigate: 'x' }).notification.title).toBe('t');
  });

  it('404 and 410 prune that subscription; other failures keep it', async () => {
    const stateDir = tmp();
    const service = fakePushService((url) => (url.endsWith('/gone') ? 410 : url.endsWith('/missing') ? 404 : url.endsWith('/flaky') ? 500 : 201));
    const channel = new WebPushChannel({ stateDir, subject: 'mailto:x@y.z', fetch: service.fetch });
    for (const e of ['ok', 'gone', 'missing', 'flaky']) await channel.subscribe(fakeBrowser(`https://push.example/${e}`).subscription);
    const r = await channel.notify({ title: 't', body: 'b', source: 's', navigate: 'x' });
    expect(r).toEqual({ ok: true, detail: '1 device' });
    expect(channel.subscriptions().map((s) => s.endpoint).sort()).toEqual(['https://push.example/flaky', 'https://push.example/ok']);
  });

  it('notify with no subscription, or none accepted, is a clear failure', async () => {
    const stateDir = tmp();
    const service = fakePushService(() => 500);
    const channel = new WebPushChannel({ stateDir, subject: 'mailto:x@y.z', fetch: service.fetch });
    expect(await channel.notify({ title: 't', body: 'b', source: 's', navigate: 'x' })).toEqual({
      ok: false,
      error: expect.stringContaining('no device is subscribed'),
    });
    expect(service.sent).toHaveLength(0);
    await channel.subscribe(fakeBrowser('https://push.example/a').subscription);
    expect(await channel.notify({ title: 't', body: 'b', source: 's', navigate: 'x' })).toEqual({
      ok: false,
      error: 'no push was accepted (HTTP 500)',
    });
  });

  it('validates a posted subscription', () => {
    const good = fakeBrowser('https://push.example/a').subscription;
    expect(validateSubscription(good)).toEqual({ ok: true, subscription: good });
    expect(validateSubscription(null).ok).toBe(false);
    expect(validateSubscription({ ...good, endpoint: 'ftp://x' }).ok).toBe(false);
    expect(validateSubscription({ ...good, keys: { p256dh: 'AAAA', auth: good.keys.auth } }).ok).toBe(false);
    expect(validateSubscription({ endpoint: good.endpoint }).ok).toBe(false);
  });
});
