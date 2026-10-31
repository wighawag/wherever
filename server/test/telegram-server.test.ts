import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';
import { FakeBotApi } from './fake-bot-api.ts';
import { TELEGRAM_OFFSET_FILE, TELEGRAM_PAIRING_FILE } from '../src/telegram-channel.ts';

/**
 * The Telegram channel against the REAL server (real pi, fake LLM), with the
 * Bot API mocked at the HTTP boundary (a local HTTP server the config's
 * `assistantTelegram.apiBaseUrl` points at):
 *  - active + enabled: the token comes from the environment, both token
 *    variables are gone from the agent's shell, pairing works only with the
 *    code the web shows, re-pair issues a new one, and the polling offset
 *    survives a restart;
 *  - an unreadable token file disables Telegram loudly and the server runs on;
 *  - `assistantFolder` unset, or Telegram not enabled: the token file is not
 *    read, nothing is logged, nothing polls;
 *  - the folder lock held by another server: no polling, nothing written.
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
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-tg-srv-')));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function botApi(): Promise<{ api: FakeBotApi; url: string }> {
  const api = new FakeBotApi(100);
  const url = await api.listen();
  cleanups.push(() => api.close());
  return { api, url };
}

async function boot(root: string, name: string, config: Record<string, unknown>, env: Record<string, string> = {}): Promise<Harness> {
  const configDir = path.join(root, `${name}-config`);
  const stateDir = path.join(root, `${name}-state`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  const h = await startHarness({
    env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir, TZ: 'UTC', WHEREVER_TELEGRAM_TOKEN: '', WHEREVER_TELEGRAM_TOKEN_FILE: '', ...env },
  });
  cleanups.push(() => h.cleanup());
  return h;
}

async function assistantStatus(port: number): Promise<any> {
  return (await (await fetch(`http://127.0.0.1:${port}/config`)).json()).assistant;
}

async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function client(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

/** Run `command` through the agent's own `bash` tool; returns the tool result as the LLM saw it. */
async function agentBash(h: Harness, command: string): Promise<string> {
  const c = await client(h);
  c.send({ type: 'session_new', cwd: c.workspace, forceNew: true });
  const created = await c.waitFor((m) => m.type === 'session_created');
  const before = h.fake.requests().length;
  h.fake.queue({ kind: 'tool-call', toolName: 'bash', input: { command }, toolCallId: 'toolu_env' });
  h.setNext({ kind: 'reply', text: 'done' });
  c.send({ type: 'message', message: 'run it', sessionId: created.sessionId });
  await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant' && m.content === 'done', 30_000);
  const reqs = h.fake.requests().slice(before);
  return JSON.stringify(reqs[reqs.length - 1]?.messages ?? []);
}

const TOKEN = '111:env-secret-token';

