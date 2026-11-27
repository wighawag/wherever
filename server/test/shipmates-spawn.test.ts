import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import shipmatesPi from '@shipmates/pi';
import { currentHost, openShipmates, type Shipmates } from 'shipmates';
import { SessionPool, type ServerTrackedSession } from '../src/session-pool.ts';
import { registerShipmatesHost, WhereverShipmatesHost } from '../src/shipmates-host.ts';
import { startFakeLlmServer, type FakeLlmServer } from './fake-llm-server.js';

/**
 * wherever as shipmates' host for spawn and stop (wherever ADR 0024, shipmates
 * D26, D28, D30), and the closing of human-input marks (shipmates D35), with the
 * REAL @shipmates/pi in REAL server sessions against the fake LLM (ADR 0001):
 *
 * - an owner's `session_spawn` becomes a pool session in the asked folder; its
 *   first message is shipmates' `spawn` message from the owner, origin agent,
 *   never a human turn;
 * - the host's stop aborts only that session's run;
 * - a child the pool evicted is loaded again when a message waits for it;
 * - a human send another extension swallows leaves no mark, so an identical
 *   scheduled send right after is not the human's.
 *
 * shipmates' database is this file's temp home (setup-isolate-env.ts).
 */

let root: string;
let fake: FakeLlmServer;
let shipmates: Shipmates;
const savedEnv: Record<string, string | undefined> = {};
const cleanups: Array<() => unknown> = [];
const shipmatesExtension: InlineExtension = { name: '@shipmates/pi', factory: shipmatesPi as InlineExtension['factory'] };

beforeAll(async () => {
  fake = await startFakeLlmServer({ kind: 'reply', text: 'ok' });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-shipmates-spawn-')));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
    ['WHEREVER_STATE_DIR', 'wherever-state'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
  savedEnv.SHIPMATES_POLL_MS = process.env.SHIPMATES_POLL_MS;
  process.env.SHIPMATES_POLL_MS = '50';
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({ providers: { fake: { baseUrl: fake.url, api: 'anthropic-messages', apiKey: 'test-key', models: [{ id: 'fake-model' }] } } }),
  );
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }));
  shipmates = openShipmates();
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  fake.setNext({ kind: 'reply', text: 'ok' });
});

afterAll(async () => {
  shipmates.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fake.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(extra: InlineExtension[] = []) {
  const pool = new SessionPool(300_000, { extraExtensionFactories: [...extra, shipmatesExtension] });
  const host = new WhereverShipmatesHost({ pool, stateDir: freshDir('host-state'), shipmates: () => shipmates, log: { log() {}, warn() {}, error() {} } });
  const off = registerShipmatesHost(host);
  pool.setServerSessionUnloadingHook((file) => host.noteUnloaded(file));
  cleanups.push(() => pool.disposeAll(), off);
  return { pool, host };
}

/** A session with a transcript on disk and one finished turn, settled idle. */
async function settledSession(pool: SessionPool): Promise<string> {
  const s = await newSession(pool);
  await pool.sendUserMessage(s.sessionFile, 'hello');
  await until(() => fs.existsSync(s.sessionFile) && !pool.isStreaming(s.sessionFile) && shipmates.presence(s.sessionFile)?.state === 'idle');
  return s.sessionFile;
}

/** Give a wake that should NOT happen the time it would have taken. */
async function stillUnloaded(pool: SessionPool, file: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
  expect(pool.getSession(file)).toBeNull();
}

function freshDir(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(root, `${name}-`)));
}

async function newSession(pool: SessionPool, cwd = freshDir('cwd')): Promise<ServerTrackedSession> {
  const { tracked, error } = await pool.createNewSession(cwd, undefined, false, false);
  expect(error).toBeUndefined();
  return tracked as ServerTrackedSession;
}

