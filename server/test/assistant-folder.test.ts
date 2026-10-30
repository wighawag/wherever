import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSISTANT_AGENTS_MD,
  ASSISTANT_GITIGNORE,
  ASSISTANT_JOBS_AGENTS_MD,
  ASSISTANT_LOCK_FILE,
  acquireAssistantLock,
  decideAssistantLock,
  maybeSeedAssistantSession,
  readBootId,
  readProcessStartTime,
  releaseAssistantLock,
  resolveAssistantFolder,
  seedAssistantFolder,
  startAssistantFolder,
  type AssistantLockRecord,
  type ProcessIdentity,
} from '../src/assistant-folder.ts';

// The assistant folder (spec assistant-session-and-channels, ADR 0018): opt-in via
// `assistantFolder`, seeded once (never overwritten), and guarded by a folder lock
// so two servers configured on one folder report the misconfiguration loudly.
// Every write is isolated in a temp dir; the real ~/.wherever is asserted untouched.

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

let root: string;
const saved: Record<string, string | undefined> = {};
const children: ChildProcess[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-'));
  for (const k of ['WHEREVER_CONFIG_DIR', 'WHEREVER_STATE_DIR']) saved[k] = process.env[k];
  process.env.WHEREVER_CONFIG_DIR = path.join(root, 'config');
  process.env.WHEREVER_STATE_DIR = path.join(root, 'state');
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const c of children.splice(0)) {
    try {
      c.kill('SIGKILL');
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  expect(snapshotDir(REAL_WHEREVER_DIR)).toBe(realBefore);
});

function spawnSleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.once('exit', r));
  return child.pid!;
}

const self: ProcessIdentity = { pid: 100, host: 'here', bootId: 'boot-a', startTime: 'st-100' };
const lock = (over: Partial<AssistantLockRecord>): AssistantLockRecord => ({
  pid: 200,
  host: 'here',
  bootId: 'boot-a',
  startTime: 'st-200',
  ...over,
});

describe('resolveAssistantFolder', () => {
  it('is null when unset or blank (feature off)', () => {
    expect(resolveAssistantFolder({})).toBeNull();
    expect(resolveAssistantFolder({ assistantFolder: '' })).toBeNull();
    expect(resolveAssistantFolder({ assistantFolder: '   ' })).toBeNull();
  });
  it('expands a leading tilde', () => {
    expect(resolveAssistantFolder({ assistantFolder: '~/assistant' })).toBe(path.join(os.homedir(), 'assistant'));
  });
});

describe('decideAssistantLock (pure)', () => {
  const alive = (startTime: string | null) => ({ alive: true, startTime });
  const dead = { alive: false, startTime: null };

  it('takes a missing lock', () => {
    expect(decideAssistantLock(null, self, dead).action).toBe('take');
  });
  it('refuses a live same-host lock', () => {
    const d = decideAssistantLock(lock({}), self, alive('st-200'));
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('live-lock');
  });
  it('takes over a same-host lock whose pid is dead', () => {
    const d = decideAssistantLock(lock({}), self, dead);
    expect(d.action).toBe('takeover');
    expect(d.reason).toBe('dead-pid');
  });
  it('takes over a same-host lock whose pid was reused (different start time)', () => {
    const d = decideAssistantLock(lock({}), self, alive('st-other'));
    expect(d.action).toBe('takeover');
    expect(d.reason).toBe('pid-reused');
  });
  it('takes over a same-host lock from a previous boot, even if the pid is alive', () => {
    const d = decideAssistantLock(lock({ bootId: 'boot-old' }), self, alive('st-200'));
    expect(d.action).toBe('takeover');
    expect(d.reason).toBe('other-boot');
  });
  it('never takes over a lock from another host', () => {
    const d = decideAssistantLock(lock({ host: 'elsewhere', bootId: 'x' }), self, dead);
    expect(d.action).toBe('refuse');
    expect(d.reason).toBe('foreign-host');
  });
  it('degrades to pid-only when boot id / start time are unknown', () => {
    const unknownSelf = { ...self, bootId: null, startTime: null };
    expect(decideAssistantLock(lock({ bootId: null, startTime: null }), unknownSelf, alive(null)).action).toBe('refuse');
    expect(decideAssistantLock(lock({ bootId: null, startTime: null }), unknownSelf, dead).action).toBe('takeover');
  });
  it('treats its own lock (same pid and start time) as held', () => {
    expect(decideAssistantLock(lock({ pid: 100, startTime: 'st-100' }), self, alive('st-100')).action).toBe('take');
  });
  it('takes over an unreadable lock file', () => {
    const d = decideAssistantLock('corrupt', self, dead);
    expect(d.action).toBe('takeover');
    expect(d.reason).toBe('corrupt');
  });
});

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')('process probes', () => {
  it('reads a boot id and a stable start time for this process', () => {
    expect(readBootId()).toBeTruthy();
    const st = readProcessStartTime(process.pid);
    expect(st).toBeTruthy();
    expect(readProcessStartTime(process.pid)).toBe(st);
  });
  it('returns null for a dead pid', async () => {
    expect(readProcessStartTime(await deadPid())).toBeNull();
  });
});

