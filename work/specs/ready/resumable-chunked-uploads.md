---
title: Resumable, chunked file uploads with progress (binary over the existing WebSocket)
slug: resumable-chunked-uploads
taskedAfter: [ws-liveness-hardening]
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Problem Statement

Attaching a file from a phone is fragile and opaque:

- **No progress.** The whole file goes out as ONE base64 JSON frame (`file_upload`), so the composer chip shows a spinner and nothing else. A 6 MB camera photo on a slow uplink looks identical to a hung upload.
- **All-or-nothing.** If the connection drops mid-upload (internet cut, app switch, the file picker itself backgrounding the page), everything sent so far is lost. The interim fix re-sends the WHOLE file after the reconnect's rejoin. On a flaky link that can loop, and a re-send after a lost reply leaves an orphan duplicate in the upload dir.
- **The upload itself can kill the socket.** A single multi-MB frame occupies the TCP stream, so the browser's heartbeat pong is queued behind it. The server reaper (30 s ping, terminate after one missed pong; being fixed in `ws-liveness-hardening`) can terminate the socket mid-upload.
- **Overhead and limits.** Base64 adds 33% on the wire, plus a full in-memory encode/`JSON.parse` on both ends (`docs/mobile-upload-optimization.md`). `ws`'s default `maxPayload` (100 MiB) closes the socket with 1009 for files over ~72 MiB (the client now refuses those up front: `MAX_UPLOAD_BASE64_CHARS`).
- **Write-gate gaps (existing).**
  - The `file_upload` gate checks the socket's `client.readOnly`, i.e. the verdict for the session the socket is attached to, but writes into `msg.sessionId`'s folder. A client on a writable session A can therefore upload into a read-only session B's folder.
  - `POST /session/upload` has no read-only gate at all.

## Solution

Uploads become a small resumable protocol over the EXISTING, already-trusted WebSocket. POST stays an option, but mobile browsers block it against self-signed certs, which is why WS is the default.

- The file is sent as **raw binary chunks** (no base64), each small enough that heartbeat frames interleave between them.
- The server **acknowledges the byte offset** it has written. The chip shows **real progress** (acked bytes / size).
- On disconnect the upload **pauses**. After reconnecting and rejoining its session, the client asks the server how far it got and **continues from that offset**. Nothing already acknowledged is re-sent, and there are no duplicates, even across a server restart.
- The user can **cancel** an upload and **retry** a failed one from the chip.

## User Stories

1. As a phone user, I want a progress bar / percentage on each attachment chip, so that I can tell a slow upload from a stuck one.
2. As a phone user, I want an upload interrupted by a connection loss to continue where it stopped once I am back online, so that I do not re-upload a large file.
3. As a phone user, I want the chip to say it is paused / waiting for connection while offline, so that I don't think it failed.
4. As a phone user, I want to cancel an in-progress upload from its chip, so that a wrongly picked large file stops using my data.
5. As a phone user, I want a failed upload to show the reason and offer Retry, so that I don't have to pick the file again.
6. As a phone user whose picked file became unreadable after backgrounding (iOS/Android can invalidate it), I want a clear "pick the file again" message instead of a generic failure.
7. As a user, I want large uploads NOT to drop my connection, so that attaching a video doesn't also freeze the live conversation.
8. As a user, I want Send to stay disabled until every attachment has finished (as today), and to see which one is still in flight.
9. As a maintainer, I want an upload to never produce a duplicate file, even when a completion reply is lost with a socket or the server restarts between finish and reply.
10. As a maintainer, I want abandoned partial uploads garbage-collected, and partial files never downloadable.
11. As a maintainer, I want upload writes allowed only into the session this socket is attached to, under that session's read-only / folder-missing / conflict verdict, on every frame.
12. As an operator, I want one configurable maximum upload size enforced on EVERY upload path (chunked, legacy `file_upload`, POST), so that it cannot be bypassed.
13. As a maintainer, I want older clients (base64 `file_upload`) to keep working against a new server, and a new client to fall back cleanly against an old server.
14. As a user of `uploads.method: 'post'`, I want at least a progress indicator there too (XHR `upload.onprogress`), even if resume is WS-only.

### Autonomy notes

- `humanOnly` and `needsAnswers` are omitted. The defaults chosen below are listed so a reviewer can overturn them before tasking.

