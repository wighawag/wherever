import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSessionEvent, ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { SessionPool, type ServerTrackedSession } from '../src/session-pool.ts';
import { startFakeLlmServer, type FakeLlmServer } from './fake-llm-server.js';

/**
 * Per-user-message reply routing in the session pool (ADR 0014), with REAL pi
 * agents talking to the fake LLM (ADR 0001), in process. Each test records, for
 * every user and assistant `message_end` the pool fans out, the destination it
 * carried, and asserts every reply is attributed to the origin of the message
 * it answers. Origins are dummies (`telegram`, `schedule:j1`): no channel exists.
 *
 * PI_CODING_AGENT_DIR, WHEREVER_CONFIG_DIR and WHEREVER_STATE_DIR are temp dirs.
 */

let root: string;
let fake: FakeLlmServer;
const savedEnv: Record<string, string | undefined> = {};
const pools: SessionPool[] = [];

beforeAll(async () => {
  fake = await startFakeLlmServer({ kind: 'reply', text: 'ok' });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-routing-')));
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
        fake: { baseUrl: fake.url, api: 'anthropic-messages', apiKey: 'test-key', models: [{ id: 'fake-model' }] },
      },
    }),
  );
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }),
  );
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

/** A `/noop` extension command and an input handler that swallows `swallow-me`. */
const handlers: InlineExtension = {
  name: 'routing-handlers',
  factory: (pi: ExtensionAPI) => {
    pi.registerCommand('noop', { description: 'does nothing', handler: async () => {} });
    pi.on('input', (event) => (event.text === 'swallow-me' ? { action: 'handled' } : { action: 'continue' }));
  },
};

function newPool(): SessionPool {
  const pool = new SessionPool(300_000, { extraExtensionFactories: [handlers] });
  pools.push(pool);
  return pool;
}

async function newServerSession(pool: SessionPool): Promise<ServerTrackedSession> {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
  const { tracked, error } = await pool.createNewSession(cwd, undefined, false, false);
  expect(error).toBeUndefined();
  return tracked as ServerTrackedSession;
}

function textOf(message: any): string {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
  return '';
}

type Seen = { role: string; text: string; dest: string | null };

/** Every user/assistant message_end of `file`, with the destination it was fanned out with. */
function record(pool: SessionPool, file: string) {
  const seen: Seen[] = [];
  const events: AgentSessionEvent[] = [];
  pool.subscribeEvents((f, event, dest) => {
    if (f !== file) return;
    events.push(event);
    if (event.type === 'message_end') {
      const m = (event as any).message;
      if (m?.role === 'user' || m?.role === 'assistant') seen.push({ role: m.role, text: textOf(m), dest });
    }
  });
  const settled = () => events.filter((e) => e.type === 'agent_settled').length;
  return { seen, events, settled };
}

