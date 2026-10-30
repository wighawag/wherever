import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

/**
 * The assistant folder against the REAL server: `assistantFolder` is opt-in, the
 * folder is seeded and locked at start, the status reaches the web through
 * `GET /config` beside `searchFolder`, a second server on the same folder refuses
 * the assistant, and session creation in the folder re-seeds (only there).
 *
 * Isolation: `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR`
 * all point at temp dirs, and the real ~/.wherever is asserted untouched.
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-srv-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function boot(root: string, name: string, config: Record<string, unknown>): Promise<Harness> {
  const configDir = path.join(root, `${name}-config`);
  const stateDir = path.join(root, `${name}-state`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  const h = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir } });
  cleanups.push(() => h.cleanup());
  return h;
}

async function getConfig(port: number): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/config`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('assistantFolder (real server)', () => {
  it('unset: status is "not configured" and nothing assistant-shaped is written', async () => {
    const root = tmp();
    const h = await boot(root, 'a', { searchFolder: path.join(root, 'searches') });
    const cfg = await getConfig(h.port);
    expect(cfg.assistant).toEqual({ configured: false, folder: null, active: false, lock: null });
    // Alongside searchFolder.
    expect(cfg.searchFolder).toBe(path.join(root, 'searches'));
    expect(fs.readdirSync(path.join(root, 'a-state'))).not.toContain('.assistant.lock');
    expect(fs.existsSync(path.join(root, 'assistant'))).toBe(false);
  }, 60_000);

  it('set: seeds the folder, takes the lock, reports it, and releases it on stop', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, 'a', { assistantFolder: folder });
    const cfg = await getConfig(h.port);
    expect(cfg.assistant).toEqual({
      configured: true,
      folder,
      active: true,
      lock: { state: 'held' },
      // The current-session pointer (assistant-pointer-and-reset): none yet.
      currentSessionId: null,
      currentSessionFile: null,
    });
    expect(fs.existsSync(path.join(folder, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'jobs', 'AGENTS.md'))).toBe(true);
    expect(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8')).toContain('.assistant.lock');
    const lock = JSON.parse(fs.readFileSync(path.join(folder, '.assistant.lock'), 'utf8'));
    expect(lock.host).toBe(os.hostname());
    expect(typeof lock.pid).toBe('number');
    await h.stop();
    expect(fs.existsSync(path.join(folder, '.assistant.lock'))).toBe(false);
  }, 60_000);

  it('never overwrites seed files across restarts', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), 'MY ASSISTANT\n');
    const h = await boot(root, 'a', { assistantFolder: folder });
    expect((await getConfig(h.port)).assistant.active).toBe(true);
    expect(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8')).toBe('MY ASSISTANT\n');
    expect(fs.existsSync(path.join(folder, 'jobs', 'AGENTS.md'))).toBe(true);
  }, 60_000);

  it('a second server on the same folder refuses the assistant (live lock)', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const first = await boot(root, 'first', { assistantFolder: folder });
    expect((await getConfig(first.port)).assistant.active).toBe(true);
    const lockBefore = fs.readFileSync(path.join(folder, '.assistant.lock'), 'utf8');

    // A different state dir on purpose: that is the case a state-dir lock would miss (ADR 0018).
    const second = await boot(root, 'second', { assistantFolder: folder });
    const status = (await getConfig(second.port)).assistant;
    expect(status.configured).toBe(true);
    expect(status.active).toBe(false);
    expect(status.lock.state).toBe('refused');
    expect(status.lock.reason).toBe('live-lock');
    expect(status.lock.holder.pid).toBe(JSON.parse(lockBefore).pid);
    expect(status.lock.message).toMatch(/another wherever server/i);
    // The first server still owns the lock, and stopping the second leaves it there.
    await second.stop();
    expect(fs.readFileSync(path.join(folder, '.assistant.lock'), 'utf8')).toBe(lockBefore);
  }, 90_000);

  it('session creation re-seeds the assistant folder, and only that folder', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, 'a', { assistantFolder: folder });
    fs.rmSync(path.join(folder, 'AGENTS.md'));

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: folder });
    await c.waitForType('session_created');
    expect(fs.existsSync(path.join(folder, 'AGENTS.md'))).toBe(true);

    const other = path.join(root, 'elsewhere');
    fs.mkdirSync(other);
    const c2 = await h.connect();
    await c2.waitForType('connected');
    c2.send({ type: 'session_new', cwd: other });
    await c2.waitForType('session_created');
    expect(fs.existsSync(path.join(other, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(other, '.gitignore'))).toBe(false);
  }, 60_000);
});
