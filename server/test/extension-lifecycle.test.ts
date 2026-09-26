import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentSession, type ExtensionAPI, type InlineExtension } from '@earendil-works/pi-coding-agent';
import { SessionPool } from '../src/session-pool.ts';
import { serverExtensionBindings } from '../src/extension-lifecycle.ts';

// Server-created sessions must run the pi EXTENSION LIFECYCLE, like the pi CLI
// does: `session_start` (+ `resources_discover`) when the agent is built, and
// `session_shutdown` before it is disposed. Without it, extensions that
// initialise on session_start (the pi-mcp-adapter: "MCP not initialized") never
// start, and nothing they hold is ever released.
//
// In-process against a throwaway PI_CODING_AGENT_DIR and WHEREVER_CONFIG_DIR: no
// LLM call is made, the assertions are about which extension events fire,
// observed through an inline extension handed in the same way as the
// conversation-mode signal.

type Recorded = { type: string; reason?: string; sessionId: string };

let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-ext-lifecycle-'));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
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

function recorder(
  opts: { hangOnShutdown?: boolean; shutdownDelayMs?: number; throwOnStart?: string; startDelayMs?: number } = {},
) {
  const events: Recorded[] = [];
  const extension: InlineExtension = {
    name: 'lifecycle-recorder',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', async (event, ctx) => {
        events.push({ type: event.type, reason: event.reason, sessionId: ctx.sessionManager.getSessionId() });
        if (opts.startDelayMs) await new Promise((r) => setTimeout(r, opts.startDelayMs));
        if (opts.throwOnStart) throw new Error(opts.throwOnStart);
      });
      pi.on('resources_discover', (event) => {
        events.push({ type: event.type, reason: event.reason, sessionId: '' });
        return undefined;
      });
      pi.on('session_shutdown', async (event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        events.push({ type: event.type, reason: event.reason, sessionId });
        if (opts.hangOnShutdown) await new Promise(() => {});
        if (opts.shutdownDelayMs) await new Promise((r) => setTimeout(r, opts.shutdownDelayMs));
        events.push({ type: 'session_shutdown_done', sessionId });
      });
    },
  };
  const count = (type: string, sessionId?: string) =>
    events.filter((e) => e.type === type && (sessionId === undefined || e.sessionId === sessionId)).length;
  return { events, extension, count };
}

/** Capture console.error lines (the journal) for the duration of one test. */
function captureErrors(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return lines;
}

function freshCwd(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
}

