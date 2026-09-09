---
'wherever-dev': patch
---

Restore panel: create the folder instead of cloning, with a git-init checkbox that honours the configured default.

The second remedy for a folder-missing session, for the case where the folder was never a clone (a scratch directory, a folder whose contents only ever lived on the old machine): make it. It reuses the clone's machinery rather than forking it, so there is ONE flow, not two.

- **Same job, same frames, same state machine.** Create is the existing path-keyed restore job's `create` kind driven over the existing `restore_start { action: 'create', gitInit }` frame: the directory and any missing parents are made, a git repository is optionally initialised, and the panel lands in the same ready-and-reload state a completed clone does. The same safety rules apply, because they are the same guards: the target must resolve inside the home directory, and an existing non-empty target is refused before anything is created.
- **The checkbox is the CONFIGURED git-init default** (`gitInitDefault`, the same value the new-session dialog reads), never a second restore-only default, so a user who turned it off does not get a surprise repository. The panel refreshes `GET /config` when it opens for a folder rather than depending on the session browser having done so, and the choice travels explicitly in both states.
- **Deliberately SECONDARY.** The common case is a repository that exists remotely, so Create sits behind a disclosure with a secondary button rather than beside Clone: an accidental tap makes an empty folder that then looks restored, while the non-empty guard refuses the clone that should have happened.
- The panel is now kind-aware in its running, cancelled and progress wording, and drops the submodule note and the scope label for a create, which has exactly one scope.

Tests cover both checkbox states at the WebSocket seam against the resulting filesystem state (a git repository with it on, a plain directory with it off), plus the shared refusals, with the server run against a temp `HOME` and isolated git config.
