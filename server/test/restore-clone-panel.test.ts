import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * The RESTORE PANEL at its protocol seam: a folder-missing session is restored
 * by CLONING the repository back into its path, over the WebSocket, driven by
 * the path-keyed job registry.
 *
 * The properties under test are the ones that make this usable from a phone, and
 * every one of them is a protocol property rather than an internal:
 *
 *  - the folder-missing frame carries any job ALREADY running for that path, so
 *    a reconnect or a second device repaints the running clone instead of
 *    starting a competing one;
 *  - progress/completion frames reach every client whose session cwd or pending
 *    load target MATCHES the job path -- subscription is DERIVED from that
 *    match, never registered per socket, so a dropped phone leaks nothing;
 *  - a second Clone tap JOINS the running job and is told the URL really in
 *    flight, so an edited URL is never silently ignored;
 *  - cancel settles the job and removes the directory the job created;
 *  - a failure carries the MAPPED cause with git's raw stderr underneath;
 *  - a completed restore plus a RELOAD ends in a live agent that accepts a
 *    message (a live agent is a load-time decision).
 *
 * Isolation (WORK-CONTRACT.md). The server runs as a CHILD, so the levers are
 * pulled in its environment, not this process's:
 *  - `HOME` points at a temp directory. The registry's home guard resolves
 *    `os.homedir()` inside the SERVER process, so every restore target lives
 *    under that temp home and the developer's real home is asserted untouched.
 *  - git config is neutralised (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at
 *    /dev/null) with an explicit committer identity, so no `~/.gitconfig` is
 *    read or written.
 *  - the fixtures are local `file://` repositories: no network, no SSH key and
 *    no provider CLI. A `file://` SUBMODULE needs git's file-transport
 *    protection relaxed (refused since 2.38 / CVE-2022-39253); that relaxation
 *    is injected through the SERVER's environment (`GIT_CONFIG_COUNT`), never
 *    through the production clone argv (asserted in restore-jobs.test.ts).
 */

const REAL_HOME = os.homedir();
const realHomeBefore = new Set(fs.readdirSync(REAL_HOME));

let root = '';
let fakeHome = '';
let mainRepoUrl = '';
let otherRepoUrl = '';
let missingRepoUrl = '';
/** A git template dir whose post-checkout hook sleeps, so a clone is SLOW. */
let slowTemplateDir = '';

const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Wherever Test',
  GIT_AUTHOR_EMAIL: 'test@wherever.invalid',
  GIT_COMMITTER_NAME: 'Wherever Test',
  GIT_COMMITTER_EMAIL: 'test@wherever.invalid',
  // File-transport relaxation, TEST-ONLY (see the header note).
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
}

/**
 * `main` (a README plus `sub` as a submodule, so the recursion is visible in the
 * result), `other` (a DIFFERENT repository, to prove a joiner's edited URL was
 * not the one cloned), and a path that is no repository at all.
 */
function makeFixtures(dir: string) {
  const sub = path.join(dir, 'fixtures', 'sub');
  const main = path.join(dir, 'fixtures', 'main');
  const other = path.join(dir, 'fixtures', 'other');
  for (const d of [sub, main, other]) fs.mkdirSync(d, { recursive: true });

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

  git(['init', '-q', '-b', 'main'], other);
  fs.writeFileSync(path.join(other, 'OTHER.md'), 'other content\n');
  git(['add', '-A'], other);
  git(['commit', '-qm', 'other'], other);

  return {
    main: `file://${main}`,
    other: `file://${other}`,
    missing: `file://${path.join(dir, 'fixtures', 'nope')}`,
  };
}

/**
 * A clone of a local fixture finishes in milliseconds, which would make every
 * "while it is RUNNING" assertion a race. `git clone` runs the `post-checkout`
 * hook it copied from `GIT_TEMPLATE_DIR`, so a sleeping hook makes the clone
 * take a known, deterministic time WITHOUT slowing git's own progress output
 * (the phases have all been reported by the time the hook runs). It is set in
 * the SERVER's environment only; production clones carry no template dir.
 */
