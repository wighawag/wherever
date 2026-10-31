import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AssistantChannel, ChannelNotification, ChannelNotifyResult } from './assistant-channels.js';

/**
 * Web Push, sent IN-PROCESS by wherever (ADR 0017): the first transport behind
 * the assistant's channel seam (assistant-channels.ts). It implements `notify`
 * only: a push carries a deliberate `assistant_notify`, never a reply (ADR 0014).
 *
 * Dependency-free on purpose (no `web-push` package, so `pnpm-lock.yaml` and the
 * Nix `pnpmDepsHash` are untouched, ADR 0008): `node:crypto` does RFC 8291
 * message encryption (`aes128gcm`, RFC 8188) and RFC 8292 VAPID (an ES256 JWT).
 * The encryption is checked against RFC 8291's Appendix A test vector.
 *
 * State, all in the STATE dir (ADR 0006), all mode 0600 (private key, and each
 * subscription's auth secret), written atomically (tmp + rename):
 * - `assistant-vapid.json`: the VAPID keypair, generated on FIRST USE (the first
 *   time the web asks for the public key to subscribe, or a send). Never at
 *   start, so an active assistant nobody subscribes to writes nothing.
 * - `assistant-push-subscriptions.json`: every registered subscription. A push
 *   goes to EVERY one; a 404 / 410 answer from the push service prunes it.
 *
 * Built only while the assistant is ACTIVE (configured AND this server holds the
 * folder lock), like the scheduler; see `server/src/index.ts`.
 */

export const VAPID_FILE = 'assistant-vapid.json';
export const SUBSCRIPTIONS_FILE = 'assistant-push-subscriptions.json';

/** The routing origin / channel name of Web Push (it never originates a user message). */
export const WEB_PUSH_CHANNEL = 'webpush';

/** A browser `PushSubscription.toJSON()`, as the web POSTs it. */
export interface PushSubscriptionRecord {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url (the browser's `applicationServerKey`). */
  publicKey: string;
  /** The private scalar `d`, base64url. */
  privateKey: string;
}

/** The service worker's declarative payload (`DeclarativePushNotification` in web/src/service-worker/index.ts). */
export interface DeclarativePushPayload {
  web_push: 8030;
  notification: { title: string; body: string; navigate: string };
}

/** The HTTP boundary a push is sent through (the global `fetch` by default; mocked in tests). */
export type PushFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number; text(): Promise<string> }>;

// ---------------------------------------------------------------------------
// base64url

export function b64urlEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/=+$/, ''), 'base64url');
}

// ---------------------------------------------------------------------------
// RFC 8291 encryption

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** Record size written in the header (RFC 8188); one record is always enough for a notification. */
const RECORD_SIZE = 4096;

/**
 * Encrypt `plaintext` for one subscription (RFC 8291, `aes128gcm`). `salt` and
 * the application server's ephemeral keypair are random unless given (the test
 * vector seam). Returns the full request body: the RFC 8188 header (salt, record
 * size, key id = the ephemeral public key) followed by the single record.
 */
