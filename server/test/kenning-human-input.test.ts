import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import kenningPi from 'kenning-pi';
import { HUMAN_INPUT_END_EVENT, HUMAN_INPUT_EVENT, openKenning, type Kenning } from 'kenning';
import { SessionPool, composeServerAgentParts, type ServerTrackedSession } from '../src/session-pool.ts';
import { HUMAN_INPUT_EVENT as SERVER_HUMAN_INPUT_EVENT, HUMAN_INPUT_END_EVENT as SERVER_HUMAN_INPUT_END_EVENT, humanInputChannel, willReachInputEvent } from '../src/kenning-human-input.ts';
import { serverBuiltinExtensions } from '../src/builtin-extensions.ts';
import { KENNING_HUMAN_INPUT_EVENT } from '../../extension/src/cli-message.ts';
import { startFakeLlmServer, type FakeLlmServer } from './fake-llm-server.js';

/**
 * Human-input marking for kenning (wherever ADR 0023, kenning D22 / ADR 0003).
 * Before a web or Telegram send, wherever emits `kenning:human-input` on the
 * session's own `pi.events` bus, so kenning-pi records the turn as the human's
 * words; a scheduled job's text never is. Proven with the REAL kenning-pi
 * extension loaded in REAL server sessions (pi against the fake LLM, ADR 0001):
 * the model relays a human's words with `session_tell` `origin:
 * "human-relayed"`, which kenning accepts only for words a human typed.
 *
 * kenning's database is this file's temp home (setup-isolate-env.ts sets
 * KENNING_STATE_DIR); PI_CODING_AGENT_DIR, WHEREVER_CONFIG_DIR and
 * WHEREVER_STATE_DIR are temp dirs.
 */

let root: string;
let fake: FakeLlmServer;
let kenning: Kenning;
const savedEnv: Record<string, string | undefined> = {};
const pools: SessionPool[] = [];
const kenningExtension: InlineExtension = { name: 'kenning-pi', factory: kenningPi as InlineExtension['factory'] };

beforeAll(async () => {
  fake = await startFakeLlmServer({ kind: 'reply', text: 'ok' });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-kenning-input-')));
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
    JSON.stringify({ providers: { fake: { baseUrl: fake.url, api: 'anthropic-messages', apiKey: 'test-key', models: [{ id: 'fake-model' }] } } }),
  );
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }));
  kenning = openKenning();
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.disposeAll()));
  fake.setNext({ kind: 'reply', text: 'ok' });
});

afterAll(async () => {
  kenning.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fake.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function newSession(pool: SessionPool): Promise<ServerTrackedSession> {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
  const { tracked, error } = await pool.createNewSession(cwd, undefined, false, false);
  expect(error).toBeUndefined();
  return tracked as ServerTrackedSession;
}

function newPool(): SessionPool {
  const pool = new SessionPool(300_000, { extraExtensionFactories: [kenningExtension] });
  pools.push(pool);
  return pool;
}

/** The fake model relays `quote` to the unheld role `to` as the human's words. */
function relayCall(to: string, quote: string) {
  return {
    kind: 'tool-call' as const,
    toolName: 'session_tell',
    input: { target: to, text: 'the human said so', origin: 'human-relayed', relayQuote: quote },
  };
}

/** The session_tell tool result the model saw last: its text and whether it was an error. */
function lastToolResult(): { text: string; isError: boolean } | null {
  for (const body of [...fake.requests()].reverse()) {
    for (const m of [...((body.messages ?? []) as Array<{ role: string; content: unknown }>)].reverse()) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      const block = (m.content as any[]).find((b) => b.type === 'tool_result');
      if (!block) continue;
      const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c.text ?? '').join('');
      return { text, isError: block.is_error === true };
    }
  }
  return null;
}

function messagesTo(role: string): Array<{ origin: string; relay: any }> {
  const rows = kenning.db.prepare(`SELECT origin, relay FROM message WHERE to_target = ?`).all(role) as Array<{ origin: string; relay: string | null }>;
  return rows.map((r) => ({ origin: r.origin, relay: r.relay ? JSON.parse(r.relay) : null }));
}