## Implementation Decisions

> Seed for tasking; trimmed once tasked.

**Capability negotiation.** If a paused chunked upload reconnects to a server whose `connected` frame lacks `upload.v1` (a downgrade), it fails with "server no longer supports resumable uploads, retry", and Retry restarts it from zero via the legacy frame. The server advertises `capabilities: ['upload.v1']` on the `connected` frame. The client uses the chunked protocol only when it is present, and otherwise falls back to the legacy base64 `file_upload`. The protocol is chosen when the upload is SENT (after `connected` on the current socket), not when `uploadFile()` is called: an upload picked while offline does not know the capability yet. No version comparison: dev builds make that fragile. A new client never sends binary frames to an old server, which would `JSON.parse` them and answer with `session_error`.

**Write gate (all upload frames, including legacy `file_upload`). DECIDED.**

The server records what a socket last LOADED, not only what it is attached to. In the cold path, `session_created` (the paint) goes out seconds before `switchClientSession` runs (only after `pool.loadSession`). After an idle eviction every resumed upload therefore lands in that window, and `pool.getSession(msg.sessionId)` is null there, which today silently sends the file to tmp even with `uploads.type: 'session'`.

- At paint time (`session_load`'s `session_created`, and `session_new`'s), set `client.paintedSessionFile`, `client.paintedSessionId` and `client.paintedCwd` from the meta. These are distinct from `pendingCwd`, which is a folder that two sessions can share.
- **Where they are cleared (exactly):**
  - UNCONDITIONALLY in `session_leave`. Today that handler acts only `if (client.sessionId)`, which a leave during the cold window does not satisfy; leaving the painted fields set there would let the late-cold-attach guard pass and re-attach a session the user left.
  - At the start of `session_new` (and overwritten by every new paint).
  - NEVER inside `switchClientSession(null)`: the folder-missing branch calls it right after the paint, and clearing there would drop the binding so the read-only refusal loses its reason.
