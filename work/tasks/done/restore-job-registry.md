---
title: Path-keyed restore job registry (recursive clone with progress, cancel, safety)
slug: restore-job-registry
spec: restore-missing-folder
blockedBy: []
covers: [6, 21, 24]
---

## What to build

The server-side engine that materialises a missing folder, owned by a NEW module so it has no entanglement with the WebSocket layer (a later task wires it up, and a third re-points the existing create-session clone at it).

A registry of restore jobs KEYED BY THE RESOLVED TARGET PATH, not by socket or session. That single choice is what makes a clone survive a dropped phone connection, be shared by two tabs, and never be started twice for one folder.

Each job:

- has a state (running, done, failed, cancelled), a monotonic id, the URL it is actually cloning, the latest progress snapshot and accumulated error text; terminal jobs are retained briefly so a late reconnect still learns the outcome, then reaped;
- COALESCES: requesting a job for a path that already has a running one returns that job INCLUDING its URL, so a second requester whose edited URL differs can be told a clone of the other URL is already in flight, never silently answered as though its own URL was accepted;
- runs `git clone` with progress and recursive submodules through an ARGV ARRAY, never a shell;
- forces non-interactive credentials (no terminal prompt, no askpass, batch-mode SSH) so an unprovisioned machine fails FAST instead of hanging invisibly at zero percent;
- maps git's well-known failure signatures onto actionable messages while keeping raw stderr underneath: no key this host accepts; host missing from known-hosts (name the host, say one manual connection fixes it); repository not found which is wrong-URL OR a key without access, said as both; host resolution/timeout which is network not credentials; anything else verbatim;
- parses progress into a phase, a scope, and either a percentage or an explicit indeterminate marker, throttled to a few frames per second, with submodules reported under their own scope rather than folded into a fake global percentage;
- supports CANCEL, killing the child and removing the target directory only if the job created it;
- has a second, trivial job kind: create the folder (`mkdir -p`) with an optional git init, so callers drive ONE state machine rather than two.

