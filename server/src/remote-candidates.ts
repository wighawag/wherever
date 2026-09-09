// Remote CANDIDATES: which repository does a MISSING working folder correspond to?
//
// A synced transcript routinely names a clone that does not exist on this
// machine (`folder missing`, see CONTEXT.md). Curing that is a RESTORE, and the
// restore panel wants a URL pre-filled rather than typed on a phone. This module
// answers with an ORDERED list of candidates, in decreasing confidence:
//
//  1. PROBE. The folder matches a configured remote-repo rule, so the provider
//     CLI the create-session path already uses is asked whether that repository
//     exists, and its SSH URL is taken. This covers what the configured account
//     OWNS.
//  2. PATH CONVENTION. The `<...>/<host-token>/<owner>/<repo>` layout is read
//     back into an scp-style SSH URL. This is what covers repositories owned by
//     SOMEONE ELSE, which the probe structurally cannot find, and it is the case
//     that DOMINATES the migration this feature exists for: one rule covering
//     one personal namespace, and a folder tree full of other people's repos.
//  3. Nothing. An empty list is an honest answer; the user pastes a URL.
//
// A candidate is ADVISORY, never an authority: the server clones what it is
// finally GIVEN (after `restore-jobs.ts` validates it), not what it guessed here.
// Every candidate is an SSH remote and an HTTPS URL is never synthesised
// (`docs/adr/0010`), including one handed back by a provider CLI.
//
// The probe is an INJECTED function rather than an import. That keeps this
// module free of the session pool (and so of the pi agent dependency it drags
// in), keeps the resolver a fast pure function over a path plus a rules list,
// and makes "the tests need no provider CLI installed or authenticated"
// structural rather than a discipline.

import os from 'node:os';
import path from 'node:path';
import type { RemoteRepoRule } from './session-pool.js';

/** Where a candidate came from. Ordering is probe-then-derived, by confidence. */
export type RemoteCandidateSource = 'probe' | 'path-convention';

export interface RemoteCandidate {
  /** An scp-style SSH URL (`git@host:owner/repo.git`). Never HTTPS. */
  url: string;
  source: RemoteCandidateSource;
}

/**
 * The shape of `detectRemoteRepo` in `session-pool.ts`, as this module needs it.
 * Injected by the caller so nothing here ever shells out on its own.
 */
export type RemoteRepoProbeFn = (
  rule: RemoteRepoRule,
  repoName: string,
) => { exists: boolean; sshUrl?: string };

/**
 * Folder tokens that NAME a forge. Deliberately short: a token that is not one
 * of these and is not already a hostname yields NO candidate, because a
 * confidently wrong pre-filled URL is worse than an empty field the user pastes
 * into. `gitea`/`forgejo` are absent on purpose -- they are software, not a
 * host, so the self-hosted instance is written as its own dotted hostname.
 */
const HOST_TOKENS: Record<string, string> = {
  github: 'github.com',
  codeberg: 'codeberg.org',
  gitlab: 'gitlab.com',
};

/** A token that is already a hostname (`git.example.com`) stands for itself. */
const DOTTED_HOST = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Owner / repo segments, restricted to what the clone URL allowlist accepts. */
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Candidates are SSH-only (`docs/adr/0010`), whatever their source claims. */
const SSH_CANDIDATE = /^(?:[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+|ssh:\/\/[^\s]+)$/;

function expandTilde(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

/**
 * The first rule whose `pattern` matches `resolvedPath`, or undefined.
 *
 * `resolvedPath` is absolute and tilde-EXPANDED (`/home/u/dev/...`), so a
 * pattern written with a leading `~` (as users naturally write it, mirroring
 * `commonFolders`) would never match; expand it before building the RegExp. An
 * invalid pattern is a non-match rather than a throw: one malformed rule in the
 * config must not take out every caller of this.
 *
 * This is the ONE implementation of remote-repo rule matching -- `/check-path`,
 * `/check-remote-repo` and the candidate resolver all come here, so a fix to the
 * matching semantics lands once.
 */
export function matchRemoteRepoRule(
  rules: RemoteRepoRule[] | undefined,
  resolvedPath: string,
): RemoteRepoRule | undefined {
  if (!rules || !Array.isArray(rules)) return undefined;
  return rules.find((rule) => {
    try {
      return new RegExp(expandTilde(rule.pattern)).test(resolvedPath);
    } catch {
      return false;
    }
  });
}

/**
 * Read `<...>/<host-token>/<owner>/<repo>` back into an SSH URL, or null when
 * the layout does not carry one: an unknown host token, a path too shallow for
 * an owner and a repo, or segments that are not plausible owner/repo names.
 *
 * Only the LAST THREE segments are consulted, so the convention holds wherever
 * the tree is rooted (`~/dev/github/o/r`, `~/src/work/github/o/r`).
 */
export function deriveCandidateFromPath(resolvedPath: string): RemoteCandidate | null {
  const segments = path.resolve(resolvedPath).split(path.sep).filter(Boolean);
  if (segments.length < 3) return null;

  const [hostToken, owner, repoSegment] = segments.slice(-3);
  const host = resolveHostToken(hostToken);
  if (!host) return null;
  if (!PATH_SEGMENT.test(owner) || !PATH_SEGMENT.test(repoSegment)) return null;

  // A folder named `repo.git` (a bare-style checkout) must not become `repo.git.git`.
  const repo = repoSegment.endsWith('.git') ? repoSegment.slice(0, -'.git'.length) : repoSegment;
  if (!repo) return null;

  return { url: `git@${host}:${owner}/${repo}.git`, source: 'path-convention' };
}

function resolveHostToken(token: string): string | null {
  const lowered = token.toLowerCase();
  if (HOST_TOKENS[lowered]) return HOST_TOKENS[lowered];
  if (DOTTED_HOST.test(lowered)) return lowered;
  return null;
}

/**
 * The ordered candidate list for `resolvedPath`: the probe candidate first (when
 * a rule covers the folder AND the provider says the repository exists), then
 * the path-convention one, de-duplicated by URL.
 *
 * `probe` is optional; omitting it resolves the path convention alone. A probe
 * failure of ANY kind -- CLI missing, not authenticated, repository absent, a
 * throw -- degrades to the derived candidate rather than erroring, because a
 * candidate list is advisory and an unprovisioned box must still get the answer
 * it can have.
 */
export function resolveRemoteCandidates(
  resolvedPath: string,
  rules: RemoteRepoRule[] | undefined,
  probe?: RemoteRepoProbeFn,
): RemoteCandidate[] {
  const candidates: RemoteCandidate[] = [];

  const rule = matchRemoteRepoRule(rules, resolvedPath);
  if (rule && probe) {
    try {
      const result = probe(rule, path.basename(path.resolve(resolvedPath)));
      if (result?.exists && result.sshUrl && isSshCandidate(result.sshUrl)) {
        candidates.push({ url: result.sshUrl, source: 'probe' });
      }
    } catch {
      // CLI missing, not logged in, network down: fall through to the derivation.
    }
  }

  const derived = deriveCandidateFromPath(resolvedPath);
  // The probe and the convention routinely agree (the owner's own namespace laid
  // out by convention). Report the URL once, keeping the more confident source.
  if (derived && !candidates.some((c) => c.url === derived.url)) candidates.push(derived);

  return candidates;
}

/** An HTTPS URL is never a candidate, even when a provider CLI hands one over. */
function isSshCandidate(url: string): boolean {
  return SSH_CANDIDATE.test(url) && !url.startsWith('-');
}
