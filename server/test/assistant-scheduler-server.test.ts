import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

/**
 * The scheduler against the REAL server: it runs only while the assistant is
 * ACTIVE. With `assistantFolder` unset, or the folder lock held by another
 * server, it never starts: the state dir is left exactly as it was (no run log,
 * no timezone state) and a due job in `schedule.json` never fires. With it
 * active, the timezone state is initialised and an `at: "now"` isolated job
 * runs in `jobs/`, recorded in the run log.
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-scheduler-srv-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function dirsFor(root: string, name: string) {
  const configDir = path.join(root, `${name}-config`);
  const stateDir = path.join(root, `${name}-state`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { configDir, stateDir };
}

async function boot(root: string, name: string, config: Record<string, unknown>): Promise<Harness> {
  const { configDir, stateDir } = dirsFor(root, name);
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

const NOW_JOB = { id: 'iso', name: 'Iso', at: 'now', mode: 'isolated', prompt: 'side work', enabled: true };

async function until(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('assistant scheduler (real server)', () => {
  it('assistantFolder unset: never starts, the state dir is unchanged', async () => {
    const root = tmp();
    const { stateDir } = dirsFor(root, 'a');
    fs.writeFileSync(path.join(stateDir, 'keep.txt'), 'pre-existing');
    const before = snapshotDir(stateDir);
    const h = await boot(root, 'a', {});
    expect((await getConfig(h.port)).assistant.active).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    await h.stop();
    expect(snapshotDir(stateDir)).toBe(before);
  }, 60_000);

  it('lock held by another server: the refused server never starts its scheduler', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const first = await boot(root, 'first', { assistantFolder: folder });
    expect((await getConfig(first.port)).assistant.active).toBe(true);
    // Stop nothing: the first server keeps the lock. Its scheduler owns the folder.
    const { stateDir } = dirsFor(root, 'second');
    const before = snapshotDir(stateDir);
    const second = await boot(root, 'second', { assistantFolder: folder });
    expect((await getConfig(second.port)).assistant.lock.state).toBe('refused');
    await new Promise((r) => setTimeout(r, 300));
    await second.stop();
    expect(snapshotDir(stateDir)).toBe(before);
  }, 90_000);

  it('active: initialises the timezone state and runs an `at: "now"` isolated job in jobs/', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'schedule.json'), JSON.stringify({ jobs: [NOW_JOB] }));
    const h = await boot(root, 'c', { assistantFolder: folder });
    expect((await getConfig(h.port)).assistant.active).toBe(true);
    const stateDir = path.join(root, 'c-state');
    const runsFile = path.join(stateDir, 'assistant-runs.jsonl');
    await until(() => fs.existsSync(runsFile));
    const tz = JSON.parse(fs.readFileSync(path.join(stateDir, 'assistant-timezone.json'), 'utf8'));
    expect(typeof tz.timezone).toBe('string');
    expect(tz.history[0].source).toBe('system');
    const entry = JSON.parse(fs.readFileSync(runsFile, 'utf8').trim().split('\n')[0]);
    expect(entry).toMatchObject({ jobId: 'iso', mode: 'isolated', outcome: 'fired' });
    expect(entry.sessionFile).toEqual(expect.any(String));
    // The intent file is never written by the server.
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'schedule.json'), 'utf8'))).toEqual({ jobs: [NOW_JOB] });
    // The job reached the model.
    await until(() => h.fake.requests().some((r) => JSON.stringify(r.messages).includes('[schedule:Iso] side work')));
  }, 60_000);
});
