---
title: Upload write gate binds to the session the socket painted (fixes cross-session writes, tmp fallback, late cold attach)
slug: upload-write-gate-binds-to-painted-session
spec: resumable-chunked-uploads
blockedBy: []
covers: [11, 12]
needsAnswers: false
---

## What to build

Server-side fix for live bugs in the existing base64 `file_upload` path, and the gate every later upload path reuses:

- **Paint-time binding.** When `session_load` (and `session_new`) sends `session_created`, record `client.paintedSessionFile`, `paintedSessionId` and `paintedCwd`. These are deliberately separate from the existing `client.pendingCwd` ("cwd painted but not yet attached"): `clearConflictState` clears `pendingCwd`, and `switchClientSession(null)` calls it, including in the folder-missing branch right after the paint. Add a JSDoc on the new fields saying so. Clear them at the START of `session_load` (before its first await, like `conflictContinued` is reset), UNCONDITIONALLY in `session_leave` (today's handler acts only `if (client.sessionId)`, which a leave during a cold load does not satisfy) and at the start of `session_new`. (Clearing at `session_load` matters: `joinSession` sends no leave, so a slow build for A finishing during B's `readSessionMeta` await would otherwise pass the guard.) NEVER clear them in `switchClientSession(null)`: the folder-missing branch calls it right after the paint.
- **The gate.** An upload is accepted only if `msg.sessionId` equals `paintedSessionId` (or resolves to the attached `client.sessionId`) AND `client.readOnly` is false. Otherwise refuse with `file_upload_error` and a reason. Today the gate checks the attached session's `readOnly` but writes into `msg.sessionId`'s folder, so a client on writable session A can upload into read-only session B's folder.
- **Target folder from `paintedCwd`.** Never from `pool.getSession()`, which is null while a cold session's agent builds, silently sending the file to tmp even with `uploads.type: 'session'`.
- **Late cold attach guard.** When the cold build finishes, proceed only if `client.paintedSessionFile === meta.sessionFile`. Otherwise suppress the whole tail (the build's `session_error`, attach, `readOnly` re-derivation, `session_ready`, queue snapshot, folder-conflict verdict) and just `scheduleIdleCheck`. Today a slow A that finishes after a switch to B re-attaches the socket to A, and a stale A build failure shows on B.
- **Max size.** New config key `uploads.maxBytes` (in the `uploads` config type next to `type`/`subDir`/`dir`), DEFAULT 1 GiB (`1024 * 1024 * 1024`). Downloads use 100 MiB, but phone videos easily exceed that; the default is a decision, documented in `CONTEXT.md`, and overridable. Enforced on the legacy `file_upload` frame (decoded size), refused with a reason. The chunked and POST paths reuse it.

Also extract the gate as a reusable helper: the chunked protocol and POST tasks call it.

## Acceptance criteria

- [ ] An upload for a session other than the painted/attached one is refused with a reason.
- [ ] During a cold load (after `session_created`, before `session_ready`), an upload is accepted and lands in the session's upload dir (not tmp) for `uploads.type: 'session'`. The test asserts `file_uploaded` arrives BEFORE `session_ready` (otherwise it passes without the fix); if the agent build is too fast for that to be reliable, add a deterministic lever (e.g. a test-only build delay via env) and use it here and in the late-attach test.
- [ ] A folder-missing or read-only session refuses uploads with a reason.
- [ ] A leave or switch during a cold load prevents the late attach, and no stale `session_error` / `session_ready` reaches the client.
- [ ] `uploads.maxBytes` refuses an oversized legacy upload.
- [ ] Server tests cover each case (extend the existing upload/read-only tests, e.g. `server/test/file-upload-read-only.test.ts`, which already use `idleTimeoutMs: 0` to force cold loads).
- [ ] Tests rely on the server test harness's isolation (`server/test/harness.ts` gives each run a temp config dir and blanks `WHEREVER_STATE_DIR`, so state falls back to it) and assert the AMBIENT state dir (whatever it would resolve to without the harness, e.g. `~/.wherever` or `/var/lib/wherever`) is untouched. Tests that write uploads set `uploads.type` to `'session'` or `'custom'` (a temp dir), never the default `'tmp'`, which would write into the real `os.tmpdir()`.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: fix the write gate of the WebSocket `file_upload` handler in `server/src/index.ts` and the cold-load attach race, as the foundation of the resumable-uploads work. This task file is the full specification; the rationale for binding to the PAINTED session is in ADR 0012 (`docs/adr/0012-*.md`). Read it first.
>
> Where to look: the `session_load` case (fast-first paint: `session_created` + `message_history` are sent BEFORE the cold `pool.loadSession` + `switchClientSession` in an async block; a folder-missing branch detaches and sets `readOnly = true`), `session_new`, `session_leave`, `file_upload`, `resolveUploadDir`, and the `WSClient` type. Config types live with `getWhereverConfig()`.
>
> Keep the client-side contract unchanged (`file_upload` / `file_uploaded` / `file_upload_error`). Done = the gate helper exists and is used by `file_upload`, the late-attach guard covers the whole tail, and every acceptance case is tested.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim upload-write-gate-binds-to-painted-session --arbiter origin
git fetch origin && git switch -c work/upload-write-gate-binds-to-painted-session origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/upload-write-gate-binds-to-painted-session.md work/tasks/done/upload-write-gate-binds-to-painted-session.md
```
