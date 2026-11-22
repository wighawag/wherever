import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionPool } from '../src/session-pool.ts';

/**
 * models.json edited while the server runs reaches the model list without a
 * restart. pi's ModelRuntime reads models.json once, at creation, and only
 * re-reads it in `refresh()`, which the pool never called: an operator who
 * added a model to the file saw it in a terminal pi (whose `/model` reloads the
 * file) and not in the web picker until the whole server restarted, taking its
 * in-process sessions with it.
 *
 * REAL pi runtime (ADR 0001), no network: the providers here are never called.
 * PI_CODING_AGENT_DIR, WHEREVER_CONFIG_DIR and WHEREVER_STATE_DIR are temp dirs.
 */

let root: string;
let agentDir: string;
const savedEnv: Record<string, string | undefined> = {};
const pools: SessionPool[] = [];

function writeModels(ids: string[]): void {
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: 'http://127.0.0.1:9',
          api: 'anthropic-messages',
          apiKey: 'test-key',
          models: ids.map((id) => ({ id })),
        },
      },
    }),
  );
}

/** Move the mtime forward, so a same-size rewrite inside one clock tick still reads as changed. */
function bumpMtime(): void {
  const file = path.join(agentDir, 'models.json');
  const later = new Date(fs.statSync(file).mtimeMs + 5_000);
  fs.utimesSync(file, later, later);
}

async function fakeIds(pool: SessionPool): Promise<string[]> {
  return (await pool.getAvailableModels())
    .filter((m) => m.provider === 'fake')
    .map((m) => m.modelId)
    .sort();
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-models-reload-')));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
    ['WHEREVER_STATE_DIR', 'wherever-state'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
  agentDir = process.env.PI_CODING_AGENT_DIR!;
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'one' }));
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.disposeAll()));
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function newPool(): SessionPool {
  const pool = new SessionPool(300_000);
  pools.push(pool);
  return pool;
}

describe('models.json is re-read when it changes', () => {
  it('a model added to or removed from the file shows in the list without a restart', async () => {
    writeModels(['one', 'two']);
    const pool = newPool();
    expect(await fakeIds(pool)).toEqual(['one', 'two']);

    writeModels(['one', 'three']);
    bumpMtime();
    expect(await fakeIds(pool)).toEqual(['one', 'three']);
    // The lookup a session start uses sees the new model too.
    expect(pool.findModel('fake', 'three')?.id).toBe('three');
    expect(pool.findModel('fake', 'two')).toBeUndefined();
  });

  it('a file replaced through a new symlink target is picked up', async () => {
    const a = path.join(root, 'models-a.json');
    const b = path.join(root, 'models-b.json');
    writeModels(['one']);
    fs.renameSync(path.join(agentDir, 'models.json'), a);
    writeModels(['one', 'linked']);
    fs.renameSync(path.join(agentDir, 'models.json'), b);
    fs.symlinkSync(a, path.join(agentDir, 'models.json'));

    const pool = newPool();
    expect(await fakeIds(pool)).toEqual(['one']);

    fs.rmSync(path.join(agentDir, 'models.json'));
    fs.symlinkSync(b, path.join(agentDir, 'models.json'));
    expect(await fakeIds(pool)).toEqual(['linked', 'one']);

    fs.rmSync(path.join(agentDir, 'models.json'));
  });

  it('a broken edit keeps the last good list instead of emptying the picker', async () => {
    writeModels(['one', 'two']);
    const pool = newPool();
    expect(await fakeIds(pool)).toEqual(['one', 'two']);

    fs.writeFileSync(path.join(agentDir, 'models.json'), '{ "providers": { "fake": ');
    bumpMtime();
    expect(await fakeIds(pool)).toEqual(['one', 'two']);

    // And the next good edit is applied.
    writeModels(['four']);
    bumpMtime();
    expect(await fakeIds(pool)).toEqual(['four']);
  });
});
