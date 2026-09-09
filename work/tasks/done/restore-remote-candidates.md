---
title: Resolve SSH remote candidates for a missing folder (probe, then path convention)
slug: restore-remote-candidates
spec: restore-missing-folder
blockedBy: [folder-missing-read-only-state]
covers: [5, 25]
---

## What to build

The server-side answer to "which repository does this missing folder correspond to?", served to the dashboard so the restore panel can pre-fill a URL the user can then edit.

An ordered candidate resolver for a resolved absolute path:

1. **Provider probe.** If the path matches a configured remote-repo rule, reuse the existing provider detection (the authenticated provider CLI the create-session path already uses) and take its SSH URL. This covers repositories the configured account owns.
2. **Path convention.** Derive from the layout `<...>/<host-token>/<owner>/<repo>`, mapping a known host token to a host (a `github` segment to github.com, `codeberg` to codeberg.org, `gitlab` to gitlab.com, and a token that is already a dotted hostname to itself), yielding an scp-style SSH URL. This is what covers repositories owned by SOMEONE ELSE, which the probe structurally cannot find, and it is the case that actually dominates a machine migration where only one namespace is covered by a rule.
3. **Nothing.** The field is empty and the user pastes a URL.

Both sources emit SSH URLs only; an HTTPS candidate is never synthesised. Candidates are advisory: the server clones what it is finally given (after validation), not what it guessed.

Exposed through an authenticated endpoint beside the existing remote-repository checks, called on demand (the probe shells out to a provider CLI, so it must never run per keystroke).

## Acceptance criteria

- [ ] The path-convention derivation is unit-tested across the interesting shapes: a known host token, an already-dotted hostname token, an unknown token (no candidate rather than a wrong one), and a path too shallow to carry owner and repo.
- [ ] A path matching a configured remote-repo rule yields the probe candidate FIRST, ahead of the derived one, when the provider CLI reports the repository exists.
- [ ] A probe failure of any kind (CLI missing, not authenticated, repository absent) degrades to the derived candidate instead of erroring, and never blocks the response.
- [ ] No candidate is ever an HTTPS URL.
- [ ] The endpoint is behind the authentication gate and refuses a path outside the home directory.
- [ ] Tests cover the resolver without requiring a provider CLI to be installed or authenticated on the machine running them.
- [ ] **Shared-write isolation:** tests run with `HOME` pointed at a temp directory (the home guard resolves against the server process home) and assert the real home is untouched.
- [ ] A changeset is added for `wherever-dev`.

## Blocked by

- `folder-missing-read-only-state`, which touches the same HTTP/WebSocket entry module; serialised to avoid a merge conflict rather than for a logical dependency.

## Prompt

> Goal: given a folder path that does not exist locally, produce the best SSH URL(s) for the repository it probably is, without ever guessing HTTPS and without blocking on a provider CLI.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): do the configured remote-repo rules, the provider-detection helper, and the on-demand remote-existence endpoint still exist in the shape assumed here? If not, route to needs-attention instead of building on the stale premise.
>
> Vocabulary: a REMOTE REPO RULE maps a folder-path pattern to a provider and visibility, and already drives create-time repository provisioning. A CANDIDATE is an advisory SSH URL offered to the user, never an authority.
>
> Where to look, by concept: the configuration loader that exposes the remote-repo rules and their tilde-expanded pattern matching; the session pool's provider-detection helper (which already knows how to ask a provider CLI whether a repository exists and to build its SSH URL); the HTTP layer's existing on-demand remote-check endpoint, which is the placement precedent, including that it is behind the auth gate after a past unauthenticated-route fix.
>
> Why the path-convention fallback is load-bearing and not a nicety: the motivating machine migration has exactly one rule covering one personal namespace, while the folders being restored include repositories owned by other people. Without candidate 2 those are unrestorable without typing a URL on a phone.
>
> Seams to test at: the resolver as a pure function over a path plus a rules list (fast, no CLI), and the endpoint's auth and path-scoping behaviour. Do not require a logged-in provider CLI for the suite to pass.
>
> Done means: a missing folder yields a sensible, SSH-only, ordered candidate list or an honest empty one, cheaply and safely.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