describe('Telegram channel (real server)', () => {
  it('active + enabled: env token, scrubbed env, pairing by code only, re-pair, offset survives a restart', async () => {
    const root = tmp();
    const { api, url } = await botApi();
    const folder = path.join(root, 'assistant');
    const stateDir = path.join(root, 'srv-state');
    const config = { assistantFolder: folder, assistantTelegram: { enabled: true, apiBaseUrl: url, token: '999:config-token' } };
    const fileToken = path.join(root, 'tg-token');
    fs.writeFileSync(fileToken, '222:file-token\n');
    let h = await boot(root, 'srv', config, { WHEREVER_TELEGRAM_TOKEN: TOKEN, WHEREVER_TELEGRAM_TOKEN_FILE: fileToken });

    // The environment variable wins.
    await until(() => api.of('getUpdates', TOKEN).length > 0);
    expect(api.calls.every((c) => c.token === TOKEN)).toBe(true);
    let status = await assistantStatus(h.port);
    expect(status.telegram).toMatchObject({ enabled: true, state: 'unpaired', bot: '@wherever_test_bot' });
    const code: string = status.telegram.code;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(h.output()).not.toContain('env-secret-token');

    // Both variables are gone from what the agent's shell inherits.
    const env = await agentBash(h, 'env');
    expect(env).toContain('PATH=');
    expect(env).not.toContain('WHEREVER_TELEGRAM_TOKEN');
    expect(env).not.toContain('env-secret-token');

    // Strangers and wrong codes are ignored (not answered); the right code pairs.
    api.message(7, '/start');
    api.message(7, '/pair WRONGCD2');
    api.message(7, `/pair ${code.toLowerCase()}`, { username: 'me' });
    await until(async () => (await assistantStatus(h.port)).telegram.state === 'paired');
    status = await assistantStatus(h.port);
    expect(status.telegram).toMatchObject({ state: 'paired', user: { id: '7', name: '@me', source: 'pairing' } });
    expect(status.telegram.code).toBeUndefined();
    await until(() => api.of('sendMessage').length === 1);
    expect(api.of('sendMessage')[0]!.params.chat_id).toBe(7);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, TELEGRAM_PAIRING_FILE), 'utf8'))).toMatchObject({ userId: '7' });

    // Paired: /start and /pair are refused, other users ignored.
    api.message(8, `/pair ${code}`);
    api.message(7, '/start');
    await until(() => api.of('sendMessage').length === 2);
    expect(api.of('sendMessage')[1]!.params.text).toMatch(/already paired/);

    // Re-pair is token-gated like the rest of the API... (no token here: open) and issues a new code.
    const r = await fetch(`http://127.0.0.1:${h.port}/telegram/repair`, { method: 'POST' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.telegram.state).toBe('unpaired');
    expect(body.telegram.code).not.toBe(code);
    expect(fs.existsSync(path.join(stateDir, TELEGRAM_PAIRING_FILE))).toBe(false);

    // Offset: everything so far is confirmed; a message sent while down is seen once after the restart.
    await until(() => api.pendingIds().length === 0);
    await until(() => fs.existsSync(path.join(stateDir, TELEGRAM_OFFSET_FILE)));
    await new Promise((r) => setTimeout(r, 300));
    const stored = JSON.parse(fs.readFileSync(path.join(stateDir, TELEGRAM_OFFSET_FILE), 'utf8'));
    await h.stop();
    const down = api.message(9, `/pair ${body.telegram.code}`);
    expect(stored.offset).toBe(down);
    const callsBefore = api.calls.length;
    h = await boot(root, 'srv', config, { WHEREVER_TELEGRAM_TOKEN: TOKEN });
    await until(() => api.calls.slice(callsBefore).some((c) => c.method === 'getUpdates'));
    expect(api.calls.slice(callsBefore).find((c) => c.method === 'getUpdates')!.params.offset).toBe(stored.offset);
    // Seen exactly once by the new server (not lost, not replayed). A restart
    // issues a NEW code, so the code sent while down is stale and ignored.
    await until(() => h.output().includes('ignored a message from user 9'));
    await new Promise((r) => setTimeout(r, 300));
    expect(h.output().split('ignored a message from user 9').length - 1).toBe(1);
    expect((await assistantStatus(h.port)).telegram.state).toBe('unpaired');
  }, 180_000);

  it('an unreadable token file disables Telegram loudly; the server keeps running', async () => {
    const root = tmp();
    const { api, url } = await botApi();
    const h = await boot(
      root,
      'srv',
      { assistantFolder: path.join(root, 'assistant'), assistantTelegram: { enabled: true, apiBaseUrl: url, token: '999:config-token' } },
      { WHEREVER_TELEGRAM_TOKEN_FILE: path.join(root, 'never-mounted') },
    );
    const status = await assistantStatus(h.port);
    expect(status.active).toBe(true);
    expect(status.telegram).toMatchObject({ enabled: true, state: 'disabled', error: expect.stringMatching(/could not be read/) });
    expect(h.output()).toMatch(/ERROR: Telegram is DISABLED: WHEREVER_TELEGRAM_TOKEN_FILE is set to .*never-mounted/);
    expect((await fetch(`http://127.0.0.1:${h.port}/health`)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(api.calls).toEqual([]);
    // No re-pair route without a running channel: it answers like any unknown route.
    const unknown = await fetch(`http://127.0.0.1:${h.port}/no-such-route-xyz`, { method: 'POST' });
    const repairRoute = await fetch(`http://127.0.0.1:${h.port}/telegram/repair`, { method: 'POST' });
    expect(repairRoute.status).toBe(unknown.status);
    expect(await repairRoute.text()).toBe((await unknown.text()).replace('/no-such-route-xyz', '/telegram/repair'));
  }, 90_000);

  it('assistantFolder unset: the token file is not read, nothing is logged, nothing polls or is written', async () => {
    const root = tmp();
    const { api, url } = await botApi();
    const h = await boot(root, 'srv', { assistantTelegram: { enabled: true, apiBaseUrl: url } }, { WHEREVER_TELEGRAM_TOKEN_FILE: path.join(root, 'never-mounted') });
    expect(await assistantStatus(h.port)).toEqual({ configured: false, folder: null, active: false, lock: null });
    await new Promise((r) => setTimeout(r, 300));
    expect(api.calls).toEqual([]);
    expect(h.output()).not.toMatch(/telegram/i);
    expect(fs.readdirSync(path.join(root, 'srv-state')).filter((f) => f.includes('telegram'))).toEqual([]);
    // The variable is scrubbed regardless.
    expect(await agentBash(h, 'env')).not.toContain('WHEREVER_TELEGRAM_TOKEN');
  }, 90_000);

  it('Telegram not enabled: the token file is not read, nothing is logged, the status says disabled', async () => {
    const root = tmp();
    const { api, url } = await botApi();
    const h = await boot(
      root,
      'srv',
      { assistantFolder: path.join(root, 'assistant'), assistantTelegram: { apiBaseUrl: url } },
      { WHEREVER_TELEGRAM_TOKEN_FILE: path.join(root, 'never-mounted') },
    );
    const status = await assistantStatus(h.port);
    expect(status.active).toBe(true);
    expect(status.telegram).toEqual({ enabled: false, state: 'disabled' });
    await new Promise((r) => setTimeout(r, 300));
    expect(api.calls).toEqual([]);
    expect(h.output()).not.toMatch(/telegram/i);
  }, 90_000);

  it('folder lock held by another server: no polling, no offset or pairing state written', async () => {
    const root = tmp();
    const { api, url } = await botApi();
    const folder = path.join(root, 'assistant');
    const first = await boot(root, 'first', { assistantFolder: folder, assistantTelegram: { enabled: true, apiBaseUrl: url } }, { WHEREVER_TELEGRAM_TOKEN: '1:first' });
    await until(() => api.of('getUpdates', '1:first').length > 0);
    const second = await boot(root, 'second', { assistantFolder: folder, assistantTelegram: { enabled: true, apiBaseUrl: url } }, { WHEREVER_TELEGRAM_TOKEN: '2:second' });
    const status = await assistantStatus(second.port);
    expect(status.lock.state).toBe('refused');
    expect(status.telegram).toBeUndefined();
    // The first server keeps polling; the second never calls the Bot API.
    api.message(7, 'hello');
    await until(() => api.pendingIds().length === 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(api.calls.filter((c) => c.token === '2:second')).toEqual([]);
    const secondState = fs.readdirSync(path.join(root, 'second-state'));
    expect(secondState.filter((f) => f.includes('telegram'))).toEqual([]);
    expect(first.port).toBeGreaterThan(0);
  }, 120_000);
});
