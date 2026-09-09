import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

/**
 * The SECOND remedy of the restore panel at its protocol seam: a folder that was
 * never a clone (a scratch directory, a folder whose contents only ever lived on
 * the old machine) is restored by CREATING it.
 *
 * It is the same protocol, the same path-keyed job and the same state machine as
 * the clone -- `restore_start { action: 'create', gitInit }` instead of
 * `action: 'clone', url`, then the identical `restore_progress` /
 * `restore_complete` frames and the identical reload-to-go-live ending. That
 * sameness IS the property under test, so what is asserted here is what only the
 * create kind can be asked: that the directory (and its missing parents) really
 * appear, that the git-init CHECKBOX decides whether the result is a repository
 * or a plain directory, and that the safety refusals are the clone's, not a
 * looser set.
 *
 * Isolation (WORK-CONTRACT.md), the same levers as `restore-clone-panel.test.ts`
 * and pulled in the SERVER's environment because the home guard resolves
 * `os.homedir()` inside the server process:
 *  - `HOME` points at a temp directory, so every restore target is under it and
 *    the developer's real home is asserted untouched;
 *  - git config is neutralised (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at
 *    /dev/null) with an explicit identity and `init.defaultBranch`, so the
 *    `git init` this suite performs neither reads nor writes `~/.gitconfig`.
 * No network, no SSH key and no provider CLI are involved at all: creating a
 * folder talks to nothing.
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
  // With no global config to read, `git init` would otherwise print its advice
  // about the default branch name on every call.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'init.defaultBranch',
  GIT_CONFIG_VALUE_0: 'main',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-restore-create-')));
  fakeHome = path.join(root, 'home');
  fs.mkdirSync(fakeHome);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  const added = fs.readdirSync(REAL_HOME).filter((e) => !realHomeBefore.has(e));
  expect(added.filter((e) => /wherever-restore-create|restore-target/.test(e))).toEqual([]);
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

let targetSeq = 0;
/**
 * A fresh path inside the SERVER's (temp) home, TWO levels below anything that
 * exists: creating it has to make the missing parents too.
 */
function targetPath(): string {
  return path.join(fakeHome, 'scratch', `notes-${++targetSeq}`, 'work');
}

async function startCreateHarness(): Promise<Harness> {
  return startHarness({
    initial: { kind: 'reply', text: 'seeded' },
    // Evict on the last client leaving, so a later load is a genuinely COLD one:
    // the path a restored folder has to go live through.
    idleTimeoutMs: 0,
    env: { HOME: fakeHome, ...GIT_ENV },
  });
}

/**
 * Create a session in `cwd`, give it one real turn so it has history, then
 * REMOVE the folder: the machine migration in one line.
 */
async function seedMissingSession(harness: Harness, cwd: string): Promise<string> {
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
  // The whole `notes-N` subtree goes, not just the leaf, so the restore has to
  // make the MISSING PARENT back too -- which is what a real migration leaves
  // behind (the tree of clones is absent, not hollowed out).
  fs.rmSync(path.dirname(cwd), { recursive: true, force: true });
  return created.sessionFile as string;
}

/** Open the folder-missing session and return its client and frame. */
async function openMissing(harness: Harness, sessionFile: string) {
  const c = await harness.connect();
  await c.waitForType('connected');
  c.send({ type: 'session_load', sessionFile });
  await c.waitForType('session_created', 20_000);
  const missing = await c.waitForType('folder_missing', 20_000);
  return { c, missing };
}

type JobView = {
  id: number;
  kind: string;
  state: string;
  gitInit?: boolean;
  targetPath: string;
  progress: { phase: string; scope: string; percent: number | null; indeterminate: boolean } | null;
  failure?: { cause: string; message: string; stderr: string };
};

const jobOf = (m: { [k: string]: unknown }): JobView => m.job as JobView;

