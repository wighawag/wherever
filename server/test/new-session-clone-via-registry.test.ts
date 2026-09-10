import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startHarness, type Harness } from './harness.js';

/**
 * Creating a NEW session in a folder that does not exist yet, when the user
 * chose to CLONE the existing remote, at its protocol seam.
 *
 * This path used to clone SYNCHRONOUSLY inside `createNewSession`, behind the
 * dashboard's blocking "Creating session..." overlay: no progress, no
 * submodules, and a client watchdog that gave up after 25 seconds while git was
 * still running. It now drives the SAME path-keyed restore job registry the
 * restore panel drives, so there is ONE clone implementation in the codebase.
 *
 * The properties under test are protocol properties, not internals:
 *
 *  - `session_new { cloneRemote: true }` answers with `restore_started` and then
 *    real `restore_progress` frames, so the clone is watchable rather than a
 *    blocking wait that a watchdog has to guess about;
 *  - the clone is RECURSIVE (submodule content lands) and upstream tracking is
 *    configured, which the deleted synchronous helper did by hand;
 *  - the server CONTINUES into session creation itself once the job is `done`
 *    (unlike the loaded-session path there is nothing to reload: the session
 *    does not exist until the clone lands), and the session is genuinely live;
 *  - a FAILED or CANCELLED job fails the create with the mapped cause and leaves
 *    no half-made session behind;
 *  - a create with no clone (an existing folder, or a folder the user wants
 *    created rather than cloned) is untouched by any of this.
 *
 * Isolation (WORK-CONTRACT.md), same levers as `restore-clone-panel.test.ts`:
 * the server runs as a CHILD, so `HOME` and the git config neutralisation are
 * set in ITS environment; the "remote" is a local `file://` fixture and the
 * provider probe is a FAKE `gh` on the server's PATH, so nothing here needs a
 * network, an SSH key or an authenticated provider CLI. The developer's real
 * home is asserted untouched.
 */

const REAL_HOME = os.homedir();
const realHomeBefore = new Set(fs.readdirSync(REAL_HOME));

let root = '';
let fakeHome = '';
let fixturesDir = '';
let fakeBinDir = '';
/** A git template dir whose post-checkout hook sleeps, so a clone is SLOW. */
let slowTemplateDir = '';

const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Wherever Test',
  GIT_AUTHOR_EMAIL: 'test@wherever.invalid',
  GIT_COMMITTER_NAME: 'Wherever Test',
  GIT_COMMITTER_EMAIL: 'test@wherever.invalid',
  // File-transport relaxation, TEST-ONLY: a `file://` submodule is refused by
  // git since 2.38 (CVE-2022-39253). It travels through the environment
  // precisely so the production clone argv never carries it.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
}

function gitOut(args: string[], cwd: string): string {
  return execFileSync('git', args, { env: { ...process.env, ...GIT_ENV }, cwd }).toString().trim();
}

/** `main` carries a submodule, so the recursion is visible in the result. */
function makeFixtures(dir: string): string {
  const fixtures = path.join(dir, 'fixtures');
  const sub = path.join(fixtures, 'sub');
  const main = path.join(fixtures, 'main');
  for (const d of [sub, main]) fs.mkdirSync(d, { recursive: true });

  git(['init', '-q', '-b', 'main'], sub);
  fs.writeFileSync(path.join(sub, 'sub-file.txt'), 'submodule content\n');
  git(['add', '-A'], sub);
  git(['commit', '-qm', 'sub'], sub);

  git(['init', '-q', '-b', 'main'], main);
  fs.writeFileSync(path.join(main, 'README.md'), 'main content\n');
  git(['add', '-A'], main);
  git(['commit', '-qm', 'main'], main);
  git(['submodule', 'add', '-q', `file://${sub}`, 'sub'], main);
  git(['commit', '-qm', 'add submodule'], main);

  return fixtures;
}

/**
 * A FAKE `gh` on the server's PATH: the create path's remote probe
 * (`detectRemoteRepo`) shells out to it, and this is what makes the whole
 * round trip runnable with no provider CLI, no account and no network. It
 * answers `gh repo view <name> --json sshUrl -q .sshUrl` with the fixture of
 * that name, which is why the TARGET FOLDER's basename picks the fixture: the
 * probe is keyed on the repository name, exactly as in production.
 */
