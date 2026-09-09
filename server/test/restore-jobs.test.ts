import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import {
  RestoreJobRegistry,
  GitProgressParser,
  buildCloneArgs,
  buildCloneEnv,
  mapCloneFailure,
  REPOSITORY_SCOPE,
  type RestoreProgress,
  type RestoreJobSnapshot,
} from '../src/restore-jobs.js';

/**
 * The restore-job registry: the server-side engine that materialises a MISSING
 * working folder, by cloning a remote or by creating an empty folder.
 *
 * These are IN-PROCESS module tests, so two shared-write levers matter and both
 * are pulled here rather than in a spawned child (see WORK-CONTRACT.md):
 *
 *  1. HOME. The home-directory guard resolves `os.homedir()` at CALL time, in
 *     THIS process, so isolating it means setting this process's own `HOME` to a
 *     temp dir. (The harness pattern of overriding a CHILD's environment is the
 *     wrong lever here; it belongs to the later protocol-level tasks.)
 *  2. git. These are the first git invocations anywhere in the suites, so they
 *     must not read the developer's `~/.gitconfig` or the system config, and
 *     must not depend on a committer identity being configured. `GIT_CONFIG_*`
 *     is set on THIS process and inherited by every git child.
 *
 * The fixtures are local `file://` repositories: no network, no SSH key and no
 * provider CLI is ever touched. A `file://` submodule needs git's file-transport
 * protection relaxed (refused since 2.38 / CVE-2022-39253), which is injected
 * into the TEST process environment only. The production clone argv must never
 * carry that relaxation, and that is asserted below.
 */

const REAL_HOME = os.homedir();
const realHomeBefore = new Set(fs.readdirSync(REAL_HOME));

const savedEnv: Record<string, string | undefined> = {};
const TEST_GIT_ENV: Record<string, string> = {
  HOME: '', // filled in beforeAll
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Wherever Test',
  GIT_AUTHOR_EMAIL: 'test@wherever.invalid',
  GIT_COMMITTER_NAME: 'Wherever Test',
  GIT_COMMITTER_EMAIL: 'test@wherever.invalid',
  // File-transport relaxation, TEST-ONLY. Never in the production argv.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
};

let root = '';
let fakeHome = '';
let mainRepoUrl = '';
let missingRepoUrl = '';

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: process.env });
}

/**
 * Two local repositories: `sub` (one file) and `main` (one file plus `sub` as a
 * submodule). Cloning `main` recursively is the assertion that silently
 * regresses, so the submodule has real content to look for.
 */