describe('seedAssistantFolder', () => {
  it('creates the folder and the three seed files', () => {
    const folder = path.join(root, 'a', 'assistant');
    seedAssistantFolder(folder);
    expect(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8')).toBe(ASSISTANT_AGENTS_MD);
    expect(fs.readFileSync(path.join(folder, 'jobs', 'AGENTS.md'), 'utf8')).toBe(ASSISTANT_JOBS_AGENTS_MD);
    expect(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8')).toBe(ASSISTANT_GITIGNORE);
    expect(ASSISTANT_GITIGNORE).toContain(ASSISTANT_LOCK_FILE);
  });
  it('never overwrites an existing file', () => {
    const folder = path.join(root, 'assistant');
    fs.mkdirSync(path.join(folder, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), 'MINE\n');
    fs.writeFileSync(path.join(folder, 'jobs', 'AGENTS.md'), 'MY JOBS\n');
    fs.writeFileSync(path.join(folder, '.gitignore'), 'node_modules\n');
    seedAssistantFolder(folder);
    expect(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8')).toBe('MINE\n');
    expect(fs.readFileSync(path.join(folder, 'jobs', 'AGENTS.md'), 'utf8')).toBe('MY JOBS\n');
    expect(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });
  it('the default AGENTS.md covers memory, scheduling, delegation and notify', () => {
    for (const needle of ['memory/', 'assistant_schedule_', 'tz', 'at: "now"', 'assistant_notify', '[schedule:', 'assistant_set_timezone', 'recall_search']) {
      expect(ASSISTANT_AGENTS_MD).toContain(needle);
    }
    expect(ASSISTANT_JOBS_AGENTS_MD).toContain('../memory/');
    expect(ASSISTANT_JOBS_AGENTS_MD).toContain('assistant_notify');
  });
});

describe('maybeSeedAssistantSession (createNewSession hook)', () => {
  it('seeds only when the cwd IS the assistant folder', () => {
    const folder = path.join(root, 'assistant');
    const other = path.join(root, 'other');
    fs.mkdirSync(folder);
    fs.mkdirSync(other);
    maybeSeedAssistantSession(other, folder);
    expect(fs.readdirSync(other)).toEqual([]);
    maybeSeedAssistantSession(folder, folder);
    expect(fs.existsSync(path.join(folder, 'AGENTS.md'))).toBe(true);
  });
  it('is a no-op when the assistant is not configured', () => {
    const folder = path.join(root, 'assistant');
    fs.mkdirSync(folder);
    maybeSeedAssistantSession(folder, undefined);
    expect(fs.readdirSync(folder)).toEqual([]);
  });
});

describe('acquireAssistantLock (real fs + real processes)', () => {
  function writeLock(folder: string, rec: AssistantLockRecord): void {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, ASSISTANT_LOCK_FILE), JSON.stringify(rec));
  }
  const readLock = (folder: string) => JSON.parse(fs.readFileSync(path.join(folder, ASSISTANT_LOCK_FILE), 'utf8'));

  it('takes a free folder and records pid, host, boot id and start time', () => {
    const folder = path.join(root, 'assistant');
    fs.mkdirSync(folder);
    const r = acquireAssistantLock(folder);
    expect(r.state).toBe('held');
    const rec = readLock(folder);
    expect(rec.pid).toBe(process.pid);
    expect(rec.host).toBe(os.hostname());
    expect('bootId' in rec && 'startTime' in rec).toBe(true);
    releaseAssistantLock(folder);
    expect(fs.existsSync(path.join(folder, ASSISTANT_LOCK_FILE))).toBe(false);
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'refuses a live lock held by another process on this host',
    async () => {
      const folder = path.join(root, 'assistant');
      const child = await spawnSleeper();
      const rec = { pid: child.pid!, host: os.hostname(), bootId: readBootId(), startTime: readProcessStartTime(child.pid!) };
      writeLock(folder, rec);
      const r = acquireAssistantLock(folder);
      expect(r.state).toBe('refused');
      if (r.state === 'refused') {
        expect(r.reason).toBe('live-lock');
        expect(r.holder.pid).toBe(child.pid);
        expect(r.message).toMatch(/another wherever server/i);
      }
      // Untouched: the other server still owns it.
      expect(readLock(folder)).toEqual(rec);
      // And releasing from THIS process never removes someone else's lock.
      releaseAssistantLock(folder);
      expect(fs.existsSync(path.join(folder, ASSISTANT_LOCK_FILE))).toBe(true);
    },
  );

  it('takes over a same-host lock whose pid is dead', async () => {
    const folder = path.join(root, 'assistant');
    writeLock(folder, { pid: await deadPid(), host: os.hostname(), bootId: readBootId(), startTime: 'x' });
    expect(acquireAssistantLock(folder).state).toBe('held');
    expect(readLock(folder).pid).toBe(process.pid);
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'takes over a same-host lock whose pid was reused by another process',
    async () => {
      const folder = path.join(root, 'assistant');
      const child = await spawnSleeper();
      writeLock(folder, { pid: child.pid!, host: os.hostname(), bootId: readBootId(), startTime: 'not-its-start-time' });
      expect(acquireAssistantLock(folder).state).toBe('held');
      expect(readLock(folder).pid).toBe(process.pid);
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'takes over a same-host lock from a different boot',
    async () => {
      const folder = path.join(root, 'assistant');
      const child = await spawnSleeper();
      writeLock(folder, {
        pid: child.pid!,
        host: os.hostname(),
        bootId: 'a-previous-boot',
        startTime: readProcessStartTime(child.pid!),
      });
      expect(acquireAssistantLock(folder).state).toBe('held');
    },
  );

  it('never takes over a lock from another host, and says to remove it by hand', async () => {
    const folder = path.join(root, 'assistant');
    const rec = { pid: await deadPid(), host: `not-${os.hostname()}`, bootId: 'b', startTime: 's' };
    writeLock(folder, rec);
    const r = acquireAssistantLock(folder);
    expect(r.state).toBe('refused');
    if (r.state === 'refused') {
      expect(r.reason).toBe('foreign-host');
      expect(r.message).toMatch(/remove/i);
      expect(r.message).toContain(path.join(folder, ASSISTANT_LOCK_FILE));
    }
    expect(readLock(folder)).toEqual(rec);
  });
});

describe('startAssistantFolder (server start)', () => {
  it('with assistantFolder unset: nothing written, status "not configured"', () => {
    const before = fs.readdirSync(root);
    const s = startAssistantFolder({});
    expect(s.status).toEqual({ configured: false, folder: null, active: false, lock: null });
    expect(fs.readdirSync(root)).toEqual(before);
    s.release();
  });

  it('with it set: creates, seeds, locks, and reports held', () => {
    const folder = path.join(root, 'assistant');
    const s = startAssistantFolder({ assistantFolder: folder });
    expect(s.status.configured).toBe(true);
    expect(s.status.folder).toBe(folder);
    expect(s.status.active).toBe(true);
    expect(s.status.lock).toEqual({ state: 'held' });
    expect(fs.existsSync(path.join(folder, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(folder, ASSISTANT_LOCK_FILE))).toBe(true);
    s.release();
    expect(fs.existsSync(path.join(folder, ASSISTANT_LOCK_FILE))).toBe(false);
    // Nothing went to the state dir or config dir.
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'config'))).toBe(false);
  });

  it('reports an inactive assistant when the lock is refused', async () => {
    const folder = path.join(root, 'assistant');
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, ASSISTANT_LOCK_FILE),
      JSON.stringify({ pid: 1, host: `not-${os.hostname()}`, bootId: null, startTime: null }),
    );
    const s = startAssistantFolder({ assistantFolder: folder });
    expect(s.status.configured).toBe(true);
    expect(s.status.active).toBe(false);
    expect(s.status.lock?.state).toBe('refused');
    // A refused server does not seed a folder another server owns.
    expect(fs.existsSync(path.join(folder, 'AGENTS.md'))).toBe(false);
    s.release();
    expect(fs.existsSync(path.join(folder, ASSISTANT_LOCK_FILE))).toBe(true);
  });
});
