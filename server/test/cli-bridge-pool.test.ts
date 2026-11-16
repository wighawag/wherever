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

/**
 * A bridge reconnect whose `cli_register` lands BEFORE the old socket's close
 * handler runs (seen once as a flaky cli-bridge-foundation-server test). The
 * old socket's teardown must
 * not remove, or hand back to the server, the registration that replaced it.
 */
describe('CLI bridge reconnect vs the old socket closing (pool)', () => {
  const cliOf = (pool: SessionPool, f: string) => {
    const t = pool.getSession(f);
    return t?.type === 'cli' ? t.cliWs : null;
  };

  it("the old socket's close leaves the fresh registration registered and resident", async () => {
    const pool = new SessionPool(300_000);
    const f = file('race-plain');
    const cwd = freshCwd();
    const a = fakeCliWs();
    const b = fakeCliWs();
    await pool.registerCliSession(f, cwd, '', a);
    await pool.registerCliSession(f, cwd, '', b);
    await pool.unregisterCliSession(f, a);
    expect(cliOf(pool, f)).toBe(b);
    await pool.disposeAll();
  });

  it('with a viewer attached, the old close does not hand the session back to a server agent', async () => {
    const pool = new SessionPool(300_000);
    const f = file('race-viewer');
    const cwd = freshCwd();
    const a = fakeCliWs();
    const b = fakeCliWs();
    (await pool.registerCliSession(f, cwd, '', a)).tracked.clients.add('viewer');
    await pool.registerCliSession(f, cwd, '', b);
    await pool.unregisterCliSession(f, a);
    expect(cliOf(pool, f)).toBe(b);
    expect(pool.getSession(f)?.clients.has('viewer')).toBe(true);
    await pool.disposeAll();
  });

  it('the OTHER order: a reconnect landing while the handoff reload is still building is not overwritten by it', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    const { tracked, error } = await pool.createNewSession(cwd, undefined, false, false);
    expect(error).toBeUndefined();
    const f = tracked.sessionFile;
    // On disk, so the handoff really rebuilds a server agent (pi writes the
    // file only once a conversation starts).
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, JSON.stringify({ type: 'session', version: 3, id: tracked.sessionId, timestamp: new Date().toISOString(), cwd }) + '\n');
    }
    const a = fakeCliWs();
    const b = fakeCliWs();
    (await pool.registerCliSession(f, cwd, '', a)).tracked.clients.add('viewer');
    // A closes FIRST: with a viewer attached the server agent is rebuilt (slow).
    const handoff = pool.unregisterCliSession(f, a);
    // B reconnects while that build is pending.
    await pool.registerCliSession(f, cwd, '', b);
    await handoff;
    expect(cliOf(pool, f)).toBe(b);
    expect(pool.getSession(f)?.clients.has('viewer')).toBe(true);
    await pool.disposeAll();
  }, 30_000);

  it('a reconnecting socket that closes while its register waits never leaves a dead entry (the rebuilt agent survives with the viewer)', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    const { tracked } = await pool.createNewSession(cwd, undefined, false, false);
    const f = tracked.sessionFile;
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, JSON.stringify({ type: 'session', version: 3, id: tracked.sessionId, timestamp: new Date().toISOString(), cwd }) + '\n');
    }
    const a = fakeCliWs();
    const b = fakeCliWs();
    (await pool.registerCliSession(f, cwd, '', a)).tracked.clients.add('viewer');
    const handoff = pool.unregisterCliSession(f, a);
    const reg = pool.registerCliSession(f, cwd, '', b); // waits for the rebuild
    b.readyState = 3; // B dies during that wait; its close found no entry to remove
    const res = await reg;
    await handoff;
    expect(res.error).toBeTruthy();
    expect(pool.getSession(f)?.type).toBe('server');
    expect(pool.getSession(f)?.clients.has('viewer')).toBe(true);
    await pool.disposeAll();
  }, 30_000);

  // Which path runs depends on whether the build or the header read ends first:
  // the register restarting on a landed server entry (and taking it over), or
  // loadSession's raced branch disposing its agent. Either way the bridge wins.
  it('a load racing a register that began first never ends as the entry', async () => {
    const pool = new SessionPool(300_000);
    const cwd = freshCwd();
    const { tracked } = await pool.createNewSession(cwd, undefined, false, false);
    const f = tracked.sessionFile;
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, JSON.stringify({ type: 'session', version: 3, id: tracked.sessionId, timestamp: new Date().toISOString(), cwd }) + '\n');
    }
    await pool.destroySession(f, 'test'); // nothing resident: register must read the header
    const b = fakeCliWs();
    const reg = pool.registerCliSession(f, cwd, '', b); // past the pending check, reading the header
    const load = pool.loadSession(f, cwd); // starts building a server agent meanwhile
    expect((await reg).error).toBeUndefined();
    expect((await load).error).toBeUndefined();
    expect(cliOf(pool, f)).toBe(b);
    await pool.disposeAll();
  }, 30_000);

  it("the CURRENT socket's close still unregisters", async () => {
    const pool = new SessionPool(300_000);
    const f = file('race-current');
    const cwd = freshCwd();
    const a = fakeCliWs();
    const b = fakeCliWs();
    await pool.registerCliSession(f, cwd, '', a);
    await pool.registerCliSession(f, cwd, '', b);
    await pool.unregisterCliSession(f, b);
    expect(pool.getSession(f)).toBeNull();
    await pool.disposeAll();
  });

  it("an idle timer armed for the old registration never evicts the new one", async () => {
    const pool = new SessionPool(40);
    const f = file('race-idle');
    const cwd = freshCwd();
    const a = fakeCliWs();
    const b = fakeCliWs();
    await pool.registerCliSession(f, cwd, '', a);
    pool.handleCliEvent(f, { type: 'agent_start' } as any);
    pool.handleCliEvent(f, { type: 'agent_end' } as any); // arms A's idle timer
    await pool.registerCliSession(f, cwd, '', b, true); // B reconnects mid-turn
    await pool.unregisterCliSession(f, a);
    await new Promise((r) => setTimeout(r, 120));
    expect(cliOf(pool, f)).toBe(b);
    await pool.disposeAll();
  });

  it("an idle timer only ever evicts the entry it was armed for, even when nobody cancelled it", async () => {
    const pool = new SessionPool(40);
    const f = file('race-idle-uncancelled');
    const cwd = freshCwd();
    await pool.registerCliSession(f, cwd, '', fakeCliWs());
    pool.handleCliEvent(f, { type: 'agent_start' } as any);
    pool.handleCliEvent(f, { type: 'agent_end' } as any); // arms the timer on this entry
    // A replacement that does NOT go through registerCliSession's cancel (a
    // future path that forgets to): the armed timer must leave it alone.
    const old = pool.getSession(f)!;
    const replacement = { ...old, idleTimer: null, cliWs: fakeCliWs() };
    (pool as any).sessions.set(f, replacement);
    await new Promise((r) => setTimeout(r, 120));
    expect(pool.getSession(f)).toBe(replacement);
    await pool.disposeAll();
  });

  it('a pinned (assistant) session stays pinned and resident across the race', async () => {
    const pool = new SessionPool(40);
    const f = file('race-pinned');
    const cwd = freshCwd();
    const a = fakeCliWs();
    const b = fakeCliWs();
    await pool.registerCliSession(f, cwd, '', a);
    pool.pinSession(f);
    await pool.registerCliSession(f, cwd, '', b);
    await pool.unregisterCliSession(f, a);
    pool.handleCliEvent(f, { type: 'agent_start' } as any);
    pool.handleCliEvent(f, { type: 'agent_end' } as any); // would arm idle if unpinned
    await new Promise((r) => setTimeout(r, 120));
    expect(cliOf(pool, f)).toBe(b);
    await pool.disposeAll();
  });
});