/** An existing on-disk session (header + one user message) for the load path. */
function writeExistingSession(cwd: string): string {
  const dir = path.join(root, 'existing');
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const ts = new Date().toISOString();
  const file = path.join(dir, `${ts.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const line = (obj: unknown) => JSON.stringify(obj) + '\n';
  fs.writeFileSync(
    file,
    line({ type: 'session', version: 3, id, timestamp: ts, cwd }) +
      line({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: ts,
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: Date.now() },
      }),
  );
  return file;
}

async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

describe('extension lifecycle on server-created sessions', () => {
  it('a NEW session fires session_start + resources_discover once, and session_shutdown once on destroy', async () => {
    const rec = recorder();
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(error).toBeUndefined();

    // Bound BEFORE the session was handed back: no waiting needed.
    expect(rec.count('session_start')).toBe(1);
    expect(rec.events.find((e) => e.type === 'session_start')?.reason).toBe('startup');
    expect(rec.count('resources_discover')).toBe(1);
    expect(rec.count('session_shutdown')).toBe(0);

    await pool.destroySession(tracked.sessionFile, 'manual');
    expect(rec.count('session_shutdown')).toBe(1);
    expect(rec.events.find((e) => e.type === 'session_shutdown')?.reason).toBe('quit');
    expect(rec.count('session_start')).toBe(1);

    // A second destroy is a no-op: the entry is gone, so shutdown cannot fire twice.
    await pool.destroySession(tracked.sessionFile, 'manual');
    expect(rec.count('session_shutdown')).toBe(1);
  }, 30_000);

  it('a LOADED existing session fires session_start once, and session_shutdown once on idle eviction', async () => {
    const rec = recorder();
    const cwd = freshCwd();
    const file = writeExistingSession(cwd);
    const pool = new SessionPool(50, { extraExtensionFactories: [rec.extension] });
    const { tracked, error } = await pool.loadSession(file, cwd);
    expect(error).toBeUndefined();

    expect(rec.count('session_start')).toBe(1);
    expect(rec.count('resources_discover')).toBe(1);

    // No clients + idle -> the idle timer evicts it.
    pool.scheduleIdleCheck(tracked.sessionFile);
    await until(() => rec.count('session_shutdown') > 0);
    expect(rec.count('session_shutdown')).toBe(1);
    expect(pool.getSession(tracked.sessionFile)).toBeFalsy();
    expect(rec.count('session_start')).toBe(1);
  }, 30_000);

  it('disposeAll (server shutdown) fires session_shutdown exactly once PER live session', async () => {
    const rec = recorder();
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const a = await pool.createNewSession(freshCwd(), undefined, false, false, undefined, true);
    const b = await pool.createNewSession(freshCwd(), undefined, false, false, undefined, true);
    const ids = [a.tracked.sessionId, b.tracked.sessionId];
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(rec.count('session_start', id)).toBe(1);

    await pool.disposeAll();
    for (const id of ids) expect(rec.count('session_shutdown', id)).toBe(1);
    expect(pool.getAllSessions()).toHaveLength(0);
  }, 30_000);

  it('a CLI taking over a live server session shuts its extensions down once, before register returns', async () => {
    const rec = recorder({ shutdownDelayMs: 100 });
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const cwd = freshCwd();
    const { tracked } = await pool.createNewSession(cwd, undefined, false, false);
    const fakeCliWs = { send() {}, close() {} } as any;

    const result = await pool.registerCliSession(tracked.sessionFile, cwd, '', fakeCliWs);
    expect(result.error).toBeUndefined();
    expect(pool.getSession(tracked.sessionFile)?.type).toBe('cli');
    // Awaited, not fire-and-forget: the handler's async tail has run.
    expect(rec.count('session_shutdown')).toBe(1);
    expect(rec.count('session_shutdown_done')).toBe(1);
  }, 30_000);

  it('a failed bind disposes the session, tracks nothing, and reports the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(AgentSession.prototype, 'bindExtensions').mockRejectedValue(new Error('bind exploded'));
    const disposeSpy = vi.spyOn(AgentSession.prototype, 'dispose');
    const rec = recorder();
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });

    const result = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(result.error).toContain('bind exploded');
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(rec.count('session_shutdown')).toBe(1);
    expect(pool.getAllSessions()).toHaveLength(0);
  }, 30_000);

  it('logs extension errors to the journal instead of swallowing them', async () => {
    const errors = captureErrors();
    const rec = recorder({ throwOnStart: 'boom-at-start' });
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension] });
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    // A throwing handler is the extension's failure, not the session's.
    expect(error).toBeUndefined();
    expect(errors.some((e) => e.includes('boom-at-start') && e.includes('session_start'))).toBe(true);
    await pool.destroySession(tracked.sessionFile, 'manual');
  }, 30_000);

  it('logs a slow session_start instead of letting it hang silently', async () => {
    const errors = captureErrors();
    const rec = recorder({ startDelayMs: 200 });
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension], extensionBindWarnAfterMs: 50 });
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(error).toBeUndefined();
    expect(errors.some((e) => e.includes('session_start') && e.includes('still running after 50ms'))).toBe(true);
    await pool.destroySession(tracked.sessionFile, 'manual');
  }, 30_000);

  it('a hung session_shutdown handler cannot block destroy past the timeout', async () => {
    const errors = captureErrors();
    const rec = recorder({ hangOnShutdown: true });
    const pool = new SessionPool(300_000, { extraExtensionFactories: [rec.extension], extensionShutdownTimeoutMs: 100 });
    const { tracked } = await pool.createNewSession(freshCwd(), undefined, false, false);
    const disposeSpy = vi.spyOn((tracked as any).agentSession as AgentSession, 'dispose');

    const started = Date.now();
    await pool.destroySession(tracked.sessionFile, 'manual');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(rec.count('session_shutdown')).toBe(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(errors.some((e) => e.includes('exceeded 100ms'))).toBe(true);
    expect(pool.getSession(tracked.sessionFile)).toBeFalsy();
  }, 30_000);

  it('aborts the in-flight turn BEFORE running session_shutdown handlers', async () => {
    const order: string[] = [];
    const ext: InlineExtension = {
      name: 'order-recorder',
      factory: (pi: ExtensionAPI) => {
        pi.on('session_shutdown', () => {
          order.push('session_shutdown');
        });
      },
    };
    const pool = new SessionPool(300_000, { extraExtensionFactories: [ext] });
    const { tracked } = await pool.createNewSession(freshCwd(), undefined, false, false);
    const agent = ((tracked as any).agentSession as AgentSession).agent;
    const realAbort = agent.abort.bind(agent);
    vi.spyOn(agent, 'abort').mockImplementation(() => {
      order.push('abort');
      realAbort();
    });

    await pool.destroySession(tracked.sessionFile, 'deleted');
    expect(order[0]).toBe('abort');
    expect(order).toContain('session_shutdown');
  }, 30_000);

  it('refuses session-replacing and reload command actions (reload resets providers process-wide)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakeSession = { reload: vi.fn(), waitForIdle: vi.fn(async () => {}) } as unknown as AgentSession;
    const bindings = serverExtensionBindings(fakeSession, 'test');
    expect(bindings.mode).toBe('print');
    expect(bindings.uiContext).toBeUndefined();
    expect(bindings.shutdownHandler).toBeUndefined();
    const actions = bindings.commandContextActions!;
    await actions.reload();
    expect((fakeSession as any).reload).not.toHaveBeenCalled();
    expect(await actions.newSession()).toEqual({ cancelled: true });
    expect(await actions.fork('x')).toEqual({ cancelled: true });
    expect(await actions.switchSession('x')).toEqual({ cancelled: true });
    expect(await actions.navigateTree('x')).toEqual({ cancelled: true });
    await actions.waitForIdle();
    expect((fakeSession as any).waitForIdle).toHaveBeenCalledTimes(1);
  });
});
