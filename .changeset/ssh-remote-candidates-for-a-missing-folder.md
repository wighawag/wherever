---
'wherever-dev': minor
---

Answer "which repository is this missing folder?" with an ordered list of SSH candidates, served on demand from a new authenticated `GET /remote-candidates` endpoint so the restore panel can pre-fill an editable URL instead of asking for one to be typed on a phone.

- Two sources, in decreasing confidence (`server/src/remote-candidates.ts`): the PROVIDER PROBE (the folder matches a configured `remoteRepoRules` entry, so the provider CLI the create-session path already uses is asked whether the repository exists and its SSH URL is taken), then the PATH CONVENTION (`<...>/<host-token>/<owner>/<repo>` read back into `git@host:owner/repo.git`). The convention is what covers repositories owned by SOMEONE ELSE, which the probe structurally cannot find and which dominate a machine migration where one rule covers one personal namespace. Neither source produces anything: an honestly empty list, and the user pastes a URL.
- SSH only (`docs/adr/0010`): an HTTPS candidate is never synthesised, and a probe result that is not an SSH URL is dropped rather than offered. Candidates are ADVISORY -- the server clones what it is finally given (after the restore job validates it), not what it guessed.
- A probe failure of any kind (CLI missing, not authenticated, repository absent, a throw) degrades to the derived candidate instead of erroring. A folder no rule covers is never probed at all, so nothing shells out on the common path.
- Known host tokens are `github`, `codeberg` and `gitlab`, plus any token that is already a dotted hostname (`git.example.com`). An unknown token yields no candidate rather than a confidently wrong one, as does a path too shallow to carry an owner and a repo.
- The endpoint sits beside `/check-remote-repo`, behind the same token gate, and refuses a path outside the home directory like `/check-path` does. It is called on demand (the panel opening), never per keystroke and never on the session-load path, because the probe shells out.
- Remote-repo rule matching is now one implementation (`matchRemoteRepoRule`), shared by `/check-path`, `/check-remote-repo` and the resolver.