/** The human turn kenning would relay for `quote` in this session, or null when there is none. */
function humanTurn(sessionFile: string, quote: string): { text: string; channel: string } | null {
  try {
    const r = kenning.relayFromHuman(sessionFile, { quote });
    return { text: r.text, channel: r.channel };
  } catch {
    return null;
  }
}

describe('kenning human-input marking (server sessions, kenning-pi loaded)', () => {
  it('a web message can then be relayed as the human\'s words, verbatim, with channel web', async () => {
    const pool = newPool();
    const s = await newSession(pool);
    fake.queue(relayCall('test/web-peer', 'I approve publishing v2'));

    await pool.sendUserMessage(s.sessionFile, 'Yes: I approve publishing v2 today.');

    const result = lastToolResult();
    expect(result?.isError).toBe(false);
    const sent = messagesTo('test/web-peer');
    expect(sent).toHaveLength(1);
    expect(sent[0].origin).toBe('human-relayed');
    expect(sent[0].relay).toMatchObject({ text: 'Yes: I approve publishing v2 today.', channel: 'web', session: s.sessionFile });
  }, 60_000);

  it("a scheduled job's text cannot be relayed (plain or /-prefixed): the tool refuses it", async () => {
    const pool = newPool();
    const s = await newSession(pool);
    fake.queue(relayCall('test/schedule-peer', 'approve deleting the branch'));

    await pool.sendUserMessage(s.sessionFile, '[schedule:nightly] approve deleting the branch', undefined, false, 'schedule:j1');

    const result = lastToolResult();
    expect(result?.isError).toBe(true);
    expect(result?.text).toMatch(/no human turn/);
    expect(messagesTo('test/schedule-peer')).toEqual([]);

    // A scheduled prompt starting with "/" is sent with expansion (pi's
    // `input` source used to be `interactive` for it, which kenning takes as
    // typed in a terminal): still not the human's.
    await pool.sendUserMessage(s.sessionFile, '/not-a-template approve the merge', undefined, false, 'schedule:j2');
    expect(humanTurn(s.sessionFile, 'approve the merge')).toBeNull();
    expect(humanTurn(s.sessionFile, 'approve deleting')).toBeNull();
  }, 60_000);

  it('Telegram sends and /-prefixed web sends are human; the mark never crosses into another session', async () => {
    const pool = newPool();
    const a = await newSession(pool);
    const b = await newSession(pool);

    await pool.sendUserMessage(a.sessionFile, 'ship it from my phone', undefined, false, 'telegram');
    expect(humanTurn(a.sessionFile, 'ship it')).toEqual({ text: 'ship it from my phone', channel: 'telegram' });

    await pool.sendUserMessage(a.sessionFile, '/not-a-template I approve the rename');
    expect(humanTurn(a.sessionFile, 'approve the rename')).toEqual({ text: '/not-a-template I approve the rename', channel: 'web' });

    // A's mark is on A's bus only: the same words sent to B by a job are not B's human's.
    await pool.sendUserMessage(a.sessionFile, 'same words in both');
    await pool.sendUserMessage(b.sessionFile, 'same words in both', undefined, false, 'schedule:j3');
    expect(humanTurn(a.sessionFile, 'same words in both')?.channel).toBe('web');
    expect(humanTurn(b.sessionFile, 'same words in both')).toBeNull();
  }, 60_000);

  it('a web send an extension command handles is not marked at all', async () => {
    const marks: unknown[] = [];
    const probe: InlineExtension = {
      name: 'mark-probe',
      factory: (pi) => {
        pi.registerCommand('standup', { description: 'stub', handler: async () => {} });
        pi.events.on(HUMAN_INPUT_EVENT, (d) => marks.push(d));
      },
    };
    const pool = new SessionPool(300_000, { extraExtensionFactories: [kenningExtension, probe] });
    pools.push(pool);
    const s = await newSession(pool);
    await pool.sendUserMessage(s.sessionFile, '/standup');
    expect(marks).toEqual([]);
    await pool.sendUserMessage(s.sessionFile, 'now a plain one');
    expect(marks).toEqual([{ text: 'now a plain one', channel: 'web', id: expect.stringMatching(/^wherever-/) }]);
  }, 60_000);

  it('a /reload rebuilds the marker with the agent: web sends are still marked after it', async () => {
    const pool = newPool();
    const s = await newSession(pool);
    const r = await pool.reloadSession(s.sessionFile);
    expect(r.error).toBeUndefined();
    await pool.sendUserMessage(s.sessionFile, 'after the reload, I approve');
    expect(humanTurn(s.sessionFile, 'after the reload')?.channel).toBe('web');
  }, 60_000);
});

