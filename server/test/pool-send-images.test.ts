import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import { SessionPool, type ServerTrackedSession } from '../src/session-pool.ts';
import { channelImages, ChannelDispatcher, type AssistantChannel, type ChannelContext, type ChannelPoolPort } from '../src/assistant-channels.ts';
import { startFakeLlmServer, type FakeLlmServer } from './fake-llm-server.js';

/**
 * Images on the pool send (task `pool-send-images`): a send may carry images
 * that reach the model as image inputs, for a server session (REAL pi against
 * the fake LLM, ADR 0001, with an image-capable fake model) and, on
 * `cli_message`, for a CLI-bridge session. A send without images is exactly as
 * before. The channel dispatcher turns a channel message's image files into
 * those images, keeping their paths in the text.
 *
 * PI_CODING_AGENT_DIR, WHEREVER_CONFIG_DIR and WHEREVER_STATE_DIR are temp dirs.
 */

/** A 1x1 PNG. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG: ImageContent = { type: 'image', data: PNG_B64, mimeType: 'image/png' };

let root: string;
let fake: FakeLlmServer;
const savedEnv: Record<string, string | undefined> = {};
const pools: SessionPool[] = [];

beforeAll(async () => {
  fake = await startFakeLlmServer({ kind: 'reply', text: 'ok' });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-send-images-')));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
    ['WHEREVER_STATE_DIR', 'wherever-state'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: fake.url,
          api: 'anthropic-messages',
          apiKey: 'test-key',
          models: [{ id: 'fake-model', input: ['text', 'image'] }],
        },
      },
    }),
  );
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }));
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.disposeAll()));
  fake.setNext({ kind: 'reply', text: 'ok' });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fake.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function newPool(): SessionPool {
  const pool = new SessionPool(300_000);
  pools.push(pool);
  return pool;
}

async function newServerSession(pool: SessionPool): Promise<ServerTrackedSession> {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
  const { tracked, error } = await pool.createNewSession(cwd, undefined, false, false);
  expect(error).toBeUndefined();
  return tracked as ServerTrackedSession;
}

/** The content blocks of the last user message of a fake-LLM request. */
function lastUserContent(body: Record<string, any> | undefined): any[] {
  const msgs = (body?.messages ?? []) as Array<{ role: string; content: unknown }>;
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

describe('pool send with images (server sessions)', () => {
  it('an image reaches the model request beside the text, and the reply keeps its origin', async () => {
    const pool = newPool();
    const s = await newServerSession(pool);
    const dests: Array<[string, string | null]> = [];
    pool.subscribeEvents((f, event, dest) => {
      const m = (event as any).message;
      if (f === s.sessionFile && event.type === 'message_end' && (m?.role === 'user' || m?.role === 'assistant')) dests.push([m.role, dest]);
    });

    await pool.sendUserMessage(s.sessionFile, 'what is this?\n\n[Uploaded file: /tmp/p.png]', undefined, false, 'telegram', [PNG]);

    const content = lastUserContent(fake.requests().at(-1));
    expect(content.filter((p) => p.type === 'text').map((p) => p.text).join('')).toContain('[Uploaded file: /tmp/p.png]');
    const images = content.filter((p) => p.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0].source.type).toBe('base64');
    expect(images[0].source.media_type).toBe('image/png');
    expect(Buffer.from(images[0].source.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    // One send, one origin entry: both the user message and its reply are telegram's.
    expect(dests).toEqual([
      ['user', 'telegram'],
      ['assistant', 'telegram'],
    ]);
    expect(pool.getRoutingSnapshot(s.sessionFile)).toEqual({ promptOrSteer: [], followUp: [] });
  }, 60_000);

  it('a send without images passes images: undefined to prompt(), plain and "/"-prefixed alike', async () => {
    const pool = newPool();
    const s = await newServerSession(pool);
    const spy = vi.spyOn(s.agentSession, 'prompt');

    await pool.sendUserMessage(s.sessionFile, 'plain text');
    await pool.sendUserMessage(s.sessionFile, 'empty list', undefined, false, 'telegram', []);
    await pool.sendUserMessage(s.sessionFile, '/not-a-command here');

    expect(spy).toHaveBeenCalledTimes(3);
    for (const call of spy.mock.calls) {
      const opts = call[1] as Record<string, unknown>;
      expect(Object.keys(opts)).toContain('images');
      expect(opts.images).toBeUndefined();
    }
    expect(spy.mock.calls[0]![1]).toMatchObject({ expandPromptTemplates: false, source: 'extension' });
    expect(spy.mock.calls[2]![1]).toMatchObject({ expandPromptTemplates: true, source: 'interactive' });
    expect(lastUserContent(fake.requests().at(-1)).some((p) => p.type === 'image')).toBe(false);
    spy.mockRestore();
  }, 60_000);
});

describe('pool send with images (CLI-bridge sessions)', () => {
  function fakeCliWs() {
    const sent: any[] = [];
    return { sent, ws: { send: (d: string) => sent.push(JSON.parse(d)), close() {}, readyState: 1 } as any };
  }

  it('relays the images on cli_message, and omits the key when there are none', async () => {
    const pool = newPool();
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'cli-')));
    const file = path.join(root, 'cli-session.jsonl');
    const cli = fakeCliWs();
    await pool.registerCliSession(file, cwd, '', cli.ws);

    await pool.sendUserMessage(file, 'look', undefined, false, 'telegram', [PNG]);
    expect(cli.sent.at(-1)).toEqual({ type: 'cli_message', message: 'look', images: [PNG] });

    await pool.sendUserMessage(file, 'no images', 'steer');
    expect(cli.sent.at(-1)).toEqual({ type: 'cli_message', message: 'no images', streamingBehavior: 'steer' });
    expect(Object.keys(cli.sent.at(-1))).not.toContain('images');
    await pool.sendUserMessage(file, 'empty list', undefined, false, 'telegram', []);
    expect(Object.keys(cli.sent.at(-1))).not.toContain('images');

    // One relayed send, one origin entry each.
    expect(pool.getRoutingSnapshot(file)).toEqual({ promptOrSteer: ['telegram', 'none', 'telegram'], followUp: [] });
  });
});

