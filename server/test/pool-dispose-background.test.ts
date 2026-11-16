import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionPool } from '../src/session-pool.ts';

/**
 * A disposed pool does no more background work. `initialize()` starts the
 * session-index warm-up without awaiting it; when it finished after
 * `disposeAll()` it still read the wherever config, by then under whatever env
 * the process had. In CI that was the runner's real home: a test file restored
 * `WHEREVER_CONFIG_DIR` in afterAll, the late warm-up called
 * `getWhereverConfig()`, and it seeded `~/.wherever/config.json` (seen as an
 * intermittent failure of assistant-scheduler-server.test.ts's real-dir guard).
 *
 * Isolation: PI_CODING_AGENT_DIR and WHEREVER_CONFIG_DIR are temp dirs, and the
 * config dir is SWITCHED to an empty one right after dispose to catch a late read.
 */

let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-pool-dispose-')));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'config-before'],
    ['WHEREVER_STATE_DIR', 'state'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
  // Enough sessions that the warm-up's scan is still running at dispose.
  const sessions = path.join(process.env.PI_CODING_AGENT_DIR!, 'sessions', '--tmp-x--');
  fs.mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < 200; i++) {
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    fs.writeFileSync(
      path.join(sessions, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/x' }) + '\n',
    );
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('SessionPool after disposeAll', () => {
  it('the startup warm-up never reads (or seeds) the config once the pool is disposed', async () => {
    const pool = new SessionPool(300_000);
    await pool.initialize();
    await pool.disposeAll();
    const after = path.join(root, 'config-after');
    fs.mkdirSync(after);
    process.env.WHEREVER_CONFIG_DIR = after;
    await new Promise((r) => setTimeout(r, 1_000));
    expect(fs.readdirSync(after)).toEqual([]);
  }, 30_000);
});
