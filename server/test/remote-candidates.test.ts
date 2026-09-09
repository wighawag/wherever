import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveCandidateFromPath,
  matchRemoteRepoRule,
  resolveRemoteCandidates,
  type RemoteCandidate,
} from '../src/remote-candidates.js';
import type { RemoteRepoRule } from '../src/session-pool.js';
import { startHarness, type Harness } from './harness.js';

/**
 * Which repository does this MISSING folder correspond to?
 *
 * The answer is an ORDERED, advisory list of SSH candidates: a provider PROBE
 * first (the repositories the configured account owns), then a derivation from
 * the `<...>/<host-token>/<owner>/<repo>` folder layout (the repositories owned
 * by SOMEONE ELSE, which the probe structurally cannot find and which dominate a
 * machine migration where a single rule covers a single namespace).
 *
 * Two isolation levers matter here (work/protocol/WORK-CONTRACT.md):
 *
 *  1. HOME. Rule patterns are written with a leading `~` and are expanded
 *     against `os.homedir()` at CALL time, in THIS process, so the fake home has
 *     to be this process's own; the endpoint half spawns a server with the same
 *     HOME, because its home-directory guard resolves there.
 *  2. No provider CLI. The probe is an INJECTED function, so nothing in this
 *     suite shells out to `gh`/`tea`/`cb`, and the endpoint tests deliberately
 *     configure no matching rule so the server has nothing to probe with.
 */

const REAL_HOME = os.homedir();
const realHomeBefore = new Set(fs.readdirSync(REAL_HOME));

let root = '';
let fakeHome = '';
let savedHome: string | undefined;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-candidates-')));
  fakeHome = path.join(root, 'home');
  fs.mkdirSync(fakeHome);
  savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  // The tilde expansion resolves home in THIS process; prove the override took.
  expect(os.homedir()).toBe(fakeHome);
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
  // Nothing this suite did may have landed in the developer's real home.
  const added = fs.readdirSync(REAL_HOME).filter((e) => !realHomeBefore.has(e));
  expect(added.filter((e) => /wherever-candidates/.test(e))).toEqual([]);
});

/** Every candidate this feature is allowed to emit is an SSH remote (ADR 0010). */
function expectSshOnly(candidates: RemoteCandidate[]): void {
  for (const c of candidates) {
    expect(c.url.startsWith('https://')).toBe(false);
    expect(c.url.startsWith('http://')).toBe(false);
    expect(/^(git@|ssh:\/\/)/.test(c.url)).toBe(true);
  }
}

describe('deriving a candidate from the folder layout', () => {
  it('maps a known host token to its host', () => {
    expect(deriveCandidateFromPath('/home/u/dev/github/someone/some-repo')).toEqual({
      url: 'git@github.com:someone/some-repo.git',
      source: 'path-convention',
    });
    expect(deriveCandidateFromPath('/home/u/dev/codeberg/someone/some-repo')?.url).toBe(
      'git@codeberg.org:someone/some-repo.git',
    );
    expect(deriveCandidateFromPath('/home/u/dev/gitlab/someone/some-repo')?.url).toBe(
      'git@gitlab.com:someone/some-repo.git',
    );
  });

  it('takes a token that is ALREADY a dotted hostname to be that host', () => {
    expect(deriveCandidateFromPath('/home/u/src/git.example.com/team/thing')?.url).toBe(
      'git@git.example.com:team/thing.git',
    );
  });

  it('offers NOTHING for an unknown token rather than a wrong candidate', () => {
    // `projects` is a folder name, not a forge. Guessing github.com here would
    // pre-fill a URL that is confidently wrong, which is worse than empty.
    expect(deriveCandidateFromPath('/home/u/projects/someone/some-repo')).toBeNull();
  });

  it('offers nothing for a path too shallow to carry an owner and a repo', () => {
    expect(deriveCandidateFromPath('/home/u/some-repo')).toBeNull();
    expect(deriveCandidateFromPath('/github')).toBeNull();
  });

  it('does not double the `.git` suffix when the folder already carries one', () => {
    expect(deriveCandidateFromPath('/home/u/dev/github/someone/some-repo.git')?.url).toBe(
      'git@github.com:someone/some-repo.git',
    );
  });

  it('never derives an HTTPS URL', () => {
    const derived = [
      deriveCandidateFromPath('/home/u/dev/github/someone/some-repo'),
      deriveCandidateFromPath('/home/u/dev/codeberg/someone/some-repo'),
      deriveCandidateFromPath('/home/u/src/git.example.com/team/thing'),
    ].filter((c): c is RemoteCandidate => c !== null);
    expect(derived.length).toBe(3);
    expectSshOnly(derived);
  });
});

describe('matching a folder against the configured remote-repo rules', () => {
  const rules: RemoteRepoRule[] = [{ pattern: '~/dev/github/me/', provider: 'github' }];

  it('expands a leading tilde in the pattern, as users write it', () => {
    expect(matchRemoteRepoRule(rules, path.join(fakeHome, 'dev/github/me/thing'))).toBe(rules[0]);
    expect(matchRemoteRepoRule(rules, path.join(fakeHome, 'dev/github/other/thing'))).toBeUndefined();
  });

  it('treats an invalid pattern as a non-match instead of throwing', () => {
    expect(matchRemoteRepoRule([{ pattern: '([', provider: 'github' }], '/anywhere')).toBeUndefined();
    expect(matchRemoteRepoRule(undefined, '/anywhere')).toBeUndefined();
  });
});

