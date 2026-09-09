---
title: Restore a session's missing folder from the dashboard (read-only until cloned or created)
slug: restore-missing-folder
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `CONTEXT.md` + `docs/` (decisions) + the code; remaining work: the tasks sliced from this spec.

## Problem Statement

Session transcripts and the folders they refer to travel separately. Transcripts live in pi's agent dir and are trivially synced across machines (syncthing, a backup restore, a new laptop); the working folders are git clones that are NOT synced and simply do not exist on the new machine.

Open one of those sessions in the wherever dashboard today and the result is silently wrong:

- The cheap header-and-history read happily paints the whole conversation (it only reads the session file), so the session looks fine.
- The cold path then builds a live agent against a directory that is not there. Settings and resource loading both succeed against a missing directory rather than throwing, so every file tool and every bash call misbehaves later and nothing in the UI says why.
- The only remedy is to leave the phone or the dashboard, get to a terminal on the server machine, remember the repo URL, `git clone` it by hand (and remember `--recurse-submodules`), then come back and reload.

That last point is the real cost: wherever exists so the user can drive their machine from a phone. "Go find a terminal and clone 40 repos by hand" defeats the product on exactly the day it is needed most, the day the machine is new.

There is a second, pre-existing hole with the same shape: creating a NEW session in a folder that does not exist already supports cloning a matching remote, but it clones synchronously behind the blocking "Creating session..." overlay, with no progress, no submodules, and a watchdog that gives up while the clone is still running. A large repo is effectively un-clonable that way.

## Solution

A missing folder becomes an explicit, first-class session state instead of an invisible broken one.

When a session is loaded and its `cwd` does not exist on the filesystem:

1. The transcript still paints (reading a conversation never needed the folder), but the session is **read-only** and the live agent is **never built**.
2. In place of the composer, the client shows a **restore panel** naming the missing path, offering two remedies:
   - **Clone repository**: pre-filled with the best remote URL the server can work out (provider probe first, path convention second), editable by the user. Clones **recursively (submodules) by default**, with a live progress bar.
   - **Create folder**: `mkdir -p`, with a **git init checkbox** (defaulted from `gitInitDefault`), for the rarer case where the folder was never a clone.
3. The clone is a **server-owned job keyed by the target path**, not a socket-scoped operation. It survives the browser closing, a phone locking, a reconnect, or a second tab: whoever attaches next sees the running job and its live progress, and a second request for the same path joins the running job rather than starting a competing clone.
4. When the job finishes, the panel says so and offers **Reload** (the agent build is a load-time decision, so re-loading the session is the honest way to get a live agent).
5. The **new-session** path reuses the same job machinery, and there the flow does NOT end in a reload: once the clone job succeeds the server continues into session creation automatically, so the user watches a real progress bar instead of a blocking overlay that may time out.
6. The **session browser** marks folders that do not exist locally, so on a fresh machine the user can see at a glance which conversations are restorable-but-not-yet-restored, before opening them.

## User Stories

