---
title: POST uploads get progress, the read-only gate and the size limit
slug: post-upload-progress-and-gate
spec: resumable-chunked-uploads
blockedBy: [chunked-upload-server-protocol, chunked-upload-client-state-machine, upload-chip-progress-pause-cancel-retry]
covers: [11, 12, 14]
---

## What to build

For `uploads.method: 'post'`:

- **Client:** `uploadFileViaPost` switches from `fetch` to `XMLHttpRequest` so `upload.onprogress` drives the same `onProgress` callback and chip progress. Abort via the existing `AbortSignal`. Keep the `onProgress` contract from `chunked-upload-client-state-machine`: `sending` with `acked` = `upload.onprogress`'s `loaded`, then `done`. A non-2xx reply reports `failed` with `error: {message}` set to the server's `error` text (as `res.json().error` does today), and the promise rejects with it. A `signal` abort calls `xhr.abort()`, and `onabort` reports `state: 'aborted'` and rejects. `onerror` reports `failed`. Unlike `fetch`, XHR does not settle on its own, so every path must settle the promise explicitly. No resume over POST.
- **Server (`POST /session/upload`):**
  - resolve the session's cwd from the pool when loaded, else from the session file's header on disk (`pool.readSessionMeta` with a minimal history limit, or a header-only variant: only `cwd`, `readOnly` and `folderMissing` are needed). The composer is editable while a cold agent builds, so refusing non-loaded sessions would hit users on a session they have open. Refuse with 404 only when the session cannot be resolved at all;
  - refuse when the folder matches `sessions.readOnly`, is missing, or a restore job is running for it;
  - enforce `uploads.maxBytes` (via `Content-Length` plus a running byte count); on a mid-stream refusal, destroy the write stream and unlink the partial file (asserted in the oversized test);
  - write into `resolveUploadDir` for the resolved cwd.
- Documented limitation: POST has no socket, so it cannot enforce the per-viewer folder-conflict observe-only state.

## Acceptance criteria

- [ ] POST uploads report progress through `onProgress`; a cancel reports `aborted`; a refusal shows the server's reason; every path settles the promise.
- [ ] A POST to a session whose agent is still building (not loaded) is accepted and lands in its upload dir.
- [ ] A POST into a read-only, missing-folder or restoring folder is refused; an unknown session gives 404; an oversized upload is refused.
- [ ] Server tests cover the gate cases; the client change is covered where testable (the progress mapping) and checked manually.
- [ ] Tests rely on the server test harness's isolation (`server/test/harness.ts` gives each run a temp config dir and blanks `WHEREVER_STATE_DIR`, so state falls back to it) and assert the AMBIENT state dir (whatever it would resolve to without the harness, e.g. `~/.wherever` or `/var/lib/wherever`) is untouched. Tests that write uploads set `uploads.type` to `'session'` or `'custom'` (a temp dir), never the default `'tmp'`, which would write into the real `os.tmpdir()`.

## Blocked by

- `chunked-upload-server-protocol` (both edit `server/src/index.ts`)
- `chunked-upload-client-state-machine` (introduces the `onProgress({acked, size, state, error?})` callback and edits `uploadFile`)
- `upload-chip-progress-pause-cancel-retry` (renders that callback; serialises `ChatInput` / `wherever.ts` edits)

## Prompt

> Goal: bring the HTTP upload path up to the WebSocket path's guarantees, as specified in this task file (rationale: ADR 0012). Server: the `POST /session/upload` handler in `server/src/index.ts`, `SessionPool.readSessionMeta` / `isReadOnlyCwd` in `server/src/session-pool.ts`, `restoreJobs`, `resolveUploadDir`, and the gate helper from `upload-write-gate-binds-to-painted-session` where reusable. Client: `uploadFileViaPost` / `uploadFile` in `web/src/lib/wherever.ts`.
>
> Note why mobile defaults to WebSocket (`docs/mobile-upload-optimization.md`: mobile browsers block POSTs against self-signed certs); this task does not change the default. Document the limitation in `CONTEXT.md`. Done = acceptance cases tested.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim post-upload-progress-and-gate --arbiter origin
git fetch origin && git switch -c work/post-upload-progress-and-gate origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/post-upload-progress-and-gate.md work/tasks/done/post-upload-progress-and-gate.md
```

## Decisions

These are recorded in comments where each choice is made; please link them from the done record.
1. **Meaning of progress over POST** (`web/src/lib/core/post-upload.ts`): progress is bytes the browser has sent, not bytes the server confirmed. The chip can therefore sit at 100% before `done` arrives.
2. **The file is streamed, not read into memory first** (same file). A file the phone can no longer read now shows up as a network error. To keep the "pick the file again" message, the client then tries to read one byte, and shows that message if it can't.
3. **Kept the `text/plain` content type** (same file), as the old `fetch` path sent.
4. **One 403 for all three folder refusals**, told apart by the reason text, plus 404 and 413 (`server/src/upload-gate.ts`, `gateUploadFolder`). This is user-visible, so you may want to confirm it.
5. **"Being restored" takes precedence over "missing"** when a folder is both (same JSDoc).
6. **Read only the session file's first line, not the existing history read with a tiny limit** (same JSDoc), because the history read scans the whole transcript of a cold session.

**Observation:** I left a note at `work/notes/observations/upload-test-payloads-leaked-into-os-tmpdir.md`. `/tmp` holds about eight old 31-byte `*_note.txt` files containing `file-upload-read-only.test.ts`'s payload; I haven't confirmed where they come from. Separately, the first (red) run of my new test wrote four files to `/tmp` before the fix; I deleted them.