async function until(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Each assistant reply carries the destination of the user message before it. */
function expectRepliesFollowTheirQuestion(seen: Seen[]): void {
  let last: Seen | undefined;
  for (const s of seen) {
    if (s.role === 'user') last = s;
    else expect({ reply: s.text, dest: s.dest }).toEqual({ reply: s.text, dest: last?.dest ?? null });
  }
}

const users = (seen: Seen[]) => seen.filter((s) => s.role === 'user').map((s) => [s.text, s.dest]);

describe('pool reply routing (server sessions)', () => {
  it('attributes interleaved prompt, steer and followUp from two origins to their own replies', async () => {
    fake.setNext({ kind: 'slow-reply', text: 'a slowly streamed reply', charDelayMs: 25 });
    const pool = newPool();
    const s = await newServerSession(pool);
    const { seen, settled } = record(pool, s.sessionFile);

    void pool.sendUserMessage(s.sessionFile, 'q1', undefined, false, 'telegram');
    await until(() => seen.some((x) => x.role === 'user'));
    await pool.sendUserMessage(s.sessionFile, 's1', 'steer', false, 'schedule:j1');
    await pool.sendUserMessage(s.sessionFile, 'f1', 'followUp', false, 'telegram');
    await pool.sendUserMessage(s.sessionFile, 's2', 'steer', false, 'none');
    await until(() => settled() > 0);

    expect(users(seen)).toEqual([
      ['q1', 'telegram'],
      ['s1', 'schedule:j1'],
      ['s2', 'none'],
      ['f1', 'telegram'],
    ]);
    expect(seen.filter((x) => x.role === 'assistant').length).toBe(4);
    expectRepliesFollowTheirQuestion(seen);
    expect(pool.getReplyDestination(s.sessionFile)).toBe('telegram');
    expect(pool.getRoutingSnapshot(s.sessionFile)).toEqual({ promptOrSteer: [], followUp: [] });
  }, 60_000);

  it('a web !cmd, an extension /command and an input-handled message leave no slot (no drift)', async () => {
    const pool = newPool();
    const s = await newServerSession(pool);
    const { seen, settled } = record(pool, s.sessionFile);

    await pool.sendUserMessage(s.sessionFile, '!echo hi');
    await pool.sendUserMessage(s.sessionFile, '!!echo quiet');
    await pool.sendUserMessage(s.sessionFile, '/noop some args', undefined, false, 'schedule:j1');
    await pool.sendUserMessage(s.sessionFile, 'swallow-me', undefined, false, 'schedule:j2');
    expect(pool.getRoutingSnapshot(s.sessionFile)).toEqual({ promptOrSteer: [], followUp: [] });

    await pool.sendUserMessage(s.sessionFile, 'tagged question', undefined, false, 'telegram');
    await until(() => settled() > 0);
    expect(users(seen)).toEqual([['tagged question', 'telegram']]);
    expect(seen.filter((x) => x.role === 'assistant').map((x) => x.dest)).toEqual(['telegram']);
  }, 60_000);

  it('a send that throws, or to a non-resident session, records nothing', async () => {
    const pool = newPool();
    const s = await newServerSession(pool);
    await pool.sendUserMessage('/no/such/session.jsonl', 'hello', undefined, false, 'telegram');
    expect(pool.getRoutingSnapshot('/no/such/session.jsonl')).toEqual({ promptOrSteer: [], followUp: [] });

    const orig = s.agentSession.prompt.bind(s.agentSession);
    s.agentSession.prompt = (async () => {
      throw new Error('boom');
    }) as any;
    await expect(pool.sendUserMessage(s.sessionFile, 'hello', undefined, false, 'telegram')).rejects.toThrow('boom');
    expect(pool.getRoutingSnapshot(s.sessionFile)).toEqual({ promptOrSteer: [], followUp: [] });
    s.agentSession.prompt = orig;
  }, 60_000);

  it('a web message sent between a tagged message and its reply does not take its slot', async () => {
    fake.setNext({ kind: 'slow-reply', text: 'the reply to the tagged one', charDelayMs: 25 });
    const pool = newPool();
    const s = await newServerSession(pool);
    const { seen, settled } = record(pool, s.sessionFile);

    void pool.sendUserMessage(s.sessionFile, 'tagged', undefined, false, 'telegram');
    // Web send right away, before the tagged message's user message_end: the
    // web layer steers into a running turn (ADR 0003).
    await until(() => pool.isStreaming(s.sessionFile), 20_000);
    await pool.sendUserMessage(s.sessionFile, 'from the web', 'steer');
    await until(() => settled() > 0);

    expect(users(seen)).toEqual([
      ['tagged', 'telegram'],
      ['from the web', 'none'],
    ]);
    expectRepliesFollowTheirQuestion(seen);
    expect(seen.find((x) => x.role === 'assistant')!.dest).toBe('telegram');
  }, 60_000);

  it('after an abort with a steer still queued, the settle trim keeps that entry aligned with pi', async () => {
    fake.setNext({ kind: 'slow-reply', text: 'a long reply that will be aborted midway', charDelayMs: 40 });
    const pool = newPool();
    const s = await newServerSession(pool);
    const { seen, settled, events } = record(pool, s.sessionFile);

    void pool.sendUserMessage(s.sessionFile, 'first', undefined, false, 'telegram').catch(() => {});
    await until(() => events.some((e) => e.type === 'message_update'));
    await pool.sendUserMessage(s.sessionFile, 'queued steer', 'steer', false, 'schedule:j1');
    await pool.abortSession(s.sessionFile);
    await until(() => settled() > 0);

    const piSteering = s.agentSession.getSteeringMessages().length;
    expect(piSteering).toBe(1); // abort leaves pi's queue populated
    expect(pool.getRoutingSnapshot(s.sessionFile)).toEqual({ promptOrSteer: ['schedule:j1'], followUp: [] });

    // The next prompt jumps ahead of the leftover steer, and each is attributed.
    fake.setNext({ kind: 'reply', text: 'ok' });
    await pool.sendUserMessage(s.sessionFile, 'next', undefined, false, 'none');
    await until(() => settled() > 1);
    // pi delivers the leftover steer after the new prompt's first turn.
    expect(users(seen).slice(1)).toEqual([
      ['next', 'none'],
      ['queued steer', 'schedule:j1'],
    ]);
    expectRepliesFollowTheirQuestion(seen.slice(seen.findIndex((x) => x.text === 'next')));
    expect(pool.getRoutingSnapshot(s.sessionFile)).toEqual({ promptOrSteer: [], followUp: [] });
  }, 60_000);

  it('cancelSteerQueue clears the routing queues with pi\'s', async () => {
    fake.setNext({ kind: 'slow-reply', text: 'streaming for a while', charDelayMs: 30 });
    const pool = newPool();
    const s = await newServerSession(pool);
    const { seen, settled } = record(pool, s.sessionFile);

    void pool.sendUserMessage(s.sessionFile, 'first', undefined, false, 'none');
    await until(() => seen.some((x) => x.role === 'user'));
    await pool.sendUserMessage(s.sessionFile, 'steer me', 'steer', false, 'telegram');
    await pool.sendUserMessage(s.sessionFile, 'later', 'followUp', false, 'schedule:j1');
    expect(pool.getRoutingSnapshot(s.sessionFile)).toEqual({ promptOrSteer: ['telegram'], followUp: ['schedule:j1'] });
    await pool.cancelSteerQueue(s.sessionFile);
    expect(pool.getRoutingSnapshot(s.sessionFile)).toEqual({ promptOrSteer: [], followUp: [] });
    await until(() => settled() > 0);
    expect(users(seen)).toEqual([['first', 'none']]);
  }, 60_000);

  it('a message sent from an agent_settled listener keeps its entry (trim runs before the fan-out)', async () => {
    const pool = newPool();
    const s = await newServerSession(pool);
    const { seen, settled } = record(pool, s.sessionFile);
    let fired = false;
    pool.subscribeEvents((f, e) => {
      if (f === s.sessionFile && e.type === 'agent_settled' && !fired) {
        fired = true;
        void pool.sendUserMessage(f, 'scheduled', undefined, false, 'schedule:j1');
      }
    });
    await pool.sendUserMessage(s.sessionFile, 'hello', undefined, false, 'telegram');
    await until(() => settled() > 1);
    expect(users(seen)).toEqual([
      ['hello', 'telegram'],
      ['scheduled', 'schedule:j1'],
    ]);
    expectRepliesFollowTheirQuestion(seen);
  }, 60_000);
});

describe('pool event fan-out', () => {
  it('runs the broadcaster first with identical events, isolates a throwing subscriber, and keeps onEvent assignable', async () => {
    const pool = newPool();
    const s = await newServerSession(pool);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log: string[] = [];
    const broadcast: AgentSessionEvent[] = [];
    const extra: AgentSessionEvent[] = [];
    pool.onEvent = (f, e) => {
      if (f !== s.sessionFile) return;
      broadcast.push(e);
      log.push(`b:${e.type}`);
    };
    pool.subscribeEvents(() => {
      throw new Error('subscriber boom');
    });
    pool.subscribeEvents(async () => {
      throw new Error('async subscriber boom');
    });
    const off = pool.subscribeEvents((f, e) => {
      if (f !== s.sessionFile) return;
      extra.push(e);
      log.push(`l:${e.type}`);
    });

    await pool.sendUserMessage(s.sessionFile, 'hello');
    await until(() => extra.some((e) => e.type === 'agent_settled'));
    expect(extra).toEqual(broadcast);
    for (let i = 0; i < log.length; i += 2) {
      expect([log[i]!.slice(2), log[i]![0], log[i + 1]![0]]).toEqual([log[i + 1]!.slice(2), 'b', 'l']);
    }
    // The pool's own bookkeeping still ran.
    expect(pool.getSession(s.sessionFile)!.isIdle).toBe(true);

    // The pool's own synthetic events (a `!` command) fan out too.
    broadcast.length = 0;
    extra.length = 0;
    await pool.sendUserMessage(s.sessionFile, '!echo fanout');
    expect(broadcast.map((e) => e.type)).toContain('tool_execution_start');
    expect(broadcast.at(-1)!.type).toBe('tool_execution_end');
    expect(extra).toEqual(broadcast);

    off();
    extra.length = 0;
    await pool.sendUserMessage(s.sessionFile, '!echo again');
    expect(extra).toEqual([]);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('subscriber boom'))).toBe(true);
    errors.mockRestore();
  }, 60_000);
});