The module also OWNS the observation seam, because it has two independent consumers and neither should reach into its internals: a later task broadcasts progress and completion to matching WebSocket clients, and another invalidates a per-folder existence cache when a job completes. So expose subscription explicitly (observe a job's progress and its terminal outcome, and unsubscribe), rather than leaving each consumer to poll or to be wired through the other.

Safety, non-negotiable: the resolved target must be inside the home directory (reuse the existing guard); the leaf must be absent or empty and the parent is created; the URL is validated against a shape allowlist (scp-style SSH, `ssh://`, and `file://` for fixtures) rejecting control characters, newlines, and a leading dash; and the clone argv must NEVER carry a relaxation of git's file-transport protection.

## Acceptance criteria

- [ ] A clone job against a local fixture repository completes, and the SUBMODULE CONTENT is present in the result (this is the recursion assertion and it is the one that silently regresses).
- [ ] Progress updates are emitted during the clone with a phase, a scope, and a percentage or an explicit indeterminate marker; submodule progress is scoped to the submodule, not merged into one number.
- [ ] Progress parsing splits on CARRIAGE RETURN as well as newline. Assert this directly with a recorded git progress chunk: git rewrites one line in place, so a newline-only parser sees almost nothing during the receiving phase, which is exactly the phase a long clone spends its time in.
- [ ] A second request for a path with a running job returns the SAME job and reports the URL that job is cloning, and only one clone process is started.
- [ ] Cancel terminates the job and removes a directory the job created; a pre-existing directory is not removed.
- [ ] A failing clone surfaces a mapped, human-readable cause AND retains git's raw stderr.
- [ ] Rejections are tested: a target outside the home directory, a non-empty target leaf, a malformed URL, and a URL containing shell metacharacters (assert no side-effect file was created, mirroring the existing command-injection regression discipline).
- [ ] The create-folder job kind creates the directory and, when asked, initialises a git repository.
- [ ] The module exposes an explicit subscription seam (progress plus terminal outcome, with unsubscribe) and it is tested with TWO independent subscribers on one job, since that is exactly how it will be used (client broadcast, and cache invalidation).
- [ ] **Shared-write isolation (WORK-CONTRACT.md), with the lever named for THIS task's resolution site:** these are IN-PROCESS module tests, so the home-directory guard resolves against the TEST process, not a spawned child. Set the test process's own `HOME` to a temp directory (verified: an in-process `HOME` override does change the resolved home) and assert the developer's real home is untouched. Do not copy the harness pattern of overriding a child's environment, that lever belongs to the later protocol-level tasks. Git must also be isolated: there are currently NO git invocations anywhere in the test suites, so these are the first, and they must neutralise global and system git config and supply an explicit committer identity rather than depending on `~/.gitconfig`.
- [ ] The `file://` submodule fixture works: git has refused file-transport submodules since 2.38 (CVE-2022-39253), so a naive recursive clone dies with `fatal: transport 'file' not allowed`. Inject the relaxation ONLY into the test's own environment via `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0=protocol.file.allow` / `GIT_CONFIG_VALUE_0=always` (verified working on git 2.47.3), and assert it is absent from the production clone arguments.
- [ ] A changeset is added for `wherever-dev`.

## Blocked by

- None, can start immediately. This is a new module and is file-orthogonal to the folder-missing state task, so the two can run in parallel.

## Prompt

> Goal: build the server-side engine that restores a missing folder, as a standalone module with its own tests, wired to nothing yet.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): does the session pool still contain a synchronous clone helper and a provider-detection helper, and does the HTTP layer still expose a home-directory guard? If the landscape moved, route to needs-attention rather than building on a stale premise.
>
> Vocabulary: a RESTORE JOB materialises a missing working folder, either by CLONING a remote or by CREATING an empty folder. Jobs are keyed by the resolved absolute TARGET PATH. The reason for path-keying (rather than socket- or session-keying) is disconnect survival, cross-device sharing, and de-duplication; it is worth an ADR if one does not already exist.
>
> Where to look, by concept: the session pool's existing synchronous clone helper (which this module replaces, note it does NOT currently recurse into submodules and reports no progress), its upstream-tracking setup which must be preserved, its provider-detection helper, and the HTTP layer's home-directory guard and its argv-array discipline (a command-injection fix already forced every git/provider call onto argument arrays, do not regress it).
>
> Transport decision, already made by the owner: SSH ONLY. The server box is assumed provisioned (a key the host accepts, a populated known-hosts, an authenticated provider CLI used for the PROBE only). There is no HTTPS fallback, no token, and no credential setup. That decision is exactly why the ERROR MAPPING above is load-bearing: it is the whole remedy for an unprovisioned box, so treat those messages as a deliverable, not as polish.
>
> Seams to test at: the module's own API (start a job, observe progress, await the outcome, cancel) against local git fixtures. No network, no SSH key, no provider CLI in tests.
>
> Verified facts, do not re-derive: git emits progress as carriage-return-rewritten lines inside one newline-terminated chunk; file-transport submodule cloning is blocked from git 2.38 onward and the environment-variable relaxation above works; the existing create-session clone path times out client-side after 25 seconds, which is why progress and asynchrony matter.
>
> Done means: the module clones recursively with observable, honest progress, refuses unsafe inputs, explains failures, cancels cleanly, and is covered by tests that pollute nothing outside their temp directories.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (ADR if it meets the gate, otherwise a JSDoc at the choice site or a `## Decisions` block).

## Decisions

1. **The home guard is mirrored, not imported** (JSDoc at `isWithinHome` in `restore-jobs.ts`). `index.ts` calls `dispatch()` at import, so importing its guard from a library module would start the CLI. Alternative considered: extract the guard first, rejected as it edits `index.ts` which this task must leave alone. Touches the later wiring task: it should collapse both onto this one.
2. **`setupUpstreamTracking` is re-implemented here, not imported** (JSDoc at the function). `session-pool.ts` pulls the whole pi-coding-agent runtime, which would end the module's standalone-ness and its fast tests. Touches the re-point task, which should delete the session-pool copies. Behaviour is pinned by a test (`branch.main.remote === origin`).
3. **URL validation is a shape ALLOWLIST, not a metacharacter denylist** (JSDoc at the regexes). It also excludes git's own dangerous transports (`ext::`, `--upload-pack=`) that no argv array protects against. Touches the later candidate-URL task: any candidate it synthesises must satisfy this allowlist.
4. **Git's "correct access rights and the repository exists" trailer is deliberately NOT a `no-key` signature** (comment at the choice site). It is printed for a missing key *and* a missing repo, so keying on it reports every wrong-URL clone as a credentials problem. This is a user-visible message default.
5. **Cancel is authoritative** (JSDoc at `cancel`): the job settles `cancelled` even if the child finished in the same breath, because the user asked for the folder not to be there. Alternative (last-writer-wins on exit code) rejected as it would leave a folder behind after an explicit cancel.
6. **`ConnectTimeout=10` on the SSH command** (JSDoc at `buildCloneEnv`): a user-visible default covering the one hang batch mode cannot (a host that accepts TCP then goes silent). Reversible in one line.