describe('restoring a missing folder by CREATING it', () => {
  it('makes the folder and its missing parents as a git repository when the checkbox is ON, and goes live after a RELOAD', async () => {
    h = await startCreateHarness();
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c, missing } = await openMissing(h, sessionFile);
    expect(missing.cwd).toBe(target);
    expect(missing.job).toBeUndefined();
    // The parents went with the folder: creating it has to make them back.
    expect(fs.existsSync(path.dirname(target))).toBe(false);

    c.send({ type: 'restore_start', targetPath: target, action: 'create', gitInit: true });
    const started = await c.waitForType('restore_started', 20_000);
    expect(started.outcome).toBe('started');
    expect(jobOf(started).kind).toBe('create');
    expect(jobOf(started).gitInit).toBe(true);
    expect(jobOf(started).targetPath).toBe(target);

    // The SAME completion frame as a clone: one state machine, not two.
    const done = await c.waitFor((m) => m.type === 'restore_complete', 60_000);
    expect(jobOf(done).state).toBe('done');
    expect(jobOf(done).failure).toBeUndefined();

    expect(fs.statSync(target).isDirectory()).toBe(true);
    // Checkbox ON: a real repository, not just a directory with a name.
    expect(fs.statSync(path.join(target, '.git')).isDirectory()).toBe(true);

    // A live agent is a LOAD-TIME decision, so the cure ends in a reload, exactly
    // as the clone remedy does.
    h.setNext({ kind: 'reply', text: 'created and live' });
    c.send({ type: 'session_load', sessionFile });
    const repainted = await c.waitFor(
      (m) => m.type === 'session_created' && m.folderMissing !== true,
      20_000,
    );
    expect(repainted.readOnly).toBeFalsy();
    await c.waitForType('session_ready', 60_000);
    c.send({ type: 'message', message: 'are you back', sessionId: repainted.sessionId });
    const end = await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 60_000);
    expect(end.content).toBe('created and live');
  }, 180_000);

  it('makes a PLAIN directory when the checkbox is OFF', async () => {
    h = await startCreateHarness();
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c } = await openMissing(h, sessionFile);
    c.send({ type: 'restore_start', targetPath: target, action: 'create', gitInit: false });
    const started = await c.waitForType('restore_started', 20_000);
    expect(jobOf(started).gitInit).toBe(false);

    const done = await c.waitFor((m) => m.type === 'restore_complete', 60_000);
    expect(jobOf(done).state).toBe('done');

    expect(fs.statSync(target).isDirectory()).toBe(true);
    // Checkbox OFF means OFF: no surprise repository for a user who turned the
    // configured git-init default off.
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
    expect(fs.readdirSync(target)).toEqual([]);
  }, 180_000);

  it('reports progress under the create phases, with no invented percentage', async () => {
    h = await startCreateHarness();
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c } = await openMissing(h, sessionFile);
    c.send({ type: 'restore_start', targetPath: target, action: 'create', gitInit: true });
    await c.waitForType('restore_started', 20_000);
    await c.waitFor((m) => m.type === 'restore_complete', 60_000);

    const frames = c.messages
      .filter((m) => m.type === 'restore_progress')
      .map((m) => jobOf(m).progress!)
      .filter(Boolean);
    expect(frames.map((f) => f.phase)).toContain('creating');
    expect(frames.map((f) => f.phase)).toContain('initialising');
    // mkdir and git init report no measurable percentage, and the frames say so
    // explicitly rather than sitting at a fake 0%.
    for (const f of frames) {
      expect(f.indeterminate).toBe(true);
      expect(f.percent).toBeNull();
      expect(f.scope).toBe('repository');
    }
  }, 180_000);

  it('refuses exactly what a clone refuses: outside the home directory, and a non-empty target', async () => {
    h = await startCreateHarness();
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c } = await openMissing(h, sessionFile);

    // Outside the server's home. (The server's HOME is this suite's temp home,
    // so /tmp is genuinely outside it -- which is also the proof the isolation
    // lever took.)
    const outside = path.join(root, 'not-home', 'folder');
    c.send({ type: 'restore_start', targetPath: outside, action: 'create', gitInit: true });
    const outsideHome = await c.waitFor(
      (m) => m.type === 'restore_rejected' && m.reason === 'outside-home',
      20_000,
    );
    expect(String(outsideHome.message)).toContain(outside);
    expect(fs.existsSync(outside)).toBe(false);

    // A target that already holds something is refused rather than adopted or
    // git-inited in place: the same rule the clone lives by.
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'not mine to touch\n');
    c.send({ type: 'restore_start', targetPath: target, action: 'create', gitInit: true });
    const notEmpty = await c.waitFor(
      (m) => m.type === 'restore_rejected' && m.reason === 'target-not-empty',
      20_000,
    );
    expect(String(notEmpty.message)).toContain(target);
    expect(fs.readdirSync(target)).toEqual(['keep.txt']);
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('not mine to touch\n');

    // A refusal is not a job: nothing was started for either.
    await sleep(300);
    expect(c.messages.some((m) => m.type === 'restore_started')).toBe(false);
  }, 180_000);
});
