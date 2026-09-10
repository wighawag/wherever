---
'wherever-dev': patch
---

Gate file uploads behind the read-only verdict, honour tilde-written remote-repo rules at session-creation time, and fix the port race that made the server suite flake.

- **`file_upload` is now refused on a read-only session.** An upload writes a file to disk, so it is a write capability, but the handler never consulted `client.readOnly`: a client on an observe-only session could not send a message referencing an attachment yet could still drop the attachment itself into the upload directory. It is now refused for every read-only reason (a configured `sessions.readOnly` folder, an uncontinued folder conflict, a missing folder), and refused **out loud** with a `file_upload_error` rather than silently, for the same reason a refused message answers: a client only hides its composer when it agrees it is read-only, so a desync has to be visible instead of swallowed.
- **A `remoteRepoRules` pattern written as `~/dev/github/me/` now matches when the session is actually created.** Rule matching in `session-pool.ts` used a bare `new RegExp(pattern)` while the HTTP layer expanded a leading `~`, so a rule written the natural way matched in `/check-path` and `/check-remote-repo` — the checks the new-session dialog runs — but not at creation time, and the promised remote was silently skipped. It now goes through the shared `matchRemoteRepoRule`, which also treats an invalid pattern as a non-match rather than throwing.

Test-suite reliability (no production behaviour change):

- **Fixed the port TOCTOU race behind the suite's flakiness.** The two helpers that spawn a real server picked a port by binding to `0`, reading the assigned port, closing the socket, and only then spawning the child — leaving a window in which the port belonged to nobody and another concurrent spawn could be handed the same one. That produced two failures that looked unrelated but were one bug: a server that never bound (`server did not become healthy`), and, worse, a test whose requests reached **another test's** server and got a correct answer to the wrong question (a 401 where a 200 was expected, because that server had a different token). The second shape is why raising timeouts never fixed it — nothing was slow, the request went somewhere else. Port allocation now lives in one place (`server/test/free-port.ts`) and gives each vitest worker a disjoint band below the OS ephemeral range, tracking every port already issued, so two workers cannot collide by construction.
- **Bounded test concurrency** (`maxWorkers`), since most files boot a real server and vitest otherwise forked one worker per core, putting tens of processes in contention. The suite got *faster* as a result (~97s vs ~133–186s).
- **Removed two remaining timing assumptions**: the three heavy `session-transcript` cases assert memory, not elapsed time, but relied on the default 5s timeout while writing tens of MB, so they carry an explicit one; and the `conversation-mode-hint` lockstep test now freezes the clock instead of deep-equalling two independently stamped `Date.now()` values, which only passed when both landed in the same millisecond.

No API or protocol changes.