function makeSlowTemplate(dir: string): string {
  const template = path.join(dir, 'slow-template');
  fs.mkdirSync(path.join(template, 'hooks'), { recursive: true });
  const hook = path.join(template, 'hooks', 'post-checkout');
  fs.writeFileSync(hook, '#!/bin/sh\nsleep 3\nexit 0\n');
  fs.chmodSync(hook, 0o755);
  return template;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-restore-panel-')));
  fakeHome = path.join(root, 'home');
  fs.mkdirSync(fakeHome);
  const urls = makeFixtures(root);
  mainRepoUrl = urls.main;
  otherRepoUrl = urls.other;
  missingRepoUrl = urls.missing;
  slowTemplateDir = makeSlowTemplate(root);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  // Nothing this suite did may have landed in the developer's real home.
  const added = fs.readdirSync(REAL_HOME).filter((e) => !realHomeBefore.has(e));
  expect(added.filter((e) => /wherever-restore-panel|restore-target|fixtures/.test(e))).toEqual([]);
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

let targetSeq = 0;
/** A fresh path inside the SERVER's (temp) home, laid out as a real tree is. */
function targetPath(): string {
  return path.join(fakeHome, 'dev', 'github', 'wherever-test', `repo-${++targetSeq}`);
}

async function startRestoreHarness(opts?: { slowClone?: boolean }): Promise<Harness> {
  return startHarness({
    initial: { kind: 'reply', text: 'seeded' },
    // The session is evicted when its last client leaves, so every later load is
    // a genuine COLD one -- the path a restored folder has to go live through.
    idleTimeoutMs: 0,
    env: {
      HOME: fakeHome,
      ...GIT_ENV,
      ...(opts?.slowClone ? { GIT_TEMPLATE_DIR: slowTemplateDir } : {}),
    },
  });
}

/**
 * Create a session in `cwd`, give it one real turn so it has history, then
 * REMOVE the folder: the machine migration in one line (the transcript survives,
 * the clone does not).
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
  fs.rmSync(cwd, { recursive: true, force: true });
  return created.sessionFile as string;
}

/** Open the folder-missing session and return its `folder_missing` frame. */
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
  state: string;
  url?: string;
  targetPath: string;
  progress: { phase: string; scope: string; percent: number | null; indeterminate: boolean } | null;
  failure?: { cause: string; message: string; stderr: string };
};

const jobOf = (m: { [k: string]: unknown }): JobView => m.job as JobView;

function restoreJobIds(c: TestClient): number[] {
  return c.messages
    .filter((m) => m.type === 'restore_started' || m.type === 'restore_progress' || m.type === 'restore_complete')
    .map((m) => jobOf(m).id);
}