function makeFakeGh(dir: string, fixtures: string): string {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(
    gh,
    [
      '#!/bin/sh',
      '[ "$1" = "repo" ] && [ "$2" = "view" ] || exit 1',
      `if [ -d "${fixtures}/$3" ] || [ "$3" = "nope" ]; then`,
      `  echo "file://${fixtures}/$3"`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(gh, 0o755);
  return bin;
}

/** See restore-clone-panel.test.ts: a sleeping hook makes a local clone SLOW. */
function makeSlowTemplate(dir: string): string {
  const template = path.join(dir, 'slow-template');
  fs.mkdirSync(path.join(template, 'hooks'), { recursive: true });
  const hook = path.join(template, 'hooks', 'post-checkout');
  fs.writeFileSync(hook, '#!/bin/sh\nsleep 3\nexit 0\n');
  fs.chmodSync(hook, 0o755);
  return template;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-new-session-clone-')));
  fakeHome = path.join(root, 'home');
  fs.mkdirSync(fakeHome);
  fixturesDir = makeFixtures(root);
  fakeBinDir = makeFakeGh(root, fixturesDir);
  slowTemplateDir = makeSlowTemplate(root);

  // The rule the dashboard's clone-or-create dialog acts on: this folder tree is
  // covered by a provider rule, so a create in it probes for an existing remote.
  fs.mkdirSync(path.join(fakeHome, '.wherever'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, '.wherever', 'config.json'),
    JSON.stringify(
      {
        gitInitDefault: false,
        remoteRepoRules: [{ pattern: `^${fakeHome}/dev/`, provider: 'github', visibility: 'private' }],
        commonFolders: [],
      },
      null,
      2,
    ),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  const added = fs.readdirSync(REAL_HOME).filter((e) => !realHomeBefore.has(e));
  expect(added.filter((e) => /wherever-new-session-clone|fixtures|dev/.test(e))).toEqual([]);
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

let targetSeq = 0;
/**
 * A fresh, NOT-YET-EXISTING path inside the SERVER's (temp) home. `repo` is the
 * repository name the fake probe resolves, so it selects the fixture.
 */
function targetPath(repo: string): string {
  return path.join(fakeHome, 'dev', `owner-${++targetSeq}`, repo);
}

async function startCreateHarness(opts?: { slowClone?: boolean }): Promise<Harness> {
  return startHarness({
    initial: { kind: 'reply', text: 'seeded' },
    env: {
      HOME: fakeHome,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      ...GIT_ENV,
      ...(opts?.slowClone ? { GIT_TEMPLATE_DIR: slowTemplateDir } : {}),
    },
  });
}

type JobView = {
  id: number;
  kind: string;
  state: string;
  url?: string;
  targetPath: string;
  progress: { phase: string; scope: string; percent: number | null; indeterminate: boolean } | null;
  failure?: { cause: string; message: string; stderr: string };
};

const jobOf = (m: { [k: string]: unknown }): JobView => m.job as JobView;

describe('creating a new session that clones an existing remote', () => {
  it('clones through the registry with progress, then creates the session itself', async () => {
    h = await startCreateHarness();
    const target = targetPath('main');

    const c = await h.connect();
    await c.waitForType('connected');
    // Exactly what the dashboard's "Clone Repository" answer sends.
    c.send({ type: 'session_new', cwd: target, cloneRemote: true, createRemote: false, gitInit: false });

    // The clone is a JOB, reported like any other restore -- not a blocking wait.
    const started = await c.waitForType('restore_started', 30_000);
    expect(started.outcome).toBe('started');
    expect(jobOf(started).kind).toBe('clone');
    expect(jobOf(started).targetPath).toBe(target);
    expect(jobOf(started).url).toBe(`file://${path.join(fixturesDir, 'main')}`);

    const done = await c.waitFor((m) => m.type === 'restore_complete', 120_000);
    expect(jobOf(done).state).toBe('done');

    // Real progress, with the same honesty contract as the panel's.
    const frames = c.messages
      .filter((m) => m.type === 'restore_progress')
      .map((m) => jobOf(m).progress!)
      .filter(Boolean);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.indeterminate).toBe(f.percent === null);
    expect(frames.some((f) => f.scope === 'repository')).toBe(true);
    // Submodules are counted under their own scope: the recursion is visible.
    expect(frames.some((f) => f.scope !== 'repository')).toBe(true);

    // The server CONTINUES into creation itself: there is no session to reload.
    const created = await c.waitForType('session_created', 60_000);
    expect(created.cwd).toBe(target);
    // ...and only AFTER the clone landed.
    expect(c.messages.indexOf(created)).toBeGreaterThan(c.messages.indexOf(done));

    // The folder is a real, complete clone.
    expect(fs.readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('main content\n');
    expect(fs.readFileSync(path.join(target, 'sub', 'sub-file.txt'), 'utf8')).toBe('submodule content\n');
    // Upstream tracking, which the deleted synchronous helper configured by hand.
    expect(gitOut(['config', '--get', 'branch.main.remote'], target)).toBe('origin');
    expect(gitOut(['config', '--get', 'branch.main.merge'], target)).toBe('refs/heads/main');

    // The session is genuinely live in the cloned folder.
    h.setNext({ kind: 'reply', text: 'cloned and live' });
    c.send({ type: 'message', message: 'are you there', sessionId: created.sessionId });
    const end = await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 60_000);
    expect(end.content).toBe('cloned and live');
  }, 180_000);

  it('fails the create with the MAPPED cause and makes no session when the clone fails', async () => {
    h = await startCreateHarness();
    // The probe answers with a fixture path that is no repository at all.
    const target = targetPath('nope');

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: target, cloneRemote: true, createRemote: false, gitInit: false });

    await c.waitForType('restore_started', 30_000);
    const failed = await c.waitFor((m) => m.type === 'restore_complete', 60_000);
    expect(jobOf(failed).state).toBe('failed');
    expect(jobOf(failed).failure?.cause).toBe('not-found');

    const error = await c.waitForType('session_error', 30_000);
    expect(String(error.error)).toMatch(/not found/i);

    // No half-made session: nothing was created, and the failed clone left no
    // folder standing in for one.
    await sleep(500);
    expect(c.messages.some((m) => m.type === 'session_created')).toBe(false);
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
  }, 180_000);

  it('cancelling the clone abandons the create instead of half-making it', async () => {
    h = await startCreateHarness({ slowClone: true });
    const target = targetPath('main');

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: target, cloneRemote: true, createRemote: false, gitInit: false });
    await c.waitForType('restore_started', 30_000);
    await c.waitForType('restore_progress', 60_000);

    // The job is path-keyed and server-owned, so the ordinary cancel frame
    // reaches it -- the create path needs no cancel mechanism of its own.
    c.send({ type: 'restore_cancel', targetPath: target });
    const cancelled = await c.waitFor((m) => m.type === 'restore_complete', 60_000);
    expect(jobOf(cancelled).state).toBe('cancelled');

    const error = await c.waitForType('session_error', 30_000);
    expect(String(error.error)).toMatch(/cancel/i);
    await sleep(500);
    expect(c.messages.some((m) => m.type === 'session_created')).toBe(false);
    // The directory the cancelled job created is gone with it.
    expect(fs.existsSync(target)).toBe(false);
  }, 180_000);

  it('leaves a create WITHOUT a clone alone, in an existing folder and in a new one', async () => {
    h = await startCreateHarness();

    const existing = path.join(fakeHome, 'dev', 'existing-folder');
    fs.mkdirSync(existing, { recursive: true });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: existing });
    const created = await c.waitForType('session_created', 60_000);
    expect(created.cwd).toBe(existing);

    // A folder that does NOT exist and is covered by the remote rule, but where
    // the user did not choose to clone: it is created, not cloned.
    const fresh = targetPath('main');
    c.send({ type: 'session_new', cwd: fresh, createRemote: false, gitInit: false });
    const created2 = await c.waitFor(
      (m) => m.type === 'session_created' && m.cwd === fresh,
      60_000,
    );
    expect(created2.cwd).toBe(fresh);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(path.join(fresh, 'README.md'))).toBe(false);

    // Neither create went anywhere near a restore job.
    await sleep(500);
    expect(c.messages.some((m) => m.type.startsWith('restore_'))).toBe(false);
  }, 180_000);
});