describe('the ordered candidate resolver', () => {
  const rules: RemoteRepoRule[] = [{ pattern: '~/dev/github/me/', provider: 'github' }];
  const owned = () => path.join(fakeHome, 'dev/github/me/my-repo');
  const someoneElses = () => path.join(fakeHome, 'dev/github/someone-else/their-repo');

  it('puts the PROBE candidate first when the provider says the repository exists', () => {
    const probed: string[] = [];
    const candidates = resolveRemoteCandidates(owned(), rules, (rule, repoName) => {
      probed.push(`${rule.provider}:${repoName}`);
      return { exists: true, sshUrl: 'git@github.com:me-authenticated/my-repo.git' };
    });

    expect(probed).toEqual(['github:my-repo']);
    expect(candidates.map((c) => c.source)).toEqual(['probe', 'path-convention']);
    expect(candidates[0].url).toBe('git@github.com:me-authenticated/my-repo.git');
    expect(candidates[1].url).toBe('git@github.com:me/my-repo.git');
    expectSshOnly(candidates);
  });

  it('degrades to the derived candidate when the probe THROWS (no CLI on this box)', () => {
    const candidates = resolveRemoteCandidates(owned(), rules, () => {
      throw new Error('spawnSync gh ENOENT');
    });
    expect(candidates.map((c) => c.source)).toEqual(['path-convention']);
    expect(candidates[0].url).toBe('git@github.com:me/my-repo.git');
  });

  it('degrades to the derived candidate when the probe reports the repository absent', () => {
    const candidates = resolveRemoteCandidates(owned(), rules, () => ({ exists: false }));
    expect(candidates.map((c) => c.source)).toEqual(['path-convention']);
  });

  it('ignores a probe that answers with a non-SSH or empty URL', () => {
    const candidates = resolveRemoteCandidates(owned(), rules, () => ({
      exists: true,
      sshUrl: 'https://github.com/me/my-repo.git',
    }));
    expect(candidates.map((c) => c.source)).toEqual(['path-convention']);
    expectSshOnly(candidates);
  });

  it('never probes a folder no rule covers, and still derives someone ELSE\u2019s repository', () => {
    // The load-bearing case: a machine migration where the one configured rule
    // covers one personal namespace, but half the restored folders belong to
    // other owners. The probe structurally cannot find those.
    let probes = 0;
    const candidates = resolveRemoteCandidates(someoneElses(), rules, () => {
      probes++;
      return { exists: true, sshUrl: 'git@github.com:me/their-repo.git' };
    });
    expect(probes).toBe(0);
    expect(candidates).toEqual([
      { url: 'git@github.com:someone-else/their-repo.git', source: 'path-convention' },
    ]);
  });

  it('reports the same URL ONCE, keeping the probe as its source', () => {
    const candidates = resolveRemoteCandidates(owned(), rules, () => ({
      exists: true,
      sshUrl: 'git@github.com:me/my-repo.git',
    }));
    expect(candidates).toEqual([{ url: 'git@github.com:me/my-repo.git', source: 'probe' }]);
  });

  it('answers honestly EMPTY when neither source has anything', () => {
    expect(resolveRemoteCandidates(path.join(fakeHome, 'notes'), rules, () => ({ exists: false }))).toEqual([]);
  });

  it('resolves path-convention only when no probe function is supplied', () => {
    const candidates = resolveRemoteCandidates(owned(), rules);
    expect(candidates.map((c) => c.source)).toEqual(['path-convention']);
  });
});

describe('the /remote-candidates endpoint', () => {
  // No remoteRepoRules are configured, so the server has nothing to probe with:
  // the suite passes on a machine with no `gh`/`tea`/`cb`, authenticated or not.
  const TOKEN = 'candidate-endpoint-token';
  let h: Harness | undefined;
  let endpointHome = '';

  beforeAll(async () => {
    endpointHome = path.join(root, 'endpoint-home');
    fs.mkdirSync(path.join(endpointHome, '.wherever'), { recursive: true });
    fs.writeFileSync(path.join(endpointHome, '.wherever', 'config.json'), JSON.stringify({}));
    h = await startHarness({ env: { HOME: endpointHome, WHEREVER_TOKEN: TOKEN } });
  }, 60000);

  afterAll(async () => {
    await h?.cleanup();
    h = undefined;
  });

  async function get(query: string, token: string | null = TOKEN) {
    const qs = token === null ? query : `${query}&token=${encodeURIComponent(token)}`;
    const res = await fetch(`http://127.0.0.1:${h!.port}/remote-candidates?${qs}`);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }

  it('is behind the authentication gate', async () => {
    const anonymous = await get(`path=${encodeURIComponent('~/dev/github/someone/some-repo')}`, null);
    expect(anonymous.status).toBe(401);

    const wrong = await get(`path=${encodeURIComponent('~/dev/github/someone/some-repo')}`, 'nope');
    expect(wrong.status).toBe(401);
  });

  it('refuses a path outside the home directory', async () => {
    const outside = await get(`path=${encodeURIComponent('/etc/github/someone/some-repo')}`);
    expect(outside.status).toBe(403);
    expect(String(outside.body.error)).toMatch(/home directory/i);
  });

  it('requires a path', async () => {
    expect((await get('')).status).toBe(400);
  });

  it('answers with the derived SSH candidate for a missing folder', async () => {
    const missing = path.join(endpointHome, 'dev/github/someone-else/their-repo');
    const res = await get(`path=${encodeURIComponent(missing)}`);
    expect(res.status).toBe(200);
    expect(res.body.resolvedPath).toBe(missing);
    expect(res.body.candidates).toEqual([
      { url: 'git@github.com:someone-else/their-repo.git', source: 'path-convention' },
    ]);
    expectSshOnly(res.body.candidates as RemoteCandidate[]);
  });

  it('answers honestly empty for a folder no source can name', async () => {
    const res = await get(`path=${encodeURIComponent('~/notes')}`);
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
  });
});
