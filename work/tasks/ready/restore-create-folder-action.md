---
title: Restore panel: create the folder instead of cloning, with a git-init checkbox
slug: restore-create-folder-action
spec: restore-missing-folder
blockedBy: [restore-clone-panel]
covers: [16]
---

## What to build

The second remedy in the restore panel, for a folder that was never a clone (a scratch directory, a folder whose contents lived only on the old machine): create it.

It reuses the registry's create-folder job kind and the panel's existing state machine, so there is one flow, not two: the action creates the directory and its parents, optionally initialises a git repository, then lands in the same "folder is ready, reload" state as a completed clone.

The git-init checkbox defaults from the server's configured git-init default rather than being hard-coded, so a user who has turned that default off does not get surprise repositories.

## Acceptance criteria

- [ ] The panel offers Create folder beside Clone, with a git-init checkbox whose initial value comes from the server's configured git-init default.
- [ ] Creating a folder makes the directory (and any missing parents) and lands in the same ready-and-reload state as a clone; reloading yields a live session that accepts a message.
- [ ] With the checkbox on, the created folder is a git repository; with it off, it is a plain directory.
- [ ] The same safety rules apply as for a clone: the target must be inside the home directory, and an existing non-empty target is refused.
- [ ] Tests cover both checkbox states at the protocol seam.
- [ ] **Shared-write isolation:** tests run the server with `HOME` at a temp directory, isolate git config, and assert the real home is untouched.
- [ ] A changeset is added for `wherever-dev`.

## Blocked by

- `restore-clone-panel`: same panel, same frames, same files. This is a deliberate serialisation to avoid a merge conflict as much as a logical dependency.

## Prompt

> Goal: add the "this folder was never a clone, just make it" remedy to the restore panel, reusing the clone flow's machinery rather than forking it.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): did the restore panel and the create-folder job kind land in the shape assumed here, and does the configuration still expose a git-init default? If not, route to needs-attention.
>
> Vocabulary: the configured GIT-INIT DEFAULT already governs whether creating a new session's folder initialises a repository; do not introduce a second, divergent default for restore.
>
> Where to look, by concept: the restore job registry's create-folder job kind; the restore panel component; the configuration loader that exposes the git-init default and how the new-session dialog already reads it.
>
> Note on expected usage: this is the RARE path. The common case is a repository that exists remotely, so keep this action visually secondary and do not let it become the accidental default tap.
>
> Seams to test at: the WebSocket protocol plus the resulting filesystem state.
>
> Done means: both remedies exist behind one state machine, the checkbox honours configuration, and the safety rules are identical to the clone path.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
