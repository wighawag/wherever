import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startHarness, type Harness, type TestClient } from './harness.js';
import { b64urlEncode } from '../src/web-push.ts';

/**
 * The `cli_request` ops behind the extension's `assistant_*` tool twins against
 * the REAL server (ADR 0016). A test client plays the `@wherever-dev/pi`
 * extension: it registers a CLI-bridge session and calls each op the way a twin
 * does. Each op has the same effect as its server tool, with the ORIGIN being
 * that CLI session (resolved from the registration):
 *  - `schedule_add` writes the assistant's `schedule.json` with the CLI session's
 *    id and cwd as origin; `schedule_list` marks it as the caller's; `schedule_remove` removes it;
 *  - `set_timezone` changes the user's timezone and pushes `assistant_info_changed`;
 *  - `notify` delivers a push opening the CLI session, and fails clearly with no device;
 *  - with `assistantFolder` unset every op answers "not configured" and nothing is written.
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
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-twins-srv-')));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function boot(root: string, config: Record<string, unknown>): Promise<Harness> {
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  const h = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir, TZ: 'UTC' } });
  cleanups.push(() => h.cleanup());
  return h;
}

/** A CLI session file with a header, so its session id is known. */
function sessionFileWithHeader(dir: string, cwd: string): { sessionFile: string; sessionId: string } {
  const sessionId = crypto.randomUUID();
  fs.mkdirSync(dir, { recursive: true });
  const sessionFile = path.join(dir, `2026-10-30T00-00-00-000Z_${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }) + '\n');
  return { sessionFile, sessionId };
}

async function register(h: Harness, sessionFile: string, cwd: string): Promise<TestClient> {
  const cli = await h.connect(crypto.randomUUID());
  await cli.waitForType('connected');
  cli.send({ type: 'cli_register', sessionFile, cwd, model: 'fake:fake-model', isStreaming: false, isNew: false, capabilities: ['agent_settled', 'cli_request'] });
  await h.waitForActive(sessionFile);
  return cli;
}

async function request(cli: TestClient, op: string, args?: unknown): Promise<any> {
  const id = crypto.randomUUID();
  cli.send({ type: 'cli_request', id, op, ...(args === undefined ? {} : { args }) });
  return cli.waitFor((m) => m.type === 'cli_response' && m.id === id);
}

/** A push service mocked at HTTP: every POST answers 201. */
async function fakePushService() {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push(req.url ?? '');
      res.writeHead(201);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { received, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function subscription(endpoint: string) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, expirationTime: null, keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(crypto.randomBytes(16)) } };
}

describe('assistant tool twin ops (real server)', () => {
  it('each op round-trips with the server tool effect, origin = the CLI session', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, { assistantFolder: folder });
    const code = path.join(root, 'code');
    fs.mkdirSync(code, { recursive: true });
    const { sessionFile, sessionId } = sessionFileWithHeader(path.join(root, 'cli-sessions'), code);
    const cli = await register(h, sessionFile, code);

    // schedule_add: written to the assistant's schedule.json, origin stamped from the registration.
    const add = await request(cli, 'schedule_add', {
      name: 'check CI',
      prompt: 'Check CI and tell me',
      mode: 'isolated',
      cron: '0 8 * * *',
      originSessionId: 'forged',
    });
    expect(add.ok).toBe(true);
    expect(add.result.text).toMatch(/^Scheduled "check CI" \(id [^)]+\)/);
    const jobId = add.result.details.job.id as string;
    const schedule = JSON.parse(fs.readFileSync(path.join(folder, 'schedule.json'), 'utf8'));
    const jobs = Array.isArray(schedule) ? schedule : schedule.jobs;
    expect(jobs).toEqual([
      expect.objectContaining({ id: jobId, name: 'check CI', mode: 'isolated', cron: '0 8 * * *', originSessionId: sessionId, originCwd: code }),
    ]);

    // Bad input is an error that writes nothing.
    const bad = await request(cli, 'schedule_add', { name: 'x', prompt: '!rm -rf /', mode: 'inline', at: 'now' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/"!"/);

    // schedule_list marks the CLI session's job as the caller's.
    const list = await request(cli, 'schedule_list', {});
    expect(list.ok).toBe(true);
    expect(list.result.text).toContain(`[yours] ${jobId} "check CI"`);

    // set_timezone: changed, and pushed to the bridge.
    const tz = await request(cli, 'set_timezone', { timezone: 'Asia/Tokyo' });
    expect(tz).toMatchObject({ ok: true, result: { details: { timezone: 'Asia/Tokyo', changed: true } } });
    const push = await cli.waitFor((m) => m.type === 'assistant_info_changed' && m.timezone === 'Asia/Tokyo');
    expect(push.assistantFolder).toBe(folder);
    expect((await request(cli, 'assistant_info')).result).toEqual({ assistantFolder: folder, timezone: 'Asia/Tokyo' });

    // schedule_remove removes it; an unknown id is an error.
    expect(await request(cli, 'schedule_remove', { id: jobId })).toMatchObject({ ok: true, result: { text: `Removed job ${jobId}.` } });
    const after = JSON.parse(fs.readFileSync(path.join(folder, 'schedule.json'), 'utf8'));
    expect(Array.isArray(after) ? after : after.jobs).toEqual([]);
    expect((await request(cli, 'schedule_remove', { id: jobId })).ok).toBe(false);

    // notify: no device subscribed yet is a clear failure.
    const none = await request(cli, 'notify', { title: 'Deploy finished', body: 'all green' });
    expect(none.ok).toBe(false);
    expect(String(none.error).length).toBeGreaterThan(0);

    // With a device: delivered, and a tap opens the CLI session.
    const pushService = await fakePushService();
    const sub = await fetch(`http://127.0.0.1:${h.port}/push/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription(`${pushService.base}/ok/phone`)),
    });
    expect(sub.status).toBe(200);
    const sent = await request(cli, 'notify', { title: 'Deploy finished', body: 'all green' });
    expect(sent.ok).toBe(true);
    expect(sent.result.text).toContain(`opens session ${sessionId}`);
    expect(sent.result.details.target).toMatchObject({ sessionId, via: 'caller' });
    expect(sent.result.details.source).toBe('code');
    expect(pushService.received).toEqual(['/ok/phone']);
  }, 60_000);

  it('with assistantFolder unset every op answers "not configured" and nothing is written', async () => {
    const root = tmp();
    const h = await boot(root, {});
    const code = path.join(root, 'code');
    fs.mkdirSync(code, { recursive: true });
    const { sessionFile } = sessionFileWithHeader(path.join(root, 'cli-sessions'), code);
    const cli = await register(h, sessionFile, code);
    for (const op of ['schedule_add', 'schedule_list', 'schedule_remove', 'set_timezone', 'notify']) {
      const res = await request(cli, op, { name: 'x', prompt: 'y', mode: 'inline', at: 'now', id: 'x', timezone: 'Asia/Tokyo', title: 't', body: 'b' });
      expect(res.ok, op).toBe(false);
      expect(res.error, op).toMatch(/not configured/);
    }
    expect(fs.readdirSync(path.join(root, 'state'))).toEqual([]);
    expect(fs.readdirSync(code)).toEqual([]);
  }, 60_000);
});