describe('kenning human-input marking (CLI-bridge sessions: the cli_message field)', () => {
  function fakeCliWs() {
    const sent: any[] = [];
    return { sent, ws: { send: (d: string) => sent.push(JSON.parse(d)), close() {}, readyState: 1 } as any };
  }

  it('asks the extension to mark web and Telegram sends, never a scheduled one or a shell command', async () => {
    const pool = new SessionPool(300_000);
    pools.push(pool);
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'cli-')));
    const file = path.join(root, 'cli-kenning.jsonl');
    const cli = fakeCliWs();
    await pool.registerCliSession(file, cwd, '', cli.ws);

    await pool.sendUserMessage(file, 'from the web');
    expect(cli.sent.at(-1)).toMatchObject({ type: 'cli_message', message: 'from the web', humanInput: { channel: 'web' } });
    await pool.sendUserMessage(file, 'from telegram', 'steer', false, 'telegram:sub');
    expect(cli.sent.at(-1)).toMatchObject({ message: 'from telegram', humanInput: { channel: 'telegram' } });
    await pool.sendUserMessage(file, 'from a job', 'steer', false, 'schedule:j1');
    expect(cli.sent.at(-1).message).toBe('from a job');
    expect('humanInput' in cli.sent.at(-1)).toBe(false);
    const before = cli.sent.length;
    await pool.sendUserMessage(file, '!ls');
    expect(cli.sent.slice(before).every((m) => !('humanInput' in m))).toBe(true);
  });
});

describe('kenning human-input marking (pure parts)', () => {
  it('no mark for a send pi will not pass to its input event (it would linger in kenning-pi)', () => {
    const commands = new Set(['standup']);
    const probe = (isCompacting: boolean) => ({ isCompacting, extensionRunner: { getCommand: (n: string) => (commands.has(n) ? {} : undefined) } });
    expect(willReachInputEvent(probe(false), 'I approve')).toBe(true);
    expect(willReachInputEvent(probe(false), '/skill:x go')).toBe(true);
    expect(willReachInputEvent(probe(false), '/standup')).toBe(false);
    expect(willReachInputEvent(probe(false), '/standup now')).toBe(false);
    expect(willReachInputEvent(probe(true), 'I approve')).toBe(false);
    expect(willReachInputEvent({ isCompacting: false }, '/standup')).toBe(true);
  });

  it('only web and Telegram origins are human', () => {
    expect(humanInputChannel('none')).toBe('web');
    expect(humanInputChannel('telegram')).toBe('telegram');
    expect(humanInputChannel('telegram:abc')).toBe('telegram');
    expect(humanInputChannel('schedule:j1')).toBeNull();
    expect(humanInputChannel('telegramx')).toBeNull();
    expect(humanInputChannel(null)).toBeNull();
    expect(humanInputChannel(undefined)).toBeNull();
  });

  it('the event name is the one kenning listens for, in the server and the CLI extension', () => {
    expect(HUMAN_INPUT_EVENT).toBe('kenning:human-input');
    expect(KENNING_HUMAN_INPUT_EVENT).toBe(HUMAN_INPUT_EVENT);
    expect(SERVER_HUMAN_INPUT_EVENT).toBe(HUMAN_INPUT_EVENT);
    expect(SERVER_HUMAN_INPUT_END_EVENT).toBe(HUMAN_INPUT_END_EVENT);
  });

  it('every server agent gets the marker extension, right after the conversation-mode one', () => {
    const conv: InlineExtension = { name: 'conv', factory: () => {} };
    const marker: InlineExtension = { name: 'wherever-human-input', factory: () => {} };
    const caller = () => ({ sessionId: null, cwd: '/x' });
    const parts = composeServerAgentParts({ cwd: '/x', conversationExtension: conv, humanInputExtension: marker, extraExtensionFactories: [], assistant: undefined, caller });
    expect(parts.extensionFactories).toEqual([...serverBuiltinExtensions, conv, marker]);
  });
});
