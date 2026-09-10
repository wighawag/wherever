---
'wherever-dev': minor
'@wherever-dev/client': minor
---

Creating a new session that CLONES an existing remote now runs through the path-keyed restore registry, with live progress instead of a blocking overlay, and the old synchronous clone is gone.

Creating a session in a folder that does not exist could already clone the remote the provider probe found, but it did so synchronously behind the "Creating session..." overlay: no progress, no submodules, and a 25-second client watchdog that gave up while git was still running, which made a large repository effectively un-clonable. That clone is now the same job the restore panel drives, so there is ONE clone implementation left in the codebase.

- **Cloning here is now RECURSIVE** (`--recurse-submodules`), which it was not before. A session created this way lands with its submodule content present rather than with empty submodule directories discovered later. Upstream tracking is still configured on the resulting clone, as it always was.
- **Real progress, no watchdog.** The server answers `session_new { cloneRemote: true }` with `restore_started` and then the ordinary `restore_progress` / `restore_complete` frames; the dashboard shows the same honest progress display as the restore panel (phase, scope, a real percentage or an explicitly indeterminate bar, submodules counted separately) and disarms the create watchdog while the job is watched. A multi-minute clone no longer strands the UI.
- **The server continues into creation itself** once the job is `done`. Unlike the restore panel, this path has nothing to reload: the session does not exist until the clone lands, so the flow completes itself rather than asking the user to retry.
- **A failed or cancelled clone fails the create** with the registry's mapped cause (no key this host accepts, host missing from `known_hosts`, repository not found, network) on `session_error`, and leaves no half-made session. The clone stays cancellable while it runs, through the ordinary `restore_cancel` frame, because the job is server-owned and keyed by the target path.
- **`POST /session/new` takes the same branch** for `cloneRemote`, gaining recursion; having no progress channel, it simply waits for the job.
- **The synchronous `cloneRemoteRepo()` helper is DELETED** and `SessionPool.createNewSession` no longer takes `cloneRemote`: by the time it is called the folder is there. Creating a NEW remote repository (the other branch of the clone-or-create dialog), creating a session in a folder that already exists, and the plain create-the-folder path are all unchanged.
- The shared client package carries `RestoreInfo.forSessionCreate`, which marks a restore that is the first step of a session create, so a client can tell "watch this and then hand back to the create" apart from the panel's "restore, then reload".
