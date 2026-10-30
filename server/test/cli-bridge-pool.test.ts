import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionPool } from '../src/session-pool.ts';

/**
 * The pool side of the CLI bridge foundation (ADR 0016):
 *  - a `cli_register` with `isNew` fires the session-created callback, once, and
 *    only when the pool had no entry for the file; without `isNew` (an older
 *    extension, a reconnect, `pi -c`) nothing fires;
 *  - `capabilities` are stored on the entry;
 *  - a forwarded `agent_settled` reaches the pool's event fan-out.
 *
 * No LLM call is made. PI_CODING_AGENT_DIR, WHEREVER_CONFIG_DIR and
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
let realBefore: string;
let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  realBefore = snapshot(REAL_WHEREVER_DIR);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-cli-bridge-pool-')));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
    ['WHEREVER_STATE_DIR', 'wherever-state'],
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
  expect(snapshot(REAL_WHEREVER_DIR)).toBe(realBefore);
});

const fakeCliWs = () => ({ send() {}, close() {}, readyState: 1 }) as any;
const freshCwd = () => fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
const file = (name: string) => path.join(root, `${name}.jsonl`);

describe('CLI bridge registration (pool)', () => {
  it('isNew fires the session-created callback once, with the file and cwd', async () => {
    const pool = new SessionPool(300_000);
    const seen: Array<[string, string]> = [];
    pool.onSessionCreated = (f, cwd) => void seen.push([f, cwd]);
    const cwd = freshCwd();
    const f = file('fresh');
    await pool.registerCliSession(f, cwd, '', fakeCliWs(), false, { isNew: true });
    expect(seen).toEqual([[f, cwd]]);

    // The same session re-registering (a reconnect racing the old socket's
    // cleanup) is not a creation, whatever it claims.
    await pool.registerCliSession(f, cwd, '', fakeCliWs(), false, { isNew: true });
    expect(seen).toHaveLength(1);
    await pool.disposeAll();
  });

  it('without isNew (older extension, reconnect, pi -c) nothing fires', async () => {
    const pool = new SessionPool(300_000);
    let count = 0;
    pool.onSessionCreated = () => void count++;
    const cwd = freshCwd();
    await pool.registerCliSession(file('old-ext'), cwd, '', fakeCliWs());
    await pool.registerCliSession(file('resumed'), cwd, '', fakeCliWs(), false, { isNew: false });
    expect(count).toBe(0);
    await pool.disposeAll();
  });

  it('a throwing session-created callback never fails the register', async () => {
    const pool = new SessionPool(300_000);
    pool.onSessionCreated = () => {
      throw new Error('boom');
    };
    const res = await pool.registerCliSession(file('throws'), freshCwd(), '', fakeCliWs(), false, { isNew: true });
    expect(res.error).toBeUndefined();
    expect(pool.getSession(file('throws'))).not.toBeNull();
    await pool.disposeAll();
  });

  it('stores the capabilities; an older extension reports none', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    await pool.registerCliSession(file('caps'), cwd, '', fakeCliWs(), false, { capabilities: ['agent_settled', 'cli_request'] });
    await pool.registerCliSession(file('nocaps'), cwd, '', fakeCliWs());
    expect(pool.getCliCapabilities(file('caps'))).toEqual(['agent_settled', 'cli_request']);
    expect(pool.getCliCapabilities(file('nocaps'))).toEqual([]);
    expect(pool.getCliCapabilities(file('absent'))).toBeNull();
    await pool.disposeAll();
  });

  it('a forwarded agent_settled reaches the event fan-out, and leaves the idle state alone', async () => {
    const pool = new SessionPool(300_000);
    const f = file('settle');
    await pool.registerCliSession(f, freshCwd(), '', fakeCliWs(), false, { capabilities: ['agent_settled'] });
    const broadcast: string[] = [];
    const fanned: string[] = [];
    pool.onEvent = (_file, e) => void broadcast.push(e.type);
    pool.subscribeEvents((sf, e) => {
      if (sf === f) fanned.push(e.type);
    });
    pool.handleCliEvent(f, { type: 'agent_start' } as any);
    pool.handleCliEvent(f, { type: 'agent_end' } as any);
    const streamingBefore = pool.isStreaming(f);
    pool.handleCliEvent(f, { type: 'agent_settled', aborted: false } as any);
    expect(fanned).toEqual(['agent_start', 'agent_end', 'agent_settled']);
    expect(broadcast).toEqual(['agent_start', 'agent_end', 'agent_settled']);
    expect(pool.isStreaming(f)).toBe(streamingBefore);
    await pool.disposeAll();
  });
});
