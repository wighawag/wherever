---
title: Resumable, chunked file uploads with progress (binary over the existing WebSocket)
slug: resumable-chunked-uploads
taskedAfter: [ws-liveness-hardening]
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

> Tasked. The implementation and testing detail moved into the tasks in `work/tasks/` (`spec: resumable-chunked-uploads`), and the durable rationale into `docs/adr/0012-uploads-are-resumable-binary-chunks-over-the-websocket-bound-to-the-painted-session.md`.

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

- `humanOnly` and `needsAnswers` are omitted. The defaults chosen at tasking (e.g. `uploads.maxBytes` = 1 GiB) are pinned in the tasks.

## Out of Scope

- **Surviving a full page kill.** If the OS kills the PWA mid-upload, the `File` is gone. Resuming across a reload would need the bytes copied into IndexedDB at pick time. Possible follow-up.
- Background upload while the app is closed (Background Fetch: Chromium-only, needs a trusted cert and a service worker, can't use the WS). A native shell is the real answer.
- Client-side image downscaling before upload.
- Resumable POST (tus-style).
