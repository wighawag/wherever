import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { SessionPool, RELOADING_REFUSAL, type ServerTrackedSession } from '../src/session-pool.ts';

// The web `/reload` (SessionPool.reloadSession) REBUILDS a server session's agent
// instead of calling AgentSession.reload(), whose resetApiProviders() is
// process-wide. These tests pin what a rebuild must preserve (the pool entry,
// its clients, the SessionManager, model) and the lifecycle it must run
// (session_shutdown + session_start, both with reason "reload"), plus the races
// with the other teardown paths.

type Recorded = { type: string; reason?: string; sessionId: string };

let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-reload-'));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
  // Two models (never called: no test prompts), so a reload can be shown to keep
  // the CURRENT model rather than falling back to the default.
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: 'http://127.0.0.1:9',
          api: 'anthropic-messages',
          apiKey: 'test-key',
          models: [{ id: 'fake-a' }, { id: 'fake-b' }],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-a' }),
  );
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function recorder(opts: { shutdownDelayMs?: number } = {}) {
  const events: Recorded[] = [];
  const extension: InlineExtension = {
    name: 'reload-recorder',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', (event, ctx) => {
        events.push({ type: event.type, reason: event.reason, sessionId: ctx.sessionManager.getSessionId() });
      });
      pi.on('session_shutdown', async (event, ctx) => {
        events.push({ type: event.type, reason: event.reason, sessionId: ctx.sessionManager.getSessionId() });
        if (opts.shutdownDelayMs) await new Promise((r) => setTimeout(r, opts.shutdownDelayMs));
      });
    },
  };
  const reasons = (type: string) => events.filter((e) => e.type === type).map((e) => e.reason);
  return { events, extension, reasons };
}

function freshCwd(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
}

async function newServerSession(pool: SessionPool): Promise<ServerTrackedSession> {
  const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
  expect(error).toBeUndefined();
  expect(tracked.type).toBe('server');
  return tracked as ServerTrackedSession;
}

