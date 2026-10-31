import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';
import { FakeBotApi } from './fake-bot-api.ts';

/**
 * Telegram FILES against the REAL server (real pi, fake LLM), with the Bot API
 * mocked at the HTTP boundary (`assistantTelegram.apiBaseUrl`) and the user
 * paired through `assistantTelegram.userId`:
 *  - a document sent on Telegram lands in the configured upload dir and the
 *    assistant reads its path in the message, the caption as the text;
 *  - `attach_file` in the Telegram-routed reply sends the file with
 *    `sendDocument` (multipart, real bytes);
 *  - `attach_file` in a web-started turn sends nothing to Telegram.
 * Isolation: temp assistant folder, config, state and upload dirs; the real
 * ~/.wherever is asserted untouched.
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

const USER = 7;
const TOKEN = '222:files-token';

async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function lastUserText(body: Record<string, any> | undefined): string {
  const msgs = (body?.messages ?? []) as Array<{ role: string; content: unknown }>;
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (p?.type === 'text' ? p.text : '')).join('');
  return '';
}

async function webClient(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

describe('Telegram files (real server)', () => {
  it('a document in lands in the upload dir as a path; attach_file out on Telegram; never from a web turn', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-tg-files-srv-')));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const api = new FakeBotApi(100);
    const url = await api.listen();
    cleanups.push(() => api.close());
    const configDir = path.join(root, 'config');
    const stateDir = path.join(root, 'state');
    const folder = path.join(root, 'assistant');
    const uploads = path.join(root, 'uploads');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        assistantFolder: folder,
        uploads: { type: 'custom', dir: uploads },
        assistantTelegram: { enabled: true, apiBaseUrl: url, userId: USER },
      }),
    );
    const h = await startHarness({
      initial: { kind: 'reply', text: 'ok' },
      env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir, TZ: 'UTC', WHEREVER_TELEGRAM_TOKEN: TOKEN, WHEREVER_TELEGRAM_TOKEN_FILE: '' },
    });
    cleanups.push(() => h.cleanup());
    await until(() => api.of('getUpdates').length > 0, 30_000, 'polling');
    const sent = () => api.of('sendMessage').map((c) => String(c.params.text));

    // 1. Inbound: a document with a caption.
    h.setNext({ kind: 'reply', text: 'got your file' });
    const fileId = api.addFile('line one\nline two\n');
    api.media(USER, { document: { file_id: fileId, file_name: 'notes.txt', mime_type: 'text/plain', file_size: 18 }, caption: 'summarise this' });
    await until(() => sent().includes('got your file'), 60_000, 'the reply to the file');
    const saved = fs.readdirSync(uploads);
    expect(saved).toHaveLength(1);
    const savedPath = path.join(uploads, saved[0]!);
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('line one\nline two\n');
    expect(lastUserText(h.fake.requests().at(-1))).toBe(`summarise this\n\n[Uploaded file: ${savedPath}]`);

    // 2. Outbound: attach_file in the Telegram-routed reply.
    const out = path.join(folder, 'report.txt');
    fs.writeFileSync(out, 'the report');
    h.fake.queue({ kind: 'tool-call', toolName: 'attach_file', input: { path: out }, toolCallId: 'toolu_tgattach' });
    h.setNext({ kind: 'reply', text: 'attached it' });
    api.message(USER, 'send me the report');
    await until(() => sent().includes('attached it'), 60_000, 'the reply after attach');
    await until(() => api.of('sendDocument').length === 1, 30_000, 'the document');
    const doc = api.of('sendDocument')[0]!;
    expect(doc.params.chat_id).toBe(String(USER));
    expect(doc.params.document.name).toBe('report.txt');
    expect(doc.params.document.bytes.toString()).toBe('the report');

    // 3. A web-started turn's attach_file sends nothing to Telegram.
    const web = await webClient(h);
    web.send({ type: 'assistant_open' });
    const cur = await web.waitForType('assistant_current');
    web.send({ type: 'session_load', sessionFile: cur.sessionFile });
    await web.waitFor((m) => m.type === 'session_ready' && m.sessionFile === cur.sessionFile);
    h.fake.queue({ kind: 'tool-call', toolName: 'attach_file', input: { path: out }, toolCallId: 'toolu_webattach' });
    h.setNext({ kind: 'reply', text: 'web attached' });
    web.send({ type: 'message', message: 'attach it here', sessionId: cur.sessionId });
    await web.waitFor((m) => m.type === 'tool_end' && m.toolName === 'attach_file', 30_000);
    await web.waitForType('agent_end', 30_000);
    await new Promise((r) => setTimeout(r, 1000));
    expect(api.of('sendDocument')).toHaveLength(1);
    expect(api.of('sendPhoto')).toHaveLength(0);
    expect(sent()).not.toContain('web attached');
  }, 180_000);
});
