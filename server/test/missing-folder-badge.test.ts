import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

/**
 * The session BROWSER half of the folder-missing state, at its wire seam: on a
 * freshly migrated machine most working folders are absent, and opening every
 * conversation one by one is the only way to find that out today. `GET /sessions`
 * therefore reports, per FOLDER, whether that folder exists on this machine, and
 * the dashboard chips the ones that do not.
 *
 * `missing` is ORTHOGONAL to the folder's `readOnly` flag (a `sessions.readOnly`
 * policy rule): a folder can be either, both or neither, and they are two facts,
 * not one.
 *
 * Isolation (WORK-CONTRACT.md), pulled in the SERVER's environment because both
 * the home guard and the existence check resolve inside the server process:
 *  - `HOME` points at a temp directory, so every folder here (and every restore
 *    target) is under it and the developer's real home is asserted untouched;
 *  - git config is neutralised, since the restore that proves the invalidation
 *    `git init`s a folder.
 * No network, no SSH key and no provider CLI: the CREATE remedy talks to nothing.
 */

const REAL_HOME = os.homedir();
const realHomeBefore = new Set(fs.readdirSync(REAL_HOME));

let root = '';
let fakeHome = '';

const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Wherever Test',
  GIT_AUTHOR_EMAIL: 'test@wherever.invalid',
  GIT_COMMITTER_NAME: 'Wherever Test',
  GIT_COMMITTER_EMAIL: 'test@wherever.invalid',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'init.defaultBranch',
  GIT_CONFIG_VALUE_0: 'main',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-missing-badge-')));
  fakeHome = path.join(root, 'home');
  fs.mkdirSync(fakeHome);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  const added = fs.readdirSync(REAL_HOME).filter((e) => !realHomeBefore.has(e));
  expect(added.filter((e) => /wherever-missing-badge|badge-folder/.test(e))).toEqual([]);
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

interface ListedFolder {
  path: string;
  name: string;
  missing?: boolean;
  readOnly?: boolean;
  sessions: Array<{ path: string; id: string }>;
}

async function listFolders(port: number): Promise<ListedFolder[]> {
  const res = await fetch(`http://127.0.0.1:${port}/sessions`);
  expect(res.ok).toBe(true);
  const data = (await res.json()) as { folders: ListedFolder[] };
  return data.folders;
}

const folderAt = (folders: ListedFolder[], dir: string): ListedFolder | undefined =>
  folders.find((f) => f.path === dir);

let seq = 0;
function workFolder(): string {
  return path.join(fakeHome, `badge-folder-${++seq}`);
}

/** Create a session in `cwd` and give it one real turn, so it is listed. */
async function seedSession(harness: Harness, cwd: string): Promise<string> {
  fs.mkdirSync(cwd, { recursive: true });
  const c = await harness.connect();
  await c.waitForType('connected');
  c.send({ type: 'session_new', cwd });
  const created = await c.waitForType('session_created', 30_000);
  c.send({ type: 'message', message: 'hello', sessionId: created.sessionId });
  await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
  await c.waitForType('agent_end', 30_000);
  c.close();
  await sleep(300);
  return created.sessionFile as string;
}

describe('GET /sessions marks folders that do not exist on this machine', () => {
  it('reports a removed folder as missing and an existing one as present', async () => {
    h = await startHarness({
      initial: { kind: 'reply', text: 'seeded' },
      idleTimeoutMs: 0,
      env: { HOME: fakeHome, ...GIT_ENV },
    });
    const present = workFolder();
    const gone = workFolder();
    await seedSession(h, present);
    const goneSession = await seedSession(h, gone);

    // The machine migration in one line: the transcript survives, the folder
    // does not.
    fs.rmSync(gone, { recursive: true, force: true });

    const folders = await listFolders(h.port);
    const presentFolder = folderAt(folders, present);
    const goneFolder = folderAt(folders, gone);

    expect(presentFolder, `${present} missing from /sessions`).toBeDefined();
    expect(goneFolder, `${gone} missing from /sessions`).toBeDefined();
    expect(presentFolder!.missing).toBeFalsy();
    expect(goneFolder!.missing).toBe(true);

    // The listing is otherwise untouched: a missing folder still lists its
    // sessions (reading a conversation never needed the folder), and the
    // orthogonal readOnly flag is not co-opted to carry this.
    expect(goneFolder!.sessions.map((s) => s.path)).toContain(goneSession);
    expect(goneFolder!.readOnly).toBeFalsy();
  }, 180_000);

  it('drops the mark when a restore completes, with no manual refresh', async () => {
    h = await startHarness({
      initial: { kind: 'reply', text: 'seeded' },
      idleTimeoutMs: 0,
      env: { HOME: fakeHome, ...GIT_ENV },
    });
    const gone = workFolder();
    const sessionFile = await seedSession(h, gone);
    fs.rmSync(gone, { recursive: true, force: true });

    expect(folderAt(await listFolders(h.port), gone)!.missing).toBe(true);

    // Repeat listings must keep saying missing (the cached answer is right).
    expect(folderAt(await listFolders(h.port), gone)!.missing).toBe(true);

    // The user's actual path to a restore: open the session, which locks itself
    // folder-missing, then restore from the panel.
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_load', sessionFile });
    await c.waitForType('folder_missing', 20_000);
    c.send({ type: 'restore_start', targetPath: gone, action: 'create', gitInit: true });
    await c.waitForType('restore_started', 20_000);
    const done = await c.waitFor((m) => m.type === 'restore_complete', 60_000);
    expect((done.job as { state: string }).state).toBe('done');
    expect(fs.statSync(gone).isDirectory()).toBe(true);

    // The cached "missing" would otherwise outlive the restore for its whole TTL.
    // The listing is asked immediately, on purpose.
    const after = folderAt(await listFolders(h.port), gone);
    expect(after, `${gone} missing from /sessions`).toBeDefined();
    expect(after!.missing).toBeFalsy();
  }, 180_000);
});