function makeFixtures(dir: string) {
  const sub = path.join(dir, 'fixtures', 'sub');
  const main = path.join(dir, 'fixtures', 'main');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(main, { recursive: true });

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

  return { main: `file://${main}`, missing: `file://${path.join(dir, 'fixtures', 'nope')}` };
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-restore-')));
  fakeHome = path.join(root, 'home');
  fs.mkdirSync(fakeHome);
  TEST_GIT_ENV.HOME = fakeHome;
  for (const [k, v] of Object.entries(TEST_GIT_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  // The guard resolves home in THIS process; prove the override actually took.
  expect(os.homedir()).toBe(fakeHome);
  const urls = makeFixtures(root);
  mainRepoUrl = urls.main;
  missingRepoUrl = urls.missing;
});

afterAll(() => {
  for (const [k] of Object.entries(TEST_GIT_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(root, { recursive: true, force: true });
  // Nothing this suite did may have landed in the developer's real home.
  const added = fs.readdirSync(REAL_HOME).filter((e) => !realHomeBefore.has(e));
  expect(added.filter((e) => /wherever-restore|restore-target|fixtures/.test(e))).toEqual([]);
});

const registries: RestoreJobRegistry[] = [];
function makeRegistry(options?: ConstructorParameters<typeof RestoreJobRegistry>[0]) {
  const reg = new RestoreJobRegistry(options);
  registries.push(reg);
  return reg;
}

afterEach(() => {
  for (const reg of registries.splice(0)) reg.dispose();
});

let targetSeq = 0;
/** A fresh, NONEXISTENT target path inside the (temp) home directory. */
function targetPath(name = 'repo'): string {
  return path.join(fakeHome, 'dev', `restore-target-${++targetSeq}`, name);
}

describe('restore job: cloning a repository', () => {
  it('clones RECURSIVELY, so the submodule content is really there', async () => {
    const reg = makeRegistry();
    const target = targetPath();

    const result = reg.request({ kind: 'clone', targetPath: target, url: mainRepoUrl });
    expect(result.ok).toBe(true);

    const job = await reg.settled(target);
    expect(job.state).toBe('done');
    expect(job.failure).toBeUndefined();
    expect(fs.existsSync(path.join(target, 'README.md'))).toBe(true);
    // The recursion assertion: an empty `sub/` would still pass an existsSync on
    // the directory, so assert the FILE inside the submodule.
    expect(fs.readFileSync(path.join(target, 'sub', 'sub-file.txt'), 'utf8')).toBe('submodule content\n');
    // Upstream tracking is pre-configured, as the synchronous helper this
    // replaces did: a restored folder must be pushable without a --set-upstream.
    const tracked = execFileSync('git', ['config', '--get', 'branch.main.remote'], {
      cwd: target,
      env: process.env,
    })
      .toString()
      .trim();
    expect(tracked).toBe('origin');
  }, 60000);

  it('emits progress with a phase, a scope and a percentage or an explicit indeterminate marker', async () => {
    const reg = makeRegistry();
    const target = targetPath();
    const seen: RestoreProgress[] = [];

    const unsubscribe = reg.subscribe(target, { onProgress: (p) => seen.push(p) });
    reg.request({ kind: 'clone', targetPath: target, url: mainRepoUrl });
    const job = await reg.settled(target);
    unsubscribe();

    expect(job.state).toBe('done');
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) {
      expect(typeof p.phase).toBe('string');
      expect(p.scope.length).toBeGreaterThan(0);
      // Exactly one of the two: a number, or an explicit indeterminate marker.
      expect(p.indeterminate).toBe(p.percent === null);
    }
    expect(seen.some((p) => typeof p.percent === 'number')).toBe(true);
    expect(seen.some((p) => p.scope === REPOSITORY_SCOPE)).toBe(true);
    // Submodule progress is reported under its OWN scope, never folded into one
    // fake global percentage.
    const subScoped = seen.filter((p) => p.scope === 'sub');
    expect(subScoped.length).toBeGreaterThan(0);
    for (const p of subScoped) expect(p.percent === null || p.percent <= 100).toBe(true);
  }, 60000);

  it('COALESCES a second request for the same path onto the running job, reporting the URL in flight', async () => {
    let spawns = 0;
    const reg = makeRegistry({
      spawn: (cmd, args, opts) => {
        spawns++;
        return nodeSpawn(cmd, args, opts);
      },
    });
    const target = targetPath();

    const first = reg.request({ kind: 'clone', targetPath: target, url: mainRepoUrl });
    // Same tick: the first clone cannot have finished, so this is the real race.
    const second = reg.request({ kind: 'clone', targetPath: target, url: 'git@github.com:someone/else.git' });

    expect(first.ok && first.outcome).toBe('started');
    expect(second.ok && second.outcome).toBe('joined');
    if (!first.ok || !second.ok) throw new Error('both requests should be accepted');
    expect(second.job.id).toBe(first.job.id);
    // The joiner asked for a DIFFERENT url and must be told which one is really
    // being cloned, never silently answered as though its own was accepted.
    expect(second.job.url).toBe(mainRepoUrl);
    expect(reg.list()).toHaveLength(1);

    const job = await reg.settled(target);
    expect(job.state).toBe('done');
    expect(spawns).toBe(1);
  }, 60000);

  it('surfaces a MAPPED cause for a failing clone and keeps git raw stderr underneath', async () => {
    const reg = makeRegistry();
    const target = targetPath();

    reg.request({ kind: 'clone', targetPath: target, url: missingRepoUrl });
    const job = await reg.settled(target);

    expect(job.state).toBe('failed');
    expect(job.failure?.cause).toBe('not-found');
    expect(job.failure?.message).toMatch(/not found/i);
    expect(job.failure?.stderr).toMatch(/fatal:/);
  }, 60000);
});

describe('restore job: cancelling', () => {
  it('cancels, TERMINATES the child, and removes a target directory the job CREATED', async () => {
    const children: ReturnType<typeof nodeSpawn>[] = [];
    const reg = makeRegistry({
      spawn: (cmd, args, opts) => {
        const child = nodeSpawn(cmd, args, opts);
        children.push(child);
        return child;
      },
    });
    const target = targetPath();

    reg.request({ kind: 'clone', targetPath: target, url: mainRepoUrl });
    expect(reg.cancel(target)).toBe(true);

    const job = await reg.settled(target);
    expect(job.state).toBe('cancelled');
    // The clone child is really signalled, not merely left to finish and then
    // relabelled: a real clone runs for minutes.
    expect(children).toHaveLength(1);
    expect(children[0].killed).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  }, 60000);

  it('never removes a target directory that already existed', async () => {
    const reg = makeRegistry();
    const target = targetPath();
    fs.mkdirSync(target, { recursive: true });

    reg.request({ kind: 'clone', targetPath: target, url: mainRepoUrl });
    expect(reg.cancel(target)).toBe(true);

    const job = await reg.settled(target);
    expect(job.state).toBe('cancelled');
    expect(fs.existsSync(target)).toBe(true);
  }, 60000);
});

describe('restore job: refusing unsafe input', () => {
  it('refuses a target outside the home directory', () => {
    const reg = makeRegistry();
    const outside = path.join(root, 'not-home', 'repo');
    const result = reg.request({ kind: 'clone', targetPath: outside, url: mainRepoUrl });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('outside-home');
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('refuses a target leaf that exists and is NOT empty', () => {
    const reg = makeRegistry();
    const target = targetPath();
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep-me.txt'), 'mine\n');

    const result = reg.request({ kind: 'clone', targetPath: target, url: mainRepoUrl });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('target-not-empty');
    expect(fs.readFileSync(path.join(target, 'keep-me.txt'), 'utf8')).toBe('mine\n');
  });

  it('refuses a malformed URL', () => {
    const reg = makeRegistry();
    for (const url of ['', 'not a url', 'https://github.com/owner/repo.git', '-uploadpack=payload', 'ext::sh -c whoami']) {
      const result = reg.request({ kind: 'clone', targetPath: targetPath(), url });
      expect(result.ok, `expected refusal for ${JSON.stringify(url)}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-url');
    }
  });

  it('refuses a URL carrying shell metacharacters, and no side-effect file is created', () => {
    const reg = makeRegistry();
    const sideEffect = path.join(root, 'pwned.txt');
    const attacks = [
      `git@github.com:owner/repo.git; touch ${sideEffect}`,
      `git@github.com:owner/$(touch ${sideEffect}).git`,
      'git@github.com:owner/repo.git\ntouch ' + sideEffect,
      `git@github.com:owner/\`touch ${sideEffect}\`.git`,
    ];
    for (const url of attacks) {
      const result = reg.request({ kind: 'clone', targetPath: targetPath(), url });
      expect(result.ok, `expected refusal for ${JSON.stringify(url)}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-url');
    }
    expect(fs.existsSync(sideEffect)).toBe(false);
  });
});

describe('restore job: creating a folder', () => {
  it('creates the directory', async () => {
    const reg = makeRegistry();
    const target = targetPath('plain');

    const result = reg.request({ kind: 'create', targetPath: target });
    expect(result.ok).toBe(true);

    const job = await reg.settled(target);
    expect(job.state).toBe('done');
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
  }, 30000);

  it('initialises a git repository when asked', async () => {
    const reg = makeRegistry();
    const target = targetPath('inited');

    reg.request({ kind: 'create', targetPath: target, gitInit: true });
    const job = await reg.settled(target);

    expect(job.state).toBe('done');
    expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
  }, 30000);

  it('refuses an unsafe target exactly like the clone kind does', () => {
    const reg = makeRegistry();
    const result = reg.request({ kind: 'create', targetPath: path.join(root, 'not-home', 'folder') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('outside-home');
  });
});

describe('restore job: the observation seam', () => {
  it('feeds TWO independent subscribers, and unsubscribe really detaches one', async () => {
    const reg = makeRegistry();
    const target = targetPath();

    // Exactly how this will be used: one consumer broadcasts to matching
    // WebSocket clients, another invalidates a per-folder existence cache.
    const broadcast = { progress: [] as RestoreProgress[], settled: [] as RestoreJobSnapshot[] };
    const cache = { progress: [] as RestoreProgress[], settled: [] as RestoreJobSnapshot[] };
    const dropped = { progress: [] as RestoreProgress[], settled: [] as RestoreJobSnapshot[] };

    reg.subscribe(target, {
      onProgress: (p) => broadcast.progress.push(p),
      onSettled: (j) => broadcast.settled.push(j),
    });
    reg.subscribe(target, {
      onProgress: (p) => cache.progress.push(p),
      onSettled: (j) => cache.settled.push(j),
    });
    const unsubscribe = reg.subscribe(target, {
      onProgress: (p) => dropped.progress.push(p),
      onSettled: (j) => dropped.settled.push(j),
    });
    unsubscribe();

    reg.request({ kind: 'clone', targetPath: target, url: mainRepoUrl });
    await reg.settled(target);
    // Terminal notification is delivered out of the settle promise's tick.
    await new Promise((r) => setTimeout(r, 20));

    expect(broadcast.progress.length).toBeGreaterThan(0);
    expect(cache.progress.length).toBe(broadcast.progress.length);
    expect(broadcast.settled).toHaveLength(1);
    expect(cache.settled).toHaveLength(1);
    expect(broadcast.settled[0].state).toBe('done');
    expect(dropped.progress).toHaveLength(0);
    expect(dropped.settled).toHaveLength(0);
  }, 60000);

  it('retains a terminal job briefly so a late reconnect still learns the outcome, then reaps it', async () => {
    const reg = makeRegistry({ retainMs: 50 });
    const target = targetPath('created');

    reg.request({ kind: 'create', targetPath: target });
    const job = await reg.settled(target);
    expect(job.state).toBe('done');
    // A client that reconnects right after the job ended still sees it.
    expect(reg.get(target)?.state).toBe('done');
    await new Promise((r) => setTimeout(r, 120));
    expect(reg.get(target)).toBeUndefined();
  }, 30000);
});

describe('git progress parsing', () => {
  it('splits on CARRIAGE RETURN, not only newline', () => {
    // Recorded from `git clone --progress` (git 2.47.3) against a file:// repo:
    // one newline-terminated chunk with the line REWRITTEN in place.
    const recorded =
      'Receiving objects:  16% (1/6)\rReceiving objects:  33% (2/6)\r' +
      'Receiving objects:  50% (3/6)\rReceiving objects: 100% (6/6), done.\n';

    // The point of the assertion: a newline-only parser sees ONE line here, and
    // the receiving phase is exactly where a long clone spends its time.
    expect(recorded.split('\n').filter(Boolean)).toHaveLength(1);

    const parser = new GitProgressParser('/tmp/target');
    const frames = parser.push(recorded);
    expect(frames.map((f) => f.percent)).toEqual([16, 33, 50, 100]);
    for (const f of frames) {
      expect(f.phase).toBe('receiving');
      expect(f.scope).toBe(REPOSITORY_SCOPE);
      expect(f.indeterminate).toBe(false);
    }
  });

  it('strips the remote: prefix and marks a percentage-less phase INDETERMINATE', () => {
    const parser = new GitProgressParser('/tmp/target');
    const frames = parser.push('remote: Enumerating objects: 6, done.        \n');
    expect(frames).toHaveLength(1);
    expect(frames[0].phase).toBe('enumerating');
    expect(frames[0].percent).toBeNull();
    expect(frames[0].indeterminate).toBe(true);
  });

  it('re-scopes to the submodule when git starts cloning into it', () => {
    const parser = new GitProgressParser('/tmp/target');
    const frames = parser.push(
      "Cloning into '/tmp/target'...\n" +
        'Receiving objects: 100% (6/6), done.\n' +
        "Cloning into '/tmp/target/sub'...\n" +
        'Receiving objects:  50% (1/2)\r',
    );
    const scoped = frames.map((f) => [f.scope, f.phase, f.percent]);
    expect(scoped).toEqual([
      [REPOSITORY_SCOPE, 'starting', null],
      [REPOSITORY_SCOPE, 'receiving', 100],
      ['sub', 'starting', null],
      ['sub', 'receiving', 50],
    ]);
  });

  it('buffers a frame that is not yet terminated rather than reporting a half-read percentage', () => {
    const parser = new GitProgressParser('/tmp/target');
    expect(parser.push('Receiving objects:  1')).toHaveLength(0);
    expect(parser.push('6% (1/6)\r').map((f) => f.percent)).toEqual([16]);
  });
});

describe('clone invocation shape', () => {
  it('is an argv ARRAY with no shell and no file-transport relaxation', () => {
    const args = buildCloneArgs('git@github.com:owner/repo.git', '/home/u/dev/repo');
    expect(args).toEqual([
      'clone',
      '--progress',
      '--recurse-submodules',
      '--',
      'git@github.com:owner/repo.git',
      '/home/u/dev/repo',
    ]);
    // The test-only relaxation must never reach production arguments.
    expect(args.join(' ')).not.toContain('protocol.file.allow');
    expect(args).not.toContain('-c');
  });

  it('forces non-interactive credentials so an unprovisioned box fails FAST', () => {
    const env = buildCloneEnv({ PATH: '/usr/bin', GIT_ASKPASS: '/usr/bin/askpass', SSH_ASKPASS: '/x', DISPLAY: ':0' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.DISPLAY).toBeUndefined();
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never');
    expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
  });

  it('carries no file-transport relaxation even when the surrounding process has one', () => {
    const env = buildCloneEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.file.allow',
      GIT_CONFIG_VALUE_0: 'always',
    });
    // Inherited env is NOT scrubbed (the tests rely on inheriting it), but the
    // ARGUMENTS never carry it: that is what the assertion above pins.
    expect(buildCloneArgs('git@h:o/r.git', '/home/u/r').join(' ')).not.toContain('protocol.file.allow');
    expect(env.GIT_CONFIG_KEY_0).toBe('protocol.file.allow');
  });
});

describe('failure mapping (the whole remedy for an unprovisioned box)', () => {
  const url = 'git@github.com:owner/repo.git';

  it('names a missing key', () => {
    const stderr = [
      "git@github.com: Permission denied (publickey).",
      'fatal: Could not read from remote repository.',
      'Please make sure you have the correct access rights',
    ].join('\n');
    const failure = mapCloneFailure(stderr, url);
    expect(failure.cause).toBe('no-key');
    expect(failure.message).toContain('github.com');
    expect(failure.message).toMatch(/key/i);
    expect(failure.stderr).toBe(stderr);
  });

  it('names a host missing from known_hosts, and says one manual connection fixes it', () => {
    const stderr = [
      "The authenticity of host 'github.com (140.82.121.4)' can't be established.",
      'Host key verification failed.',
      'fatal: Could not read from remote repository.',
    ].join('\n');
    const failure = mapCloneFailure(stderr, url);
    expect(failure.cause).toBe('unknown-host');
    expect(failure.message).toContain('known_hosts');
    expect(failure.message).toContain('ssh -T git@github.com');
  });

  it('says repository-not-found as BOTH a wrong URL and a key without access', () => {
    const stderr = 'ERROR: Repository not found.\nfatal: Could not read from remote repository.';
    const failure = mapCloneFailure(stderr, url);
    expect(failure.cause).toBe('not-found');
    expect(failure.message).toMatch(/url/i);
    expect(failure.message).toMatch(/access/i);
  });

  it('says network, not credentials, for a resolution or timeout failure', () => {
    for (const stderr of [
      'ssh: Could not resolve hostname github.com: Name or service not known',
      'ssh: connect to host github.com port 22: Connection timed out',
      'ssh: connect to host github.com port 22: Network is unreachable',
    ]) {
      const failure = mapCloneFailure(stderr, url);
      expect(failure.cause).toBe('network');
      expect(failure.message).toMatch(/network/i);
    }
  });

  it('passes anything unrecognised through VERBATIM rather than rewording it', () => {
    const stderr = 'fatal: the remote end hung up unexpectedly\n';
    const failure = mapCloneFailure(stderr, url);
    expect(failure.cause).toBe('unknown');
    expect(failure.message).toBe('fatal: the remote end hung up unexpectedly');
    expect(failure.stderr).toBe(stderr);
  });
});