describe('restoring a missing folder from the panel', () => {
  it('clones the repository, reports honest progress, and goes live after a RELOAD', async () => {
    h = await startRestoreHarness();
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c, missing } = await openMissing(h, sessionFile);
    expect(missing.cwd).toBe(target);
    // Nothing is running yet, so the panel offers to start rather than repaint.
    expect(missing.job).toBeUndefined();

    c.send({ type: 'restore_start', targetPath: target, action: 'clone', url: mainRepoUrl });
    const started = await c.waitForType('restore_started', 20_000);
    expect(started.outcome).toBe('started');
    expect(jobOf(started).url).toBe(mainRepoUrl);
    expect(jobOf(started).targetPath).toBe(target);

    const done = await c.waitFor((m) => m.type === 'restore_complete', 120_000);
    expect(jobOf(done).state).toBe('done');
    expect(jobOf(done).failure).toBeUndefined();

    // Progress is HONEST: a phase, a scope, and either a real percentage or an
    // explicit indeterminate marker -- never a fake unified number.
    const frames = c.messages
      .filter((m) => m.type === 'restore_progress')
      .map((m) => jobOf(m).progress!)
      .filter(Boolean);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(typeof f.phase).toBe('string');
      expect(f.scope.length).toBeGreaterThan(0);
      expect(f.indeterminate).toBe(f.percent === null);
    }
    expect(frames.some((f) => typeof f.percent === 'number')).toBe(true);
    expect(frames.some((f) => f.indeterminate)).toBe(true);
    // The submodule is counted under its OWN scope, never folded into the
    // repository's percentage.
    expect(frames.some((f) => f.scope === 'repository')).toBe(true);
    expect(frames.some((f) => f.scope !== 'repository')).toBe(true);

    // The folder is really back, submodule content and all.
    expect(fs.readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('main content\n');
    expect(fs.readFileSync(path.join(target, 'sub', 'sub-file.txt'), 'utf8')).toBe('submodule content\n');

    // A live agent is a LOAD-TIME decision, so the cure ends in a reload: the
    // same session now loads normally and accepts a message.
    h.setNext({ kind: 'reply', text: 'restored and live' });
    c.send({ type: 'session_load', sessionFile });
    const repainted = await c.waitFor(
      (m) => m.type === 'session_created' && m.folderMissing !== true,
      20_000,
    );
    expect(repainted.readOnly).toBeFalsy();
    await c.waitForType('session_ready', 60_000);
    c.send({ type: 'message', message: 'are you back', sessionId: repainted.sessionId });
    const end = await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 60_000);
    expect(end.content).toBe('restored and live');
  }, 180_000);

  it('repaints the RUNNING job after a dropped socket, with no second clone', async () => {
    h = await startRestoreHarness({ slowClone: true });
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c, missing } = await openMissing(h, sessionFile);
    expect(missing.job).toBeUndefined();
    c.send({ type: 'restore_start', targetPath: target, action: 'clone', url: mainRepoUrl });
    const started = await c.waitForType('restore_started', 20_000);
    const jobId = jobOf(started).id;
    await c.waitForType('restore_progress', 60_000);

    // The phone locks / the link drops, mid-clone.
    c.close();
    await sleep(300);

    const c2 = await h.connect();
    await c2.waitForType('connected');
    c2.send({ type: 'session_load', sessionFile });
    const painted2 = await c2.waitForType('session_created', 20_000);
    // Mid-clone the target directory EXISTS (git makes it in its first breath),
    // so a plain existence check would hand this client a live agent pointed at a
    // half-cloned tree. The folder is not usable until the job says so.
    expect(painted2.folderMissing).toBe(true);
    expect(painted2.readOnly).toBe(true);
    const missing2 = await c2.waitForType('folder_missing', 20_000);
    // The SAME job, still running, with the progress it has reached: the panel
    // repaints instead of offering a competing clone.
    expect(missing2.job).toBeTruthy();
    expect(jobOf(missing2).id).toBe(jobId);
    expect(jobOf(missing2).state).toBe('running');
    expect(jobOf(missing2).progress).toBeTruthy();

    // Live frames follow on the NEW socket: the subscription is derived from the
    // path match, so a reconnect needs no re-registration.
    const done = await c2.waitFor((m) => m.type === 'restore_complete', 120_000);
    expect(jobOf(done).id).toBe(jobId);
    expect(jobOf(done).state).toBe('done');
    // Exactly ONE clone existed for this path, start to finish.
    expect([...new Set(restoreJobIds(c2))]).toEqual([jobId]);
    expect(fs.existsSync(path.join(target, 'README.md'))).toBe(true);
    // No agent was ever built against the folder while it was being materialised.
    expect(c2.messages.some((m) => m.type === 'session_ready')).toBe(false);
  }, 180_000);

  it('lets a second device JOIN the running job and tells it which URL is in flight', async () => {
    h = await startRestoreHarness({ slowClone: true });
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c: c1 } = await openMissing(h, sessionFile);
    const { c: c2 } = await openMissing(h, sessionFile);

    c1.send({ type: 'restore_start', targetPath: target, action: 'clone', url: mainRepoUrl });
    const started = await c1.waitForType('restore_started', 20_000);
    const jobId = jobOf(started).id;

    // The second device never asked for anything, but it is looking at the same
    // folder, so the derived subscription paints the clone for it too.
    const seen = await c2.waitForType('restore_progress', 60_000);
    expect(jobOf(seen).id).toBe(jobId);

    // It taps Clone anyway, with the URL ITS field held. That must join the
    // running job and say so, never start a competing clone and never pretend
    // the edited URL was accepted.
    c2.send({ type: 'restore_start', targetPath: target, action: 'clone', url: otherRepoUrl });
    const joined = await c2.waitForType('restore_started', 20_000);
    expect(joined.outcome).toBe('joined');
    expect(jobOf(joined).id).toBe(jobId);
    expect(jobOf(joined).url).toBe(mainRepoUrl);

    const done = await c1.waitFor((m) => m.type === 'restore_complete', 120_000);
    expect(jobOf(done).state).toBe('done');
    // Both devices learn the outcome of the one job.
    const done2 = await c2.waitFor((m) => m.type === 'restore_complete', 120_000);
    expect(jobOf(done2).id).toBe(jobId);
    // The URL actually in flight is the one that landed on disk.
    expect(fs.existsSync(path.join(target, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'OTHER.md'))).toBe(false);
  }, 180_000);

  it('cancels a running clone, cleans up the folder it created, and offers to restore again', async () => {
    h = await startRestoreHarness({ slowClone: true });
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c } = await openMissing(h, sessionFile);
    c.send({ type: 'restore_start', targetPath: target, action: 'clone', url: mainRepoUrl });
    const started = await c.waitForType('restore_started', 20_000);
    const firstId = jobOf(started).id;
    await c.waitForType('restore_progress', 60_000);

    c.send({ type: 'restore_cancel', targetPath: target });
    const cancelled = await c.waitFor((m) => m.type === 'restore_complete', 60_000);
    expect(jobOf(cancelled).state).toBe('cancelled');
    // The directory the job created is removed, so a wrong URL is recoverable
    // without a terminal.
    await sleep(300);
    expect(fs.existsSync(target)).toBe(false);

    // Back to the offer-to-restore state: a fresh tap starts a NEW job.
    c.send({ type: 'restore_start', targetPath: target, action: 'clone', url: mainRepoUrl });
    const restarted = await c.waitFor(
      (m) => m.type === 'restore_started' && jobOf(m).id !== firstId,
      20_000,
    );
    expect(restarted.outcome).toBe('started');
    expect(jobOf(restarted).state).toBe('running');
  }, 180_000);

  it('explains a failed clone with the mapped cause and keeps git raw output underneath', async () => {
    h = await startRestoreHarness();
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c } = await openMissing(h, sessionFile);
    c.send({ type: 'restore_start', targetPath: target, action: 'clone', url: missingRepoUrl });
    await c.waitForType('restore_started', 20_000);

    const failed = await c.waitFor((m) => m.type === 'restore_complete', 60_000);
    expect(jobOf(failed).state).toBe('failed');
    expect(jobOf(failed).failure?.cause).toBe('not-found');
    expect(jobOf(failed).failure?.message).toMatch(/not found/i);
    expect(jobOf(failed).failure?.stderr).toMatch(/fatal:/);
  }, 180_000);

  it('refuses an unusable request without starting anything', async () => {
    h = await startRestoreHarness();
    const target = targetPath();
    const sessionFile = await seedMissingSession(h, target);

    const { c } = await openMissing(h, sessionFile);

    // Not an SSH (or fixture) URL: refused by the shape allowlist.
    c.send({ type: 'restore_start', targetPath: target, action: 'clone', url: 'https://github.com/o/r.git' });
    const badUrl = await c.waitForType('restore_rejected', 20_000);
    expect(badUrl.reason).toBe('invalid-url');
    expect(String(badUrl.message)).toContain('https://github.com/o/r.git');
    expect(fs.existsSync(target)).toBe(false);

    // Outside the server's home directory. (The server's HOME is this suite's
    // temp home, so /tmp is genuinely outside it -- which is also the proof the
    // isolation lever took.)
    const outside = path.join(root, 'not-home', 'repo');
    c.send({ type: 'restore_start', targetPath: outside, action: 'clone', url: mainRepoUrl });
    const outsideHome = await c.waitFor(
      (m) => m.type === 'restore_rejected' && m.reason === 'outside-home',
      20_000,
    );
    expect(String(outsideHome.message)).toContain(outside);
    expect(fs.existsSync(outside)).toBe(false);

    // Nothing was ever started for either.
    await sleep(300);
    expect(c.messages.some((m) => m.type === 'restore_started')).toBe(false);
  }, 180_000);
});