async function until<T>(get: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Everything any session sent the model, as one string (a request's messages). */
const sentToModel = () => JSON.stringify(fake.requests().map((r) => r.messages));

describe('shipmates spawn and stop through the session pool', () => {
  it("the host is the process's shipmates host, and unregistering restores the previous one", () => {
    const before = currentHost();
    const a = { spawn: async () => ({ sessionFile: '/a.jsonl' }) };
    const off = registerShipmatesHost(a);
    expect(currentHost()).toBe(a);
    off();
    expect(currentHost()).toBe(before);
  });

  it("an owner's session_spawn creates a pool session; its first message is the owner's (origin agent), never a human turn", async () => {
    const { pool, host } = setup();
    const owner = await newSession(pool);
    const childDir = freshDir('lane');
    fake.queue({
      kind: 'tool-call',
      toolName: 'session_spawn',
      input: { folder: childDir, prompt: 'Build the push lane from docs/plan.md', role: 'tree/push' },
    });

    await pool.sendUserMessage(owner.sessionFile, 'start the push lane');

    const child = await until(() => host.spawned().map((f) => pool.getSession(f)).find((t) => t && t.cwd === childDir));
    expect(host.spawned()).toEqual([child.sessionFile]);
    expect(shipmates.ownerOf(child.sessionFile)).toBe(owner.sessionFile);
    expect(shipmates.roleHolder('tree/push')).toBe(child.sessionFile);

    // shipmates delivered the first prompt as the owner's spawn message, and it woke the child.
    await until(() => shipmates.db.prepare(`SELECT state FROM message WHERE kind = 'spawn' AND to_target = ?`).get(child.sessionFile)?.state === 'delivered');
    const spawnMsg = shipmates.db.prepare(`SELECT origin, from_session FROM message WHERE kind = 'spawn' AND to_target = ?`).get(child.sessionFile) as { origin: string; from_session: string };
    expect(spawnMsg).toEqual({ origin: 'agent', from_session: owner.sessionFile });
    await until(() => sentToModel().includes('Build the push lane from docs/plan.md'));
    expect(() => shipmates.relayFromHuman(child.sessionFile, { quote: 'push lane' })).toThrow(/no human turn/);
  }, 60_000);

  it('stop aborts only that session\'s run: not-running when idle, not-mine outside the pool', async () => {
    const { pool, host } = setup();
    const owner = await newSession(pool);
    const child = (await pool.spawnSession({ folder: freshDir('lane'), title: 'tree/stop' })) as { tracked: ServerTrackedSession };
    const file = child.tracked.sessionFile;
    expect(child.tracked.type).toBe('server');

    expect(await host.stop(file, { by: owner.sessionFile })).toBe('not-running');
    expect(await host.stop(path.join(root, 'elsewhere.jsonl'), { by: owner.sessionFile })).toBe('not-mine');

    fake.setNext({ kind: 'slow-reply', text: 'x'.repeat(400), charDelayMs: 20 });
    const run = pool.sendUserMessage(file, 'a long job');
    await until(() => pool.isStreaming(file));
    expect(await host.stop(file, { by: owner.sessionFile })).toBe('stopped');
    await run.catch(() => {});
    await until(() => !pool.isStreaming(file), 5_000);
    // The child is still there, and so is the owner, untouched.
    expect(pool.getSession(file)).not.toBeNull();
    expect(pool.getSession(owner.sessionFile)).not.toBeNull();
    // The spawned session carries its title as its name.
    expect((pool.getSession(file) as ServerTrackedSession).agentSession.sessionManager.getSessionName()).toBe('tree/stop');
  }, 60_000);

  it('a child the pool evicted is loaded again when a message waits for it (shipmates only wakes its own headless children)', async () => {
    const { pool, host } = setup();
    const owner = await newSession(pool);
    const childDir = freshDir('lane');
    fake.queue({ kind: 'tool-call', toolName: 'session_spawn', input: { folder: childDir, prompt: 'first job' } });
    await pool.sendUserMessage(owner.sessionFile, 'spawn it');
    const file = await until(() => host.spawned()[0]);
    // Its first turn wrote the transcript; then the pool lets it go.
    await until(() => fs.existsSync(file) && !pool.isStreaming(file) && shipmates.presence(file)?.state === 'idle');
    await pool.destroySession(file, 'idle');
    expect(pool.getSession(file)).toBeNull();

    shipmates.send({ from: owner.sessionFile, to: file, text: 'second job: rebase onto main' });
    host.wakeEvicted();
    await until(() => pool.getSession(file));
    await until(() => sentToModel().includes('second job: rebase onto main'));
  }, 60_000);

  it('any session the pool unloaded is loaded again when a message waits for it, not only a spawned child', async () => {
    const { pool, host } = setup();
    const sender = await newSession(pool);
    const file = await settledSession(pool);
    await pool.destroySession(file, 'idle timeout');
    expect(pool.getSession(file)).toBeNull();

    shipmates.send({ from: sender.sessionFile, to: file, text: 'please review PR 12' });
    host.wakeEvicted();
    await until(() => pool.getSession(file));
    await until(() => sentToModel().includes('please review PR 12'));
  }, 60_000);

  it('what was already pending at unload, held on purpose, does not wake it; a newer message does', async () => {
    const { pool, host } = setup();
    const sender = await newSession(pool);
    const file = await settledSession(pool);
    shipmates.update(file, { wake: false });
    shipmates.send({ from: sender.sessionFile, to: file, text: 'held while waking was off' });
    await new Promise((r) => setTimeout(r, 200)); // its own poller holds it
    shipmates.update(file, { wake: true });
    await pool.destroySession(file, 'idle timeout');
    host.wakeEvicted();
    await stillUnloaded(pool, file);

    shipmates.send({ from: sender.sessionFile, to: file, text: 'a newer one' });
    host.wakeEvicted();
    await until(() => pool.getSession(file));
    await until(() => sentToModel().includes('a newer one'));
  }, 60_000);

  it('waking off, recorded as it left, keeps it unloaded', async () => {
    const { pool, host } = setup();
    const sender = await newSession(pool);
    const file = await settledSession(pool);
    shipmates.update(file, { wake: false });
    await pool.destroySession(file, 'idle timeout');
    shipmates.send({ from: sender.sessionFile, to: file, text: 'not now' });
    host.wakeEvicted();
    await stillUnloaded(pool, file);
  }, 60_000);

  it('a session waiting for the human wakes only for a human-origin message, and the record survives a restart', async () => {
    const { pool, host } = setup();
    const sender = await newSession(pool);
    const file = await settledSession(pool);
    shipmates.update(file, { state: 'waiting-for-human' });
    await pool.destroySession(file, 'idle timeout');
    shipmates.send({ from: sender.sessionFile, to: file, text: 'an agent ping' });
    host.wakeEvicted();
    await stillUnloaded(pool, file);

    // A new host on the same state dir (a server restart) knows what it said.
    const again = new WhereverShipmatesHost({ pool, stateDir: (host as any).opts.stateDir, shipmates: () => shipmates, log: { log() {}, warn() {}, error() {} } });
    shipmates.send({ from: null, to: file, text: 'the human answers: yes, go ahead' });
    again.wakeEvicted();
    await until(() => pool.getSession(file));
    await until(() => sentToModel().includes('the human answers: yes, go ahead'));
  }, 60_000);

  it("shipmates' own per-session settings (D40) decide when it keeps them, for a child too", async () => {
    const { pool, host } = setup();
    const owner = await newSession(pool);
    const childDir = freshDir('lane');
    fake.queue({ kind: 'tool-call', toolName: 'session_spawn', input: { folder: childDir, prompt: 'first job' } });
    await pool.sendUserMessage(owner.sessionFile, 'spawn it');
    const file = await until(() => host.spawned()[0]);
    await until(() => fs.existsSync(file) && !pool.isStreaming(file) && shipmates.presence(file)?.state === 'idle');
    await pool.destroySession(file, 'idle');

    // A shipmates with the settings read says: it declared waiting for the human.
    const core = shipmates as unknown as Record<string, unknown>;
    core.setting = (f: string) => ({ sessionFile: f, wake: true, declaredWaiting: f === file, updatedAt: f === file ? 1 : null });
    core.settings = () => [];
    cleanups.push(() => {
      delete core.setting;
      delete core.settings;
    });
    shipmates.send({ from: owner.sessionFile, to: file, text: 'an agent ping for the child' });
    host.wakeEvicted();
    await stillUnloaded(pool, file);

    shipmates.send({ from: null, to: file, text: 'the human says go' });
    host.wakeEvicted();
    await until(() => pool.getSession(file));
    await until(() => sentToModel().includes('the human says go'));
  }, 60_000);

  it('a session open in another process is never loaded here', async () => {
    const { pool, host } = setup();
    const sender = await newSession(pool);
    const file = await settledSession(pool);
    await pool.destroySession(file, 'idle timeout');
    // Registered by a live process (this one stands in for a terminal pi).
    shipmates.register({ sessionFile: file });
    cleanups.push(() => shipmates.unregister(file));
    shipmates.send({ from: sender.sessionFile, to: file, text: 'for the terminal' });
    host.wakeEvicted();
    await stillUnloaded(pool, file);
  }, 60_000);

  it('a human send another extension swallows leaves no mark: an identical scheduled send right after is not the human\'s', async () => {
    let swallow = true;
    const swallower: InlineExtension = {
      name: 'swallower',
      factory: (pi) => {
        pi.on('input', (event) => (swallow && event.text === '/standup' ? { action: 'handled' } : { action: 'continue' }));
      },
    };
    const { pool } = setup([swallower]); // loaded before @shipmates/pi, so its handler runs first
    const s = await newSession(pool);
    await pool.sendUserMessage(s.sessionFile, '/standup'); // a web send: marked, never reaches @shipmates/pi
    swallow = false;
    await pool.sendUserMessage(s.sessionFile, '/standup', undefined, false, 'schedule:j1'); // well within shipmates' 5 s
    expect(() => shipmates.relayFromHuman(s.sessionFile, { quote: '/standup' })).toThrow(/no human turn/);
    // And a human send that does reach @shipmates/pi still counts.
    await pool.sendUserMessage(s.sessionFile, 'I approve the standup');
    expect(shipmates.relayFromHuman(s.sessionFile, { quote: 'approve the standup' }).channel).toBe('web');
  }, 60_000);
});