describe('SessionPool.reloadSession', () => {
  it('rebuilds the agent in place: shutdown(reload) then start(reload), same entry, clients and SessionManager', async () => {
    const rec = recorder();
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const tracked = await newServerSession(pool);
    pool.addClient(tracked.sessionFile, 'viewer-1');
    // Switch away from the default so "kept the model" is observable.
    expect(tracked.model).toBe('fake:fake-a');
    expect(await pool.changeModel(tracked.sessionFile, 'fake:fake-b')).toEqual({});
    const oldAgent = tracked.agentSession;
    const oldSessionManager = oldAgent.sessionManager;
    const onStart = vi.fn();

    const result = await pool.reloadSession(tracked.sessionFile, { onStart });
    expect(result).toEqual({ started: true });
    expect(onStart).toHaveBeenCalledTimes(1);

    expect(rec.reasons('session_start')).toEqual(['startup', 'reload']);
    expect(rec.reasons('session_shutdown')).toEqual(['reload']);

    // Same pool entry, updated in place.
    expect(pool.getSession(tracked.sessionFile)).toBe(tracked);
    expect(tracked.agentSession).not.toBe(oldAgent);
    expect(tracked.agentSession.sessionManager).toBe(oldSessionManager);
    expect(tracked.sessionId).toBe(tracked.agentSession.sessionId);
    expect(tracked.model).toBe('fake:fake-b');
    expect(tracked.agentSession.model?.id).toBe('fake-b');
    expect(tracked.clients.has('viewer-1')).toBe(true);
    expect(pool.isReloading(tracked.sessionFile)).toBe(false);

    // The rebuilt agent is the live one: its shutdown fires on destroy, once.
    await pool.destroySession(tracked.sessionFile, 'manual');
    expect(rec.reasons('session_shutdown')).toEqual(['reload', 'quit']);
  }, 30_000);

  it('refuses while the agent is streaming, without touching it', async () => {
    const rec = recorder();
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const tracked = await newServerSession(pool);
    vi.spyOn(tracked.agentSession, 'isStreaming', 'get').mockReturnValue(true);
    const onStart = vi.fn();

    const result = await pool.reloadSession(tracked.sessionFile, { onStart });
    expect(result.started).toBe(false);
    expect(result.error).toMatch(/Wait for the current response/);
    expect(onStart).not.toHaveBeenCalled();
    expect(rec.reasons('session_shutdown')).toEqual([]);
    vi.restoreAllMocks();
    await pool.destroySession(tracked.sessionFile, 'manual');
  }, 30_000);

  it('refuses a CLI-bridge session (the terminal pi owns that agent)', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    const { tracked } = await pool.createNewSession(cwd, undefined, false, false);
    await pool.registerCliSession(tracked.sessionFile, cwd, '', { send() {}, close() {} } as any);

    const result = await pool.reloadSession(tracked.sessionFile);
    expect(result.started).toBe(false);
    expect(result.error).toMatch(/terminal/);
  }, 30_000);

  it('refuses sends and model changes while reloading, and a second concurrent reload', async () => {
    const rec = recorder({ shutdownDelayMs: 150 });
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const tracked = await newServerSession(pool);

    const reloading = pool.reloadSession(tracked.sessionFile);
    expect(pool.isReloading(tracked.sessionFile)).toBe(true);
    await expect(pool.sendUserMessage(tracked.sessionFile, 'hello')).rejects.toThrow(RELOADING_REFUSAL);
    expect(await pool.changeModel(tracked.sessionFile, 'x:y')).toEqual({ error: RELOADING_REFUSAL });
    expect(await pool.reloadSession(tracked.sessionFile)).toEqual({
      error: 'This session is already reloading.',
      started: false,
    });

    expect(await reloading).toEqual({ started: true });
    expect(pool.isReloading(tracked.sessionFile)).toBe(false);
    await pool.destroySession(tracked.sessionFile, 'manual');
  }, 30_000);

  it('a destroy DURING the reload does not double-shut the old agent, and releases the rebuilt one', async () => {
    const rec = recorder({ shutdownDelayMs: 150 });
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const tracked = await newServerSession(pool);
    const reloading = pool.reloadSession(tracked.sessionFile);

    // Mid-shutdown of the old agent: the session is deleted.
    await pool.destroySession(tracked.sessionFile, 'deleted');
    expect(pool.getSession(tracked.sessionFile)).toBeFalsy();

    const result = await reloading;
    expect(result.started).toBe(true);
    expect(result.error).toMatch(/closed while it was reloading/);
    expect(result.closed).toBe(true);
    // Old agent: ONE shutdown (reload). Rebuilt agent: started, then released (quit).
    expect(rec.reasons('session_shutdown')).toEqual(['reload', 'quit']);
    expect(rec.reasons('session_start')).toEqual(['startup', 'reload']);
    expect(pool.getSession(tracked.sessionFile)).toBeFalsy();
  }, 30_000);

  it('refuses while a send is still in its pre-stream phase (pi is not "streaming" yet)', async () => {
    // Park the message inside an `input` handler: pi awaits it BEFORE the run
    // starts, so isStreaming is still false. Only the pool's busy count knows.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => (entered = r));
    const parker: InlineExtension = {
      name: 'input-parker',
      factory: (pi: ExtensionAPI) => {
        pi.on('input', async () => {
          entered();
          await gate;
          return { action: 'handled' as const };
        });
      },
    };
    const pool = new SessionPool(300_000, { extraExtensionFactories: [parker] });
    const tracked = await newServerSession(pool);

    const sending = pool.sendUserMessage(tracked.sessionFile, 'hello');
    await inHandler;
    expect(tracked.agentSession.isStreaming).toBe(false);
    const refused = await pool.reloadSession(tracked.sessionFile);
    expect(refused.started).toBe(false);
    expect(refused.error).toMatch(/Wait for the current response/);

    release();
    await sending;
    expect(await pool.reloadSession(tracked.sessionFile)).toEqual({ started: true });
    await pool.destroySession(tracked.sessionFile, 'manual');
  }, 30_000);

  it('refuses while a `!command` is running', async () => {
    const pool = new SessionPool(300_000);
    const tracked = await newServerSession(pool);
    const running = pool.sendUserMessage(tracked.sessionFile, '!sleep 0.3');
    const refused = await pool.reloadSession(tracked.sessionFile);
    expect(refused.started).toBe(false);
    await running;
    expect((await pool.reloadSession(tracked.sessionFile)).started).toBe(true);
    await pool.destroySession(tracked.sessionFile, 'manual');
  }, 30_000);

  it('server shutdown (disposeAll) mid-reload waits for it and releases the rebuilt agent', async () => {
    const rec = recorder({ shutdownDelayMs: 150 });
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const tracked = await newServerSession(pool);
    const reloading = pool.reloadSession(tracked.sessionFile);

    await pool.disposeAll();
    // By the time shutdown returns, the old agent shut down for the reload AND the
    // rebuilt one was started and then released: nothing is left running.
    expect(rec.reasons('session_shutdown')).toEqual(['reload', 'quit']);
    expect(await reloading).toMatchObject({ started: true, closed: true });
  }, 30_000);

  it('a sudo password submitted mid-reload waits and runs on the REBUILT agent', async () => {
    const rec = recorder({ shutdownDelayMs: 150 });
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const tracked = await newServerSession(pool);
    let promptId = '';
    pool.onEvent = (_file, event: any) => {
      if (event.type === 'bash_sudo_prompt') promptId = event.promptId;
    };
    await pool.sendUserMessage(tracked.sessionFile, '!sudo true');
    expect(promptId).not.toBe('');
    // Never actually run sudo: record which agent the command would run on.
    const ranOn: unknown[] = [];
    vi.spyOn(pool as any, 'runServerBashUnguarded').mockImplementation(async (t: any) => {
      ranOn.push(t.agentSession);
    });

    const oldAgent = tracked.agentSession;
    const reloading = pool.reloadSession(tracked.sessionFile);
    expect(await pool.submitSudoPassword(promptId, 'not-a-real-password')).toBe(true);
    await reloading;
    expect(ranOn).toHaveLength(1);
    expect(ranOn[0]).toBe(tracked.agentSession);
    expect(ranOn[0]).not.toBe(oldAgent);
    await pool.destroySession(tracked.sessionFile, 'manual');
  }, 30_000);

  it('a failed rebuild drops the entry (the old agent is gone) and reports the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = new SessionPool(300_000);
    const tracked = await newServerSession(pool);
    vi.spyOn(pool as any, 'buildServerAgent').mockRejectedValue(new Error('extension exploded'));

    const result = await pool.reloadSession(tracked.sessionFile);
    expect(result.started).toBe(true);
    expect(result.error).toContain('extension exploded');
    expect(pool.getSession(tracked.sessionFile)).toBeFalsy();
    expect(pool.isReloading(tracked.sessionFile)).toBe(false);
  }, 30_000);
});
