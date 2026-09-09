---
title: Restore panel: clone a missing folder with live progress, cancel, and reload
slug: restore-clone-panel
spec: restore-missing-folder
blockedBy: [folder-missing-read-only-state, restore-job-registry, restore-remote-candidates]
covers: [4, 7, 8, 9, 10, 11, 12, 13, 14]
---

## What to build

The user-facing half: in place of the composer of a folder-missing session, a restore panel that clones the repository and shows what is happening, wired to the path-keyed job registry over the WebSocket protocol.

End to end:

- The folder-missing frame is extended to carry the resolved SSH candidates AND any restore job already running for that path, so a client that arrives mid-clone (a reconnect, a second device, a phone waking up) paints the running progress immediately instead of offering to start a second clone.
- New client-to-server frames: start a restore (target path, action, URL) and cancel a restore. New server-to-client frames: restore progress and restore completion.
- Progress frames are broadcast to every connected client whose current session cwd, or pending load target, equals the job path. Subscription is DERIVED from that match, not registered, so no bookkeeping can leak.
- The panel: the missing path, an editable URL field pre-filled with the first candidate, a Clone button, a progress display, a Cancel button while running, and on success a "folder is ready" state with a RELOAD action (the live agent is a load-time decision, so reloading the session is the honest way to get one).
- The progress display is honest per story 8: it shows the phase, the scope (the repository itself or a named submodule), a percentage when git gives one and an explicit indeterminate state when it does not, and it states that submodules are counted separately rather than pretending to a single global percentage.
- Failures show the mapped cause from the registry with git's raw output available underneath.
- A second client tapping Clone while a job runs JOINS that job and is told which URL is being cloned, rather than starting a competing clone or silently having its edited URL ignored.

## Acceptance criteria

- [ ] Loading a folder-missing session shows the restore panel with the missing path and a pre-filled, editable SSH URL.
- [ ] Tapping Clone against a local fixture repository drives the job to completion; progress frames arrive, and the session becomes normally loadable afterwards (reload yields a live agent that accepts a message).
- [ ] Disconnecting mid-clone and reconnecting re-paints the RUNNING job with its current progress, and exactly ONE clone process was started.
- [ ] Two clients on the same missing folder both see the same job; the second Clone tap joins it and is told the URL actually in flight.
- [ ] Cancel from the panel stops the job and returns the panel to its offer-to-restore state.
- [ ] A failed clone shows the mapped cause (for example an unreachable host or a rejected key) with raw output available.
- [ ] Progress rendering distinguishes a real percentage from an indeterminate phase and shows submodule scope separately.
- [ ] The shared client package carries every new frame and builds; the VS Code companion is not broken by the protocol additions.
- [ ] `CONTEXT.md` documents the restore protocol: the new client and server frames, the derived (path-matching) subscription rule, and the reload-to-go-live ending. It also PINS the wording, since "restore" already means re-materialising queued steers and drafts in this codebase, so the next author does not fork the term a third time. No later task owns this.
- [ ] Tests cover the protocol behaviours above at the WebSocket seam (real server, fake LLM, local git fixture), including the reconnect and single-clone assertions.
- [ ] **Shared-write isolation:** tests run the server with `HOME` at a temp directory, isolate global and system git config, and assert the real home is untouched.
- [ ] A changeset is added for `wherever-dev` (and the client/extension packages if their published types change).

## Blocked by

- `folder-missing-read-only-state` (the state and frame this extends), `restore-job-registry` (the engine it drives), and `restore-remote-candidates` (the URLs it pre-fills). It also shares files with all three, so the ordering doubles as conflict avoidance.

## Prompt

> Goal: let a user on a phone restore a missing repository by tapping Clone, watch it honestly, cancel it, survive a dropped connection, and come back to a live session.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): are the folder-missing state, the job registry, and the candidate resolver landed in the shape assumed here? If any dependency landed differently, route to needs-attention rather than papering over it.
>
> Vocabulary: RESTORE means materialising a missing working folder (note the codebase already uses "restore" for re-materialising queued steers and drafts, so keep the new frames namespaced and pin the wording in `CONTEXT.md`); a RESTORE JOB is keyed by target path and owned by the server; READ-ONLY here is the hard folder-missing reason, which only a successful restore plus a reload clears.
>
> Where to look, by concept: the protocol module where frames are declared; the WebSocket message handler and the helper that re-states a client's read-only verdict; the per-client record that tracks its current session and its pending load target (that pairing is how a client with no attached session is still matched to a job path); the shared client package's frame handling; the chat component that renders the composer, the folder-conflict banner, and the existing clone-or-create dialog from the new-session flow, which is the closest UI precedent.
>
> Design constraint that carries most of the value: subscription is DERIVED by matching the job path against each client's session or pending cwd, not registered per socket. A reconnecting phone must repaint a running clone with no new job and no leaked subscription.
>
> Honesty constraint: do not invent a single global percentage across a repository and its submodules. Show the phase, the scope, and either a real percentage or an explicit indeterminate state. A fake unified bar is worse than an honest segmented one.
>
> Seams to test at: the WebSocket protocol, driven by the existing harness, against a local git fixture (no network, no SSH key, no provider CLI). Assert on frames and on the filesystem result, not on internals.
>
> Done means: the restore round trip works from the dashboard, is resilient to a dropped socket and a second device, is cancellable, explains its failures, and ends in a session that goes live after a reload.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
