# `remoteRepoRules` patterns are matched WITHOUT tilde expansion inside `session-pool.ts`

2026-09-09 — noticed while consolidating rule matching for `restore-remote-candidates`.

The HTTP layer expands a leading `~` in a rule `pattern` before matching (`matchRemoteRepoRule`, formerly `repoRuleMatches` in `index.ts`), but `server/src/session-pool.ts` matches with a bare `new RegExp(r.pattern).test(resolvedCwd)` in two places (around the create-session clone probe and the remote-repo provisioning). So a pattern written the natural way, `~/dev/github/me/`, matches in `/check-path` and `/check-remote-repo` but NOT when the session is actually created, and an invalid pattern throws there instead of being a non-match. Left alone (out of scope): both should go through the shared matcher.