export function encryptPushPayload(
  plaintext: Uint8Array,
  uaPublicB64: string,
  authSecretB64: string,
  opts: { salt?: Uint8Array; asPrivateKey?: Uint8Array } = {},
): Buffer {
  const uaPublic = b64urlDecode(uaPublicB64);
  const authSecret = b64urlDecode(authSecretB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('the subscription p256dh key is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('the subscription auth secret is not 16 bytes');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivateKey) ecdh.setPrivateKey(opts.asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? crypto.randomBytes(16);

  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // The last (only) record ends with the 0x02 padding delimiter, no extra padding.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

// ---------------------------------------------------------------------------
// RFC 8292 VAPID

/** A fresh VAPID keypair. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64urlEncode(ecdh.getPublicKey()), privateKey: b64urlEncode(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject(keys: VapidKeys): crypto.KeyObject {
  const pub = b64urlDecode(keys.publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.subarray(1, 33)), y: b64urlEncode(pub.subarray(33, 65)), d: keys.privateKey },
    format: 'jwk',
  });
}

/**
 * The `Authorization` header value for a push to `endpoint`: `vapid t=<JWT>,
 * k=<public key>`, the JWT signed ES256 with `aud` = the endpoint's origin,
 * `exp` = now + 12 h (the RFC's 24 h ceiling, with margin), `sub` = `subject`.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number = Date.now()): string {
  const header = b64urlEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })),
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: vapidPrivateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64urlEncode(signature)}, k=${keys.publicKey}`;
}

/**
 * The VAPID `sub` claim: the configured `assistantWebPush.subject` when it is a
 * `mailto:` or http(s) URL, else the configured `publicUrl`, else the project's
 * homepage. Decision: a push service only uses it as a contact for the sender
 * operator, so a fallback that always validates beats refusing to push; the
 * subject is not a secret and changing it needs no new keys.
 */
export function resolveVapidSubject(config: { subject?: unknown; publicUrl?: unknown }): string {
  const ok = (v: unknown): v is string => typeof v === 'string' && /^(mailto:\S+|https?:\/\/\S+)$/.test(v.trim());
  if (ok(config.subject)) return config.subject.trim();
  if (config.subject !== undefined) console.warn(`[wherever] ignoring assistantWebPush.subject=${JSON.stringify(config.subject)} (not a mailto: or http(s) URL)`);
  if (ok(config.publicUrl)) return new URL(config.publicUrl.trim()).origin;
  return 'https://wherever.dev';
}

// ---------------------------------------------------------------------------
// Stores

function writeAtomic0600(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

/** Validate a POSTed subscription; the error names what is wrong. */
export function validateSubscription(input: unknown): { ok: true; subscription: PushSubscriptionRecord } | { ok: false; error: string } {
  const s = input as Partial<PushSubscriptionRecord> | null;
  if (!s || typeof s !== 'object') return { ok: false, error: 'expected a PushSubscription JSON object' };
  if (typeof s.endpoint !== 'string') return { ok: false, error: 'missing "endpoint"' };
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return { ok: false, error: '"endpoint" is not a URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: '"endpoint" must be an http(s) URL' };
  const keys = s.keys as Partial<PushSubscriptionRecord['keys']> | undefined;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return { ok: false, error: 'missing "keys.p256dh" / "keys.auth"' };
  if (b64urlDecode(keys.p256dh).length !== 65) return { ok: false, error: '"keys.p256dh" is not a P-256 public key' };
  if (b64urlDecode(keys.auth).length !== 16) return { ok: false, error: '"keys.auth" is not a 16-byte secret' };
  return {
    ok: true,
    subscription: {
      endpoint: s.endpoint,
      expirationTime: typeof s.expirationTime === 'number' ? s.expirationTime : null,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    },
  };
}

export interface WebPushStoreOptions {
  stateDir: string;
  /** The VAPID `sub` claim (see `resolveVapidSubject`). */
  subject: string;
  fetch?: PushFetch;
  /** Push TTL in seconds (how long the push service keeps an undelivered message). Default 24 h. */
  ttlSeconds?: number;
}

/** One send's outcome per subscription. */
export interface PushSendOutcome {
  endpoint: string;
  status: number | null;
  /** True when the push service accepted it (2xx). */
  delivered: boolean;
  /** True when the subscription was removed (404 / 410). */
  pruned: boolean;
  error?: string;
}

/**
 * The Web Push channel: VAPID keys, the subscription store and the sender. Also
 * what the token-gated `/push/*` routes drive (index.ts).
 */
export class WebPushChannel implements AssistantChannel {
  readonly name = WEB_PUSH_CHANNEL;
  private readonly vapidPath: string;
  private readonly subscriptionsPath: string;
  private readonly subject: string;
  private readonly fetchImpl: PushFetch;
  private readonly ttlSeconds: number;
  private keys: VapidKeys | null = null;
  /** Serialises read-modify-write of the subscription file. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(opts: WebPushStoreOptions) {
    this.vapidPath = path.join(opts.stateDir, VAPID_FILE);
    this.subscriptionsPath = path.join(opts.stateDir, SUBSCRIPTIONS_FILE);
    this.subject = opts.subject;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
    this.ttlSeconds = opts.ttlSeconds ?? 24 * 3600;
  }

  start(): void {}
  stop(): void {}

  /** The public key IF it was already generated (status); never generates. */
  existingPublicKey(): string | null {
    return this.readKeys()?.publicKey ?? null;
  }

  /** The public key, generating (and persisting, 0600) the keypair on first use. */
  publicKey(): string {
    return this.ensureKeys().publicKey;
  }

  subscriptions(): PushSubscriptionRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.subscriptionsPath, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as { subscriptions?: unknown };
      const list = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      return list.flatMap((s) => {
        const v = validateSubscription(s);
        return v.ok ? [v.subscription] : [];
      });
    } catch {
      console.warn(`[wherever] web push: ignoring an unreadable ${this.subscriptionsPath}`);
      return [];
    }
  }

  isSubscribed(endpoint: string): boolean {
    return this.subscriptions().some((s) => s.endpoint === endpoint);
  }

  /** Add or replace (same endpoint) a subscription. */
  subscribe(sub: PushSubscriptionRecord): Promise<number> {
    return this.mutate((list) => [...list.filter((s) => s.endpoint !== sub.endpoint), sub]);
  }

  /** Remove a subscription; resolves true when it was registered. */
  async unsubscribe(endpoint: string): Promise<boolean> {
    let removed = false;
    await this.mutate((list) => {
      const next = list.filter((s) => s.endpoint !== endpoint);
      removed = next.length !== list.length;
      return next;
    });
    return removed;
  }

  /**
   * Send one push to EVERY subscription, in parallel. A 404 / 410 prunes that
   * subscription (the browser dropped it); any other failure is logged and kept.
   */
  async send(payload: DeclarativePushPayload): Promise<PushSendOutcome[]> {
    const subs = this.subscriptions();
    if (subs.length === 0) return [];
    const keys = this.ensureKeys();
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const outcomes = await Promise.all(subs.map((s) => this.sendOne(s, body, keys)));
    const gone = new Set(outcomes.filter((o) => o.pruned).map((o) => o.endpoint));
    if (gone.size > 0) {
      await this.mutate((list) => list.filter((s) => !gone.has(s.endpoint)));
      console.log(`[wherever] web push: pruned ${gone.size} expired subscription(s)`);
    }
    return outcomes;
  }

  /**
   * The channel's `notify`: one declarative push whose tap opens
   * `/#<sessionId>`. The title is prefixed with the source (decision, so the
   * device shows WHO notified, like Telegram's `🔔 <source>: <title>`).
   */
  async notify(n: ChannelNotification): Promise<ChannelNotifyResult> {
    const subs = this.subscriptions();
    if (subs.length === 0) {
      return { ok: false, error: 'no device is subscribed (turn on push notifications in the wherever settings)' };
    }
    const outcomes = await this.send(webPushPayload(n));
    const delivered = outcomes.filter((o) => o.delivered).length;
    if (delivered === 0) {
      const why = outcomes.map((o) => o.error ?? `HTTP ${o.status}`).join('; ');
      return { ok: false, error: `no push was accepted (${why})` };
    }
    return { ok: true, detail: `${delivered} device${delivered === 1 ? '' : 's'}` };
  }

  // -------------------------------------------------------------------------

  private async sendOne(sub: PushSubscriptionRecord, body: Buffer, keys: VapidKeys): Promise<PushSendOutcome> {
    const base = { endpoint: sub.endpoint };
    let encrypted: Buffer;
    try {
      encrypted = encryptPushPayload(body, sub.keys.p256dh, sub.keys.auth);
    } catch (err) {
      return { ...base, status: null, delivered: false, pruned: false, error: errMessage(err) };
    }
    try {
      const res = await this.fetchImpl(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuthorization(sub.endpoint, keys, this.subject),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(this.ttlSeconds),
          // A deliberate notification: ask the push service to wake the device.
          Urgency: 'high',
        },
        body: encrypted,
      });
      if (res.status >= 200 && res.status < 300) return { ...base, status: res.status, delivered: true, pruned: false };
      const pruned = res.status === 404 || res.status === 410;
      const text = await res.text().catch(() => '');
      if (!pruned) console.warn(`[wherever] web push: ${new URL(sub.endpoint).origin} answered HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { ...base, status: res.status, delivered: false, pruned, error: `HTTP ${res.status}` };
    } catch (err) {
      console.warn(`[wherever] web push: sending to ${safeOrigin(sub.endpoint)} failed: ${errMessage(err)}`);
      return { ...base, status: null, delivered: false, pruned: false, error: errMessage(err) };
    }
  }

  private readKeys(): VapidKeys | null {
    if (this.keys) return this.keys;
    let raw: string;
    try {
      raw = fs.readFileSync(this.vapidPath, 'utf8');
    } catch {
      return null;
    }
    try {
      const k = JSON.parse(raw) as Partial<VapidKeys>;
      if (typeof k.publicKey === 'string' && typeof k.privateKey === 'string') {
        this.keys = { publicKey: k.publicKey, privateKey: k.privateKey };
        return this.keys;
      }
    } catch {}
    console.warn(`[wherever] web push: ${this.vapidPath} is unreadable`);
    return null;
  }

  /**
   * The keypair, generated once. An unreadable existing file is NOT replaced
   * (every subscription is bound to the old public key, so a silent rotation
   * would break every device): it throws, naming the file to fix or remove.
   */
  private ensureKeys(): VapidKeys {
    const existing = this.readKeys();
    if (existing) return existing;
    if (fs.existsSync(this.vapidPath)) {
      throw new Error(`${this.vapidPath} is unreadable; fix it, or delete it to generate new keys (every device then has to subscribe again)`);
    }
    const keys = generateVapidKeys();
    writeAtomic0600(this.vapidPath, JSON.stringify({ ...keys, createdAt: new Date().toISOString() }, null, 2) + '\n');
    console.log(`[wherever] web push: generated a VAPID keypair in ${this.vapidPath}`);
    this.keys = keys;
    return keys;
  }

  private mutate(fn: (list: PushSubscriptionRecord[]) => PushSubscriptionRecord[]): Promise<number> {
    const run = this.writes.then(() => {
      const next = fn(this.subscriptions());
      writeAtomic0600(this.subscriptionsPath, JSON.stringify({ subscriptions: next }, null, 2) + '\n');
      return next.length;
    });
    this.writes = run.catch(() => {});
    return run;
  }
}

/** The declarative payload for a notification (the service worker's `DeclarativePushNotification`). */
export function webPushPayload(n: ChannelNotification): DeclarativePushPayload {
  return {
    web_push: 8030,
    notification: {
      title: n.source ? `${n.source}: ${n.title}` : n.title,
      body: n.body,
      navigate: `/#${encodeURIComponent(n.navigate)}`,
    },
  };
}

function safeOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'an invalid endpoint';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
