---
title: Re-point new-session cloning at the restore registry (progress instead of a blocking overlay)
slug: new-session-clone-via-registry
spec: restore-missing-folder
blockedBy: [restore-clone-panel]
covers: [15, 22]
needsAnswers: false
---

## What to build

Creating a NEW session in a folder that does not exist already supports cloning a matching remote, but it does so synchronously behind the blocking "Creating session..." overlay: no progress, no submodules, and a client-side watchdog that gives up after 25 seconds while the clone is still running. A large repository is effectively un-clonable that way.

Re-point that path at the restore job registry so there is ONE clone implementation:

- Session creation with a clone starts (or joins) a path-keyed restore job and reports it to the client, which shows the SAME progress display as the restore panel instead of a blocking overlay.
- When the job succeeds, the server CONTINUES into session creation automatically. Unlike the loaded-session path there is nothing to reload here, because the session does not exist until the clone lands, so the flow must complete itself rather than asking the user to retry.
- When the job fails or is cancelled, the create attempt fails with the mapped cause and leaves no half-made session.
- The old synchronous clone helper is DELETED, not left beside the new one. Its upstream-tracking behaviour must be preserved by the registry path. This removal is part of the task: a second, divergent clone implementation is exactly the drift this work exists to end.

Cloning gains recursive submodules here as a consequence, which is a behaviour change worth calling out in the changeset.

## Acceptance criteria

- [ ] Creating a session in a missing folder that matches an existing remote clones through the registry, with progress frames, and the session is created automatically when the clone completes.
- [ ] The clone is recursive (submodule content present) via the same engine as the restore panel.
- [ ] A clone that takes longer than the client's create watchdog no longer strands the UI: the blocking overlay is not the mechanism any more.
- [ ] A failed clone surfaces the mapped cause and leaves no partially created session.
- [ ] The previous synchronous clone helper no longer exists in the codebase, and upstream tracking is still configured on the resulting clone.
- [ ] Existing create-session behaviour for folders that DO exist, and for the create-a-new-remote path, is unchanged and its tests stay green.
- [ ] Tests cover the create-with-clone round trip against a local fixture at the protocol seam.
- [ ] **Shared-write isolation:** tests run the server with `HOME` at a temp directory, isolate git config, and assert the real home is untouched.
- [ ] A changeset is added for `wherever-dev`, explicitly noting that new-session cloning is now recursive and progress-reported.

## Blocked by

- `restore-clone-panel`: the registry wiring, the progress frames, and the progress UI it reuses all land there, and both tasks edit the session-creation and chat-component surfaces.

## Prompt

> Goal: make the new-session clone path use the same engine, the same progress, and the same safety as the restore panel, and delete the old synchronous implementation.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): is the restore registry landed and wired, and does session creation still accept a clone-the-existing-remote choice from the dashboard? If the shape moved, route to needs-attention.
>
> Vocabulary: the create-session flow already distinguishes CREATE A REMOTE (provision a new repository for a new folder) from CLONE AN EXISTING REMOTE (a repository the probe found). Only the CLONE branch changes here; the create-a-remote branch keeps its behaviour.
>
> Where to look, by concept: the session pool's create-new-session function and its clone branch; the WebSocket new-session handler; the dashboard's clone-or-create dialog and its blocking creation overlay; the client's create watchdog, which fires at 25 seconds and is precisely why a synchronous clone cannot stay.
>
> The asymmetry to respect: the loaded-session restore ends by asking the user to reload, because a live agent is a load-time decision. This path CANNOT do that, because there is no session to reload until the clone succeeds, so the server must continue into creation itself once the job completes.
>
> Seams to test at: the WebSocket protocol against a local fixture repository, plus the filesystem result including submodule content.
>
> Done means: one clone implementation exists in the codebase, both entry points show real progress, and large repositories are creatable without hitting a watchdog.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
