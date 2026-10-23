---
title: Server: resumable chunked upload protocol (staging dir, begin/chunk/finish/abort, idempotent completion, GC)
slug: chunked-upload-server-protocol
spec: resumable-chunked-uploads
blockedBy: [upload-write-gate-binds-to-painted-session, server-reaper-tolerates-a-missed-pong]
covers: [9, 10, 11, 12, 13]
---

## What to build

The server side of resumable, binary, chunked uploads over the existing WebSocket. This task file is the full specification (the rationale is in ADR 0012):

- `connected` advertises `capabilities: ['upload.v1']`.
- `upload_begin { uploadId, sessionId, filename, size, mime? }` → `upload_offset { uploadId, offset, done?, savedPath? }`. Idempotent. A known id must match the sidecar's `sessionId`, `size` and `filename`; any mismatch is refused. A finished id returns `{ offset: size, done: true, savedPath }`. `uploadId` must match `^[A-Za-z0-9_-]{22,64}$`. `size` is checked against `uploads.maxBytes` first.
- Binary chunk frame `[u8 kind=1][u8 version=1][u8 idLen][uploadId ascii][u64 offset BE][payload]`, routed before any `JSON.parse` (`ws.on('message', (data, isBinary))`). Hard cap 1 MiB per chunk. Writes per `uploadId` go through a serial queue; the `offset === currentOffset` check happens inside it, otherwise reply with the true offset. Ack `upload_offset`.
- `upload_finish` → verify `offset === size`, rename into `targetDir` (copy + unlink fallback on `EXDEV`), record `done` + `savedPath` in the sidecar, reply with the existing `file_uploaded`. A repeated finish returns the same path.
- `upload_abort` deletes the partial. Errors use `file_upload_error`.
- Storage: `getWhereverStateDir()/upload-staging/<uploadId>` plus a JSON sidecar (`sessionId`, `filename`, `size`, `targetDir`, `createdAt`, `done?`, `savedPath?`); `targetDir` is resolved ONCE at begin from the painted cwd. The staging dir is never a download root and `resolveSafeDownloadPath` refuses it. Entries untouched for 24 h are GC'd on a timer and at startup.
- Every frame (begin, chunk, finish) passes the write gate from the previous task.
- Do NOT shrink `maxPayload`: the legacy frame and CLI-bridge `cli_event` frames still need it.

## Acceptance criteria

- [ ] begin/chunk/finish produce the file in the session's upload dir with the existing naming scheme.
- [ ] A resume after a socket close continues the same partial from the server offset; an offset mismatch returns the true offset.
- [ ] Concurrent chunks for one id from two sockets are serialised (no interleaved writes).
- [ ] A finished id survives a simulated server restart (sidecar reloaded) and a repeated finish returns the same `savedPath`; a known id with a different `sessionId` is refused.
- [ ] Invalid `uploadId`, oversized `size`, oversized chunk, and a gate refusal mid-upload are each refused with a reason.
- [ ] `EXDEV` fallback works (unit-test the staging module in-process with an injectable `rename`); GC removes stale staging entries; `/session/download` refuses a staging path.
- [ ] The restart case is tested by running a second harness with the SAME state dir (pass `WHEREVER_STATE_DIR` through the harness's `opts.env`). `harness.cleanup()` deletes the whole tmpRoot (the session file and its workspace), so either add a `stop()` to `Harness` that stops the server WITHOUT deleting tmpRoot, or start harness 2 before cleaning up harness 1. Harness 2 loads harness 1's absolute `sessionFile` (`readSessionMeta` accepts absolute paths) to repaint the session and pass the write gate. The shared state dir sits outside both tmpRoots and the test removes it.
- [ ] The legacy `file_upload` frame and a large `cli_event` frame still work.
- [ ] Tests rely on the server test harness's isolation (`server/test/harness.ts` gives each run a temp config dir and blanks `WHEREVER_STATE_DIR`, so state falls back to it) and assert the AMBIENT state dir (whatever it would resolve to without the harness, e.g. `~/.wherever` or `/var/lib/wherever`) is untouched. Tests that write uploads set `uploads.type` to `'session'` or `'custom'` (a temp dir), never the default `'tmp'`, which would write into the real `os.tmpdir()`. In particular the real `upload-staging` is never touched.

## Blocked by

- `upload-write-gate-binds-to-painted-session`
- `server-reaper-tolerates-a-missed-pong` (both edit the `ws.on('message')` handler and the `connected` frame: serialised to avoid conflicts)

## Prompt

> Goal: implement the server half of `work/specs/tasked/resumable-chunked-uploads.md` (rationale: ADR 0012) in `server/src/index.ts` (WS message routing, upload handlers), reusing the write-gate helper from `upload-write-gate-binds-to-painted-session`. Prefer a new module (e.g. `server/src/upload-staging.ts`) for staging, sidecars, the per-id serial queue and GC, so `index.ts` only routes. State dir: `getWhereverStateDir()` in `server/src/session-pool.ts` (see ADR 0006: config dir is read-only, state lives in a separate state dir). Downloads: `resolveDownloadRoots` / `resolveSafeDownloadPath`.
>
> Document the frames in `docs/USAGE.md` (next to the existing `file_upload` / `file_uploaded` examples) and in `CONTEXT.md`'s File Upload section. Done = every acceptance case has a server test and the old paths still pass their tests.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim chunked-upload-server-protocol --arbiter origin
git fetch origin && git switch -c work/chunked-upload-server-protocol origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/chunked-upload-server-protocol.md work/tasks/done/chunked-upload-server-protocol.md
```