- An upload frame is accepted only if `msg.sessionId` equals `client.paintedSessionId` (or resolves to `client.sessionId`, the attached file), AND `client.readOnly` is false. `readOnly` is already set to the paint-time verdict (`forcedReadOnly`) before `session_created` is sent, including `true` for a folder-missing load that never attaches, so refusals come with a reason.
- `targetDir` comes from `client.paintedCwd` (the session's real cwd), never from `pool.getSession()`. This also fixes today's tmp fallback in the cold window.
- Checked on begin, on every chunk, and on finish, because the verdict can flip mid-upload.
- **Fix the late cold attach while here.** When the cold build finishes, proceed only if `client.paintedSessionFile === meta.sessionFile`. Otherwise the user has loaded something else (or left) meanwhile: the build result just gets `scheduleIdleCheck`, and the WHOLE tail of the cold build is suppressed, i.e. the build's `session_error`, `addClient`/`switchClientSession`, the `readOnly` re-derivation, `session_ready`, the queue snapshot and the folder-conflict verdict. Today a slow A that finishes after a switch to B re-attaches the socket to A, and a stale A build failure shows its error on B and clears B's `agentPending`.
- **Client half.** Uploads are (re)issued only after the rejoin's `session_created`, and only those whose `sessionId` equals `msg.sessionId`; the rest fail with "session changed". Switching, creating or leaving a session fails every upload not yet on the wire. (Already the interim behaviour.)
- Waiting for `session_ready` instead was rejected: a folder-missing load never sends one, so uploads would hang.

**Protocol (client → server unless noted).**
- `upload_begin { uploadId, sessionId, filename, size, mime? }` → server `upload_offset { uploadId, offset, done?, savedPath? }`.
  - Idempotent: a known `uploadId` returns its current offset.
  - A FINISHED id returns `{ offset: size, done: true, savedPath }`. This is what a client that reconnects in the `finishing` state receives, so completion survives a lost reply and a server restart.
  - `uploadId` must match `^[A-Za-z0-9_-]{22,64}$`: it becomes a filename. The client generates ≥128 random bits (e.g. `crypto.getRandomValues`). The current `generateId()` is not enough.
  - `size` is checked against `uploads.maxBytes` before anything is written.
  - A known `uploadId` must belong to the same `sessionId` (from the sidecar). Otherwise it is refused, so `done: true` can never hand back another session's `savedPath`.
- **Binary chunk frame:** `[u8 kind=1 (upload chunk)][u8 version=1][u8 idLen][uploadId ascii][u64 offset BE][payload…]`.
  - The server routes binary frames (`ws.on('message', (data, isBinary))`) to the upload handler before any `JSON.parse`.
  - Chunk size is `min(current byte window, 256 KiB)`. The handler refuses chunks above a hard cap of 1 MiB.
  - Writes for one `uploadId` go through a **per-upload serial queue**, and the `offset === currentOffset` check happens inside it. A half-open old socket still flushing chunks while a new socket resumes therefore cannot interleave writes; a mismatch answers with the true offset and the client realigns.
  - Ack: `upload_offset { uploadId, offset }`. "Written" means written to the file, not fsynced.
- `upload_finish { uploadId }` → the server verifies `offset === size` and moves the file to its final name (see storage). It records `done` + `savedPath` in the sidecar and replies with the existing `file_uploaded`. A repeated finish returns the same `savedPath`.
- `upload_abort { uploadId }` deletes the partial. Errors use the existing `file_upload_error { uploadId, error }`.

**`maxPayload`.** Do NOT shrink it. The same server carries the legacy `file_upload` frame and the CLI bridge's `cli_event` frames (tool results with base64 images), and a small cap would close those sockets with 1009. Keep the default, or set a deliberately large explicit value. Chunk size is enforced by the upload handler, not by `maxPayload`.

**Storage.**
- Partials live in ONE server-owned staging dir, independent of any session cwd: `getWhereverStateDir()/upload-staging/<uploadId>` plus a JSON sidecar (`sessionId`, `filename`, `size`, `targetDir`, `createdAt`, `done?`, `savedPath?`). The staging dir is never a download root, and `resolveSafeDownloadPath` refuses it explicitly.
- `targetDir` is resolved ONCE at begin, via `resolveUploadDir` with the session's cwd, and recorded in the sidecar. A session unloaded between begin and finish therefore can't redirect the file to tmp.
- Finish: `rename`, falling back to copy + unlink on `EXDEV`. The final name keeps today's scheme (`<ts>_<basename>` in the resolved upload dir).
- GC: partial and done sidecars untouched for 24 h are removed on a timer and at startup. This works because there is only one staging dir to scan.

**Pacing.** Size the in-flight window by BYTES: about 2 s worth at the throughput measured from acks, from 64 KiB up to 1 MiB. A fixed 256 KiB × 4 window still queues ~128 s of data on a 8 KB/s uplink. Heartbeat starvation is otherwise handled by `ws-liveness-hardening` (any inbound frame counts as alive).

**Client (`@wherever-dev/client`, platform-neutral).**
- The package has no `File`/`Blob`. Define a byte-source seam `{ size, read(offset, len): Promise<Uint8Array> }`, implemented by the web over `File.slice().arrayBuffer()`.
- A `NotReadableError` from `read` marks the upload `failed` with "The file is no longer readable, pick it again".
- Per-upload state machine `queued → sending → paused → finishing → done | failed | aborted`, exposed as a store keyed by `uploadId` (`{ acked, size, state, error }`).
- On reconnect, after the rejoin `session_created`, the client re-issues `upload_begin` for non-terminal uploads and resumes from the returned offset (or resolves directly on `done`).
- `uploadFile()` in `web/src/lib/wherever.ts` keeps its promise + `AbortSignal` signature and gains `onProgress`.

**POST path.**
- Switch `fetch` to `XMLHttpRequest` for `upload.onprogress`.
- POST has no socket, so it cannot see per-viewer state (folder conflict / "Continue anyway"). The gate:
  - resolve the cwd from the pool when the session is loaded, else from the session file's header on disk (`pool.readSessionMeta`, the same cheap read `session_load` paints from, called with a minimal history limit or via a header-only variant: only `cwd`, `readOnly` and `folderMissing` are needed). The composer is editable while a cold agent builds, so refusing non-loaded sessions with 409 would hit POST users on a session they have open. Refuse with 404 only when the session cannot be resolved at all;
  - otherwise refuse when `pool.isReadOnlyCwd(cwd)`, the folder is missing, or a restore job is running for it;
  - apply the same `uploads.maxBytes` check (via `Content-Length`, plus a running byte count).
- Documented limitation: POST cannot enforce the folder-conflict observe-only state.
- No resume over POST.

**Docs to update when this lands:** `docs/USAGE.md` (the WS `file_upload` / `file_uploaded` examples), `CONTEXT.md` (File Upload section), and retire/redirect `docs/mobile-upload-optimization.md`.

## Testing Decisions

> Seed for tasking; trimmed once tasked.

- **Client** (vitest + `client/test/harness.ts`, extended to record binary frames):
  - chunking and byte-window pacing;
  - progress comes from acks, not sends;
  - a drop pauses; resume happens only after the rejoin `session_created` and continues from the server offset (acked bytes are never re-sent);
  - an offset mismatch realigns;
  - a `done:true` begin resolves without re-sending;
  - cancel sends `upload_abort`;
  - `NotReadableError` gives the "pick again" failure;
  - falls back to legacy `file_upload` without the capability.
- **Server** (real `ws`):
  - begin/chunk/finish refused when `sessionId` is not the attached session, or the attached session is read-only, including a mid-upload flip;
  - invalid `uploadId` refused;
  - concurrent chunks from two sockets for one id serialise;
  - a resume after a socket close continues the same partial;
  - a finished id survives a simulated restart (the sidecar is reloaded);
  - `EXDEV` fallback;
  - max size enforced on chunked, legacy and POST;
  - GC of stale staging entries;
  - isolation: with `WHEREVER_STATE_DIR` set to a temp dir, the real `~/.wherever/upload-staging` is never touched;
  - a cold-window upload (idle-evicted session, before `session_ready`) is accepted and lands in the session's upload dir, not tmp;
  - an upload for a session other than the painted one is refused;
  - a late cold attach after a switch or a cold-window leave does not re-attach, and a stale build's `session_error` / `session_ready` is not sent;
  - a POST to a session whose agent is still building is accepted and lands in its upload dir;
  - `/session/download` refuses a staging path;
  - legacy `file_upload` still works;
  - a large `cli_event` frame still passes.

## Suggested slicing

- **1a. Server write gate** (small, independent, fixes live bugs): paint-time binding, `targetDir` from `paintedCwd`, the late-cold-attach guard, and `uploads.maxBytes` on the legacy `file_upload`.
- **1b. Server chunked protocol** (blockedBy 1a): staging dir + sidecar, begin/chunk/finish/abort, per-id serial writes, GC, download exclusion, capability.
- **2. Client** (blockedBy 1b and `ws-liveness-hardening`'s server task): byte-source seam, state machine, pacing, resume after rejoin, capability fallback at send time. Acceptance includes keeping the interim guards on the LEGACY fallback path (new client, old server): the 72 MiB size refusal (`MAX_UPLOAD_BASE64_CHARS`, checked on `file.size` before reading) and the `MAX_UPLOAD_SENDS` re-send cap, so a fallback upload can never loop.
- **3. Web** (blockedBy 2): chip progress / paused / cancel / retry / "pick again".
- **4. POST** (blockedBy 1a, which owns the shared gate helper): XHR progress, read-only gate, max size.
- **Cross-spec ordering:** tasks touching `client.ts` `onOpen` / `session_created` or `+page.svelte`'s visibility handlers (here, in `ws-liveness-hardening` and in `instant-resume-from-cached-conversation`) need explicit `blockedBy` links, so they don't run in parallel on the same code.

## Out of Scope

- **Surviving a full page kill.** If the OS kills the PWA mid-upload, the `File` is gone. Resuming across a reload would need the bytes copied into IndexedDB at pick time. Possible follow-up.
- Background upload while the app is closed (Background Fetch: Chromium-only, needs a trusted cert and a service worker, can't use the WS). A native shell is the real answer.
- Client-side image downscaling before upload.
- Resumable POST (tus-style).

## Further Notes

- Interim behaviour already in the tree:
  - a WS upload is parked while disconnected and sent again only after the rejoin's `session_created`;
  - a reconnect with no session to rejoin fails it;
  - it times out only while waiting (10 min), not while transmitting;
  - removing the chip cancels it;
  - the composer stays editable while disconnected.

  This spec replaces the whole-file re-send with true resume.
- Supersedes the single-frame "binary WebSocket" layout in `docs/mobile-upload-optimization.md`.