describe('pool reply routing (CLI-bridge sessions)', () => {
  function fakeCliWs() {
    const sent: any[] = [];
    return { sent, ws: { send: (d: string) => sent.push(JSON.parse(d)), close() {}, readyState: 1 } as any };
  }

  it('routes by the forwarded user message_end and empties the queues at settle', async () => {
    const pool = newPool();
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'cli-')));
    const file = path.join(root, 'cli-session.jsonl');
    const cli = fakeCliWs();
    await pool.registerCliSession(file, cwd, '', cli.ws);
    const { seen } = record(pool, file);

    await pool.sendUserMessage(file, 'from telegram', undefined, false, 'telegram');
    expect(cli.sent.at(-1)).toEqual({ type: 'cli_message', message: 'from telegram' });
    await pool.sendUserMessage(file, 'from the web', 'steer');
    await pool.sendUserMessage(file, '!ls'); // a shell send records nothing
    expect(pool.getRoutingSnapshot(file)).toEqual({ promptOrSteer: ['telegram', 'none'], followUp: [] });

    const userEnd = (text: string) => ({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } }) as any;
    const replyEnd = (text: string) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }) as any;
    pool.handleCliEvent(file, { type: 'agent_start' } as any);
    pool.handleCliEvent(file, userEnd('from telegram'));
    pool.handleCliEvent(file, replyEnd('hi telegram'));
    pool.handleCliEvent(file, userEnd('from the web'));
    pool.handleCliEvent(file, replyEnd('hi web'));
    expect(seen.map((x) => [x.text, x.dest])).toEqual([
      ['from telegram', 'telegram'],
      ['hi telegram', 'telegram'],
      ['from the web', 'none'],
      ['hi web', 'none'],
    ]);

    // cancelSteerQueue stays a no-op for CLI sessions (nothing relayed, nothing cleared).
    await pool.sendUserMessage(file, 'one more', 'followUp', false, 'schedule:j1');
    const relayed = cli.sent.length;
    await pool.cancelSteerQueue(file);
    expect(cli.sent.length).toBe(relayed);
    expect(pool.getRoutingSnapshot(file)).toEqual({ promptOrSteer: [], followUp: ['schedule:j1'] });

    pool.handleCliEvent(file, { type: 'agent_end' } as any);
    pool.handleCliEvent(file, { type: 'agent_settled', aborted: false } as any);
    expect(pool.getRoutingSnapshot(file)).toEqual({ promptOrSteer: [], followUp: [] });

    // Typed directly in the terminal, with nothing recorded: no origin.
    pool.handleCliEvent(file, userEnd('typed in the terminal'));
    expect(pool.getReplyDestination(file)).toBeNull();
  }, 30_000);

  it('a CLI takeover keeps the routing state of the session file', async () => {
    const pool = newPool();
    const s = await newServerSession(pool);
    await pool.sendUserMessage(s.sessionFile, 'q', undefined, false, 'telegram');
    expect(pool.getReplyDestination(s.sessionFile)).toBe('telegram');
    const cli = fakeCliWs();
    await pool.registerCliSession(s.sessionFile, s.cwd, '', cli.ws);
    expect(pool.getSession(s.sessionFile)!.type).toBe('cli');
    expect(pool.getReplyDestination(s.sessionFile)).toBe('telegram');
  }, 60_000);
});