describe('channel images (dispatcher)', () => {
  it('reads image files as images; other files and unreadable ones stay paths only', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, 'files-')));
    const photo = path.join(dir, 'photo.jpg');
    const png = path.join(dir, 'shot.png');
    const doc = path.join(dir, 'notes.txt');
    fs.writeFileSync(photo, Buffer.from(PNG_B64, 'base64'));
    fs.writeFileSync(png, Buffer.from(PNG_B64, 'base64'));
    fs.writeFileSync(doc, 'hello');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const images = await channelImages([
      { path: photo, name: 'photo.jpg', mimeType: 'image/jpeg' },
      { path: doc, name: 'notes.txt', mimeType: 'text/plain' },
      { path: png }, // no mime: inferred from the extension
      { path: path.join(dir, 'gone.png'), mimeType: 'image/png' },
    ]);
    expect(images).toEqual([
      { type: 'image', data: PNG_B64, mimeType: 'image/jpeg' },
      { type: 'image', data: PNG_B64, mimeType: 'image/png' },
    ]);
    expect(await channelImages(undefined)).toEqual([]);
    expect(await channelImages([{ path: doc, mimeType: 'text/plain' }])).toEqual([]);
    warn.mockRestore();
  });

  it('a channel photo goes to the controller as images plus its path; a text message carries no images key', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, 'files-')));
    const photo = path.join(dir, 'photo-1.jpg');
    fs.writeFileSync(photo, Buffer.from(PNG_B64, 'base64'));
    const sends: Array<{ text: string; origin: string; opts: Record<string, unknown> | undefined }> = [];
    let ctx: ChannelContext | null = null;
    const channel: AssistantChannel = { name: 'telegram', start: (c) => void (ctx = c), stop: () => {} };
    const pool: ChannelPoolPort = { subscribeEvents: () => () => {} };
    const d = new ChannelDispatcher({
      controller: { send: async (text, origin, _b, opts) => void sends.push({ text, origin, opts: opts as Record<string, unknown> | undefined }) },
      pool,
      channels: [channel],
    });
    await d.start();

    await ctx!.onUserMessage({ channel: 'telegram', text: 'what is this?', files: [{ path: photo, name: 'photo-1.jpg', mimeType: 'image/jpeg' }] });
    await ctx!.onUserMessage({ channel: 'telegram', text: 'just text' });

    expect(sends[0]!.text).toBe(`what is this?\n\n[Uploaded file: ${photo}]`);
    expect(sends[0]!.origin).toBe('telegram');
    expect(sends[0]!.opts!.images).toEqual([{ type: 'image', data: PNG_B64, mimeType: 'image/jpeg' }]);
    expect(sends[1]!.text).toBe('just text');
    expect(Object.keys(sends[1]!.opts!)).not.toContain('images');
    await d.stop();
  });
});