1. As a user on a fresh machine with synced transcripts, I want to open a session whose folder is missing and still READ the whole conversation, so that my history is never hostage to a missing clone.
2. As a user, I want that session to be clearly READ-ONLY with an explanation naming the exact missing path, so that I understand why I cannot type instead of wondering if the app is broken.
3. As a user, I want the server to NEVER build a live agent against a missing folder, so that I do not end up in a session where every tool call fails in a confusing way.
4. As a user, I want a "Clone repository" action in place of the composer, pre-filled with the remote URL the server believes is right, so that restoring a repo is one tap.
5. As a user, I want the pre-filled URL to be EDITABLE (and to be able to paste my own), so that repos the server cannot guess (a fork, another owner, a non-default host) are still restorable from the phone.
6. As a user, I want the clone to include submodules BY DEFAULT, so that a restored repo is actually complete and I do not discover empty submodule dirs later.
7. As a user, I want a progress bar during the clone that names the phase it is in (counting, receiving, resolving deltas, a specific submodule), so that a multi-minute clone does not look frozen.
8. As a user, I want the progress display to be honest about what it cannot know: a per-phase percentage, plus an explicit indeterminate state for phases git reports no percentage for, and a clear statement that submodules are counted separately rather than folded into one fake global percentage.
9. As a user on a phone, I want the clone to KEEP RUNNING when my screen locks, my socket drops, or I switch apps, and to see the live progress again when I come back, so that a long clone is not lost to a flaky mobile connection.
10. As a user with two devices or two tabs open on the same session, I want both to show the same running clone, and a second "Clone" tap to join the running job rather than start a second clone into the same path, so that the restore is never raced or duplicated.
11. As a user, I want to CANCEL a running clone, and I want the partially-cloned directory cleaned up if the server created it, so that a wrong URL or a wrong-network start is recoverable without a terminal.
12. As a user, when the clone FAILS (no SSH key on this machine, no network, repo does not exist, host key not trusted), I want the failure surfaced in the panel with git's actual error text AND with the common causes NAMED, so that I can tell "wrong URL" apart from "this machine has no credentials" without reading raw git output on a phone screen.
13. As a user, I never want a clone to hang forever waiting on an invisible interactive credential or host-key prompt, so a clone that would prompt must fail fast with that reason instead of sitting at zero percent.
14. As a user, when the restore succeeds I want the panel to tell me the folder is ready and offer a Reload button that brings the session back live, so that the transition is explicit and I know what state I am in.
15. As a user creating a NEW session in a folder that does not exist yet, I want the same progress-bar clone experience, and I want the session to be created automatically once the clone finishes, so that the new-session path is not the one place that still blocks and times out.
16. As a user, I want "Create folder" as the second remedy, with a git-init checkbox defaulted from my `gitInitDefault` config, so that a genuinely-new folder is also restorable without a terminal.
17. As a user browsing my session list on a fresh machine, I want folders that do not exist locally to be visibly marked, so that I can see the scale of what still needs restoring without opening each conversation.
18. As a user, I want the missing-folder lock to be a HARD state I cannot dismiss (unlike the folder-conflict warning's "Continue anyway"), so that I cannot accidentally drive an agent at a directory that is not there.
19. As a user whose folder matches a `sessions.readOnly` rule, I want that rule to keep winning after a restore, so that restoring a folder never quietly grants me write access I had configured away.
20. As a user, I want a folder that reappears by other means (I cloned it myself in a terminal, an external mount came back) to just work on the next load, so that the feature adds a remedy without adding a new gate.
21. As a maintainer, I want the clone to run through argv arrays with no shell, with the target path constrained to the home directory and the URL validated, so that a client-supplied URL cannot become command execution (the class of bug already fixed once in the remote-repo provisioning path).
22. As a maintainer, I want the existing create-session clone path to be re-pointed at the new job machinery rather than left as a second, divergent implementation, so that recursion, progress, and safety are fixed in one place.
23. As a maintainer, I want older clients (the VS Code companion, a stale browser cache) to degrade safely: they will not render the panel, but the server still refuses their sends, so a missing folder can never be driven by a client that does not understand the state.
24. As the machine owner, I accept that the server box is expected to be PROVISIONED already (an SSH key the host accepts, a known-hosts entry, an authenticated `gh` for the probe), and I want the feature to NAME precisely which of those is missing when a clone fails rather than trying to set any of them up, so that the fix is a one-line thing I do once on the box and never a hidden credential flow inside wherever.
25. As a user, I want cloning to use SSH remotes (`git@host:owner/repo.git`), not HTTPS, so that restored repos have the remote shape I actually push with and no token ever enters the picture.

> **Tasked.** The implementation and testing detail that seeded the tasking has moved into the tasks under `work/tasks/`
> (`folder-missing-read-only-state`, `restore-job-registry`, `restore-remote-candidates`, `restore-clone-panel`,
> `restore-create-folder-action`, `new-session-clone-via-registry`, `missing-folder-badge-in-session-list`), and the durable
> rationale into `docs/adr/0009-restore-jobs-are-server-owned-and-keyed-by-target-path.md` and
> `docs/adr/0010-restore-clones-over-ssh-only-and-names-the-missing-credential.md`.

## Out of Scope

- **Folder exists but is the WRONG thing** (wrong repo, detached branch, dirty tree, missing remote). Only nonexistence is detected; a mismatched folder is a different feature.
- **Credential setup from the UI** (generating or uploading an SSH key, running a provider login). A clone that fails for credentials reports that clearly and stops there.
- **Non-git restore sources**: backups, rsync, archives, mounting an external drive.
- **Bulk restore** ("clone all missing folders in my session list"). The badge from story 17 makes this obvious as a follow-up; it is deliberately not built here, and belongs in `work/notes/ideas/` if wanted.
- **Restoring anything other than the working folder**: pi agent state, ignored build outputs, `.env` files and other untracked local files are not recoverable by cloning and are not addressed.
- **Worktrees and non-default checkouts** (a specific branch, tag, or depth). The clone is a plain recursive clone of the default branch, so a conversation that happened on some other commit is restored at the default branch head, not at the state it was written against.
- **A folder that disappears UNDER a live session** (an unmounted drive, a `rm -rf` while the agent is attached). Detection is LOAD-TIME only, by deliberate choice: watching every live session's cwd is a different mechanism with its own cost, and the load-time check already covers the migration case that motivates this work. The existing failure mode for a mid-session disappearance is unchanged.
- **HTTPS or token-based clone transports.** SSH only (story 25); the box is expected to be provisioned, and a missing credential is reported, never worked around.

## Further Notes

- The immediate motivating case: a machine migration where transcripts arrived via syncthing and none of the clones did, with a remote-repo rule covering only the user's own GitHub namespace, which is precisely why the path-convention candidate is load-bearing rather than a nicety.
- The owner's launch decisions, recorded so they are not re-litigated: SSH-only transport with the credential gap NAMED rather than worked around (ADR 0010); server-owned, path-keyed restore jobs (ADR 0009); a reload to go live on the loaded-session path, but automatic continuation on the new-session path, which has nothing to reload; honest per-phase progress with submodules scoped separately rather than a single fake percentage.
- The term "restore" is already used in this codebase for re-materialising queued steers and drafts after a reload. The new frames are namespaced, but whatever wording lands should be pinned in `CONTEXT.md` so the next author does not fork the term a third time.
