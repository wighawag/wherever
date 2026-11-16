import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, maybeSeedAssistantSession, isSameFolder } from '../src/assistant-folder.ts';
import { isAssistantFolderCwd, assistantSessionParts } from '../src/assistant-tools.ts';
import { AssistantController } from '../src/assistant-controller.ts';
import { SessionPool } from '../src/session-pool.ts';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * `assistantFolder` configured through a symlink (`~/assistant -> /data/assistant`)
 * (decisions: work/notes/observations/assistant-hardening-reconnect-symlink-cors-decisions.md). A terminal
 * pi reports its REAL cwd, the web sends whatever path the user typed, and the
 * config may name either: every "is this the assistant folder (or its jobs/)"
 * check must treat the link and its target as the same folder, and an unrelated
 * folder never as it.
 *
 * Isolation: every folder, PI_CODING_AGENT_DIR, WHEREVER_CONFIG_DIR and
 * WHEREVER_STATE_DIR are temp dirs; the real ~/.wherever is asserted untouched.
 */

const REAL_WHEREVER_DIR = path.join(os.homedir(), '.wherever');
const snapshot = (d: string) => {
  try {
    return fs.readdirSync(d).sort().map((n) => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`).join(',');
  } catch {
    return 'ABSENT';
  }
};
const realBefore = snapshot(REAL_WHEREVER_DIR);

// The in-process SessionPool reads PI_CODING_AGENT_DIR (model runtime) and the
// wherever config/state dirs: point all three at a temp root, like the other
// in-process pool tests.
let envRoot: string;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  envRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-symlink-env-')));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
    ['WHEREVER_STATE_DIR', 'wherever-state'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(envRoot, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(envRoot, { recursive: true, force: true });
  expect(snapshot(REAL_WHEREVER_DIR)).toBe(realBefore);
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A temp root with `real/` (the folder, with jobs/), `link -> real`, and `other/`. */
function layout(opts: { jobs?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-symlink-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'real');
  fs.mkdirSync(opts.jobs === false ? real : path.join(real, 'jobs'), { recursive: true });
  const link = path.join(root, 'link');
  fs.symlinkSync(real, link);
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(other, 'jobs'), { recursive: true });
  return { root, real, link, other };
}

describe('canonicalPath', () => {
  it('resolves a symlink to its target, and keeps a non-existing tail under it', () => {
    const { real, link, root } = layout({ jobs: false });
    expect(canonicalPath(link)).toBe(real);
    expect(canonicalPath(link + '/')).toBe(real);
    expect(canonicalPath(path.join(link, 'jobs'))).toBe(path.join(real, 'jobs'));
    expect(canonicalPath(path.join(root, 'nope', 'deeper'))).toBe(path.join(root, 'nope', 'deeper'));
  });

  it('isSameFolder: link and target are the same folder, a sibling is not', () => {
    const { real, link, other } = layout();
    expect(isSameFolder(link, real)).toBe(true);
    expect(isSameFolder(real, link)).toBe(true);
    expect(isSameFolder(other, link)).toBe(false);
  });
});

describe('isAssistantFolderCwd (the timezone line) with a symlinked folder', () => {
  it('the folder and its jobs/ match through the link in both directions; an unrelated folder never does', () => {
    const { real, link, other } = layout();
    for (const [cwd, folder] of [
      [real, link],
      [link, real],
      [path.join(real, 'jobs'), link],
      [path.join(link, 'jobs'), real],
    ]) {
      expect(isAssistantFolderCwd(cwd, folder), `${cwd} vs ${folder}`).toBe(true);
    }
    expect(isAssistantFolderCwd(other, link)).toBe(false);
    expect(isAssistantFolderCwd(path.join(other, 'jobs'), link)).toBe(false);
    expect(isAssistantFolderCwd(path.join(real, 'notes'), link)).toBe(false);
  });

  it('assistantSessionParts adds the timezone line for the real cwd under a symlinked folder', () => {
    const { real, other, link } = layout();
    const hooks = { folder: link, access: () => ({ ok: false as const, error: 'off' }) } as any;
    const caller = () => ({ sessionId: null, cwd: real }) as any;
    expect(assistantSessionParts(hooks, real, caller).extensionFactories).toHaveLength(1);
    expect(assistantSessionParts(hooks, other, caller).extensionFactories).toHaveLength(0);
  });
});

describe('maybeSeedAssistantSession with a symlinked folder', () => {
  it('re-seeds when the session cwd is the real path of a symlinked folder, never for another folder', () => {
    const { real, link, other } = layout();
    maybeSeedAssistantSession(real, link);
    expect(fs.existsSync(path.join(real, 'AGENTS.md'))).toBe(true);
    maybeSeedAssistantSession(other, link);
    expect(fs.existsSync(path.join(other, 'AGENTS.md'))).toBe(false);
  });
});

describe('AssistantController with a symlinked folder (real pool, CLI-registered sessions)', () => {
  const fakeCliWs = () => ({ send() {}, close() {}, readyState: 1 }) as any;

  it('a fresh terminal pi at the REAL path moves the pointer when the folder is configured through the link (and vice versa)', async () => {
    for (const via of ['link', 'real'] as const) {
      const { root, real, link, other } = layout();
      const stateDir = path.join(root, 'state');
      fs.mkdirSync(stateDir);
      const pool = new SessionPool(300_000);
      const ctl = new AssistantController({ pool: pool as any, folder: via === 'link' ? link : real, stateDir });
      pool.onSessionCreated = (f, cwd) => void ctl.handleSessionCreated(f, cwd);
      const cwdOf = (p: string) => (via === 'link' ? p : p.replace(real, link)); // the OTHER spelling

      await pool.registerCliSession(path.join(root, 'job.jsonl'), cwdOf(path.join(real, 'jobs')), '', fakeCliWs(), false, { isNew: true });
      await pool.registerCliSession(path.join(root, 'other.jsonl'), other, '', fakeCliWs(), false, { isNew: true });
      await ctl.idle();
      expect(ctl.status().currentSessionFile, via).toBeNull();

      const fresh = path.join(root, 'fresh.jsonl');
      await pool.registerCliSession(fresh, cwdOf(real), '', fakeCliWs(), false, { isNew: true });
      await ctl.idle();
      expect(ctl.status().currentSessionFile, via).toBe(fresh);
      await pool.disposeAll();
    }
  });

  it('a pointer recorded under one spelling of the folder is kept under the other', async () => {
    const { root, real, link } = layout();
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir);
    const pool = new SessionPool(300_000);
    const first = new AssistantController({ pool: pool as any, folder: link, stateDir });
    pool.onSessionCreated = (f, cwd) => void first.handleSessionCreated(f, cwd);
    const fresh = path.join(root, 'fresh.jsonl');
    await pool.registerCliSession(fresh, real, '', fakeCliWs(), false, { isNew: true });
    await first.idle();
    expect(first.status().currentSessionFile).toBe(fresh);
    const second = new AssistantController({ pool: pool as any, folder: real, stateDir });
    expect(second.status().currentSessionFile).toBe(fresh);
    await pool.disposeAll();
  });
});

// --- real server -----------------------------------------------------------

async function boot(root: string, config: Record<string, unknown>): Promise<Harness> {
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  const h = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir } });
  cleanups.push(() => h.cleanup());
  return h;
}

async function client(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

async function assistantStatus(port: number): Promise<any> {
  return (await (await fetch(`http://127.0.0.1:${port}/config`)).json()).assistant;
}

async function until(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe('symlinked assistantFolder (real server)', () => {
  it('a terminal pi at the real path takes the pointer, and assistant_info names the real path', async () => {
    const { root, real, link } = layout();
    const h = await boot(root, { assistantFolder: link });
    const sessions = path.join(root, 'cli-sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const fresh = path.join(sessions, 'fresh.jsonl');
    const cli = await client(h);
    cli.send({ type: 'cli_register', sessionFile: fresh, cwd: real, model: 'fake:fake-model', isStreaming: false, isNew: true, capabilities: ['agent_settled', 'cli_request'] });
    await h.waitForActive(fresh);
    expect(await until(async () => (await assistantStatus(h.port)).currentSessionFile === fresh, 5_000)).toBe(true);

    const id = crypto.randomUUID();
    cli.send({ type: 'cli_request', id, op: 'assistant_info' });
    const info = await cli.waitFor((m) => m.type === 'cli_response' && m.id === id);
    expect(info).toMatchObject({ ok: true, result: { assistantFolder: real } });
  }, 60_000);

  it('a web session_new at the real path of a symlinked folder moves the pointer', async () => {
    const { root, real, link } = layout();
    const h = await boot(root, { assistantFolder: link });
    const c = await client(h);
    c.send({ type: 'session_new', cwd: real });
    const created = await c.waitFor((m) => m.type === 'session_created');
    expect(await until(async () => (await assistantStatus(h.port)).currentSessionFile === created.sessionFile, 5_000)).toBe(true);
  }, 60_000);
});
