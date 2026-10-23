---
title: Client: resumable chunked uploads with acked progress, resume after rejoin, and legacy fallback
slug: chunked-upload-client-state-machine
spec: resumable-chunked-uploads
blockedBy: [chunked-upload-server-protocol, server-reaper-tolerates-a-missed-pong, client-hydration-seam-and-server-key]
covers: [2, 6, 7, 13]
---

## What to build

The `@wherever-dev/client` side of chunked uploads:

- **Byte-source seam.** The package is platform-neutral (no `File`/`Blob`): `{ size, read(offset, len): Promise<Uint8Array> }`, implemented by the web over `File.slice().arrayBuffer()`. A `NotReadableError` from `read` fails the upload with "The file is no longer readable, pick it again".
- **State machine** per upload: `queued → sending → paused → finishing → done | failed | aborted`, exposed as a store keyed by `uploadId` (`{ acked, size, state, error }`). `uploadId` is ≥128 random bits (`crypto.getRandomValues`), URL-safe.
- **Pacing.** Window by BYTES in flight, about 2 s worth at the throughput measured from acks (64 KiB to 1 MiB). Chunk size `min(window, 256 KiB)`. Progress comes from acks, never from sends.
- **Resume.** On disconnect the upload pauses. After the rejoin's `session_created` (the existing `uploadsHeldForRejoin` release), it re-issues `upload_begin` for uploads aimed at that session, resumes from the returned offset, or resolves directly on `done: true`. Uploads for another session fail with "session changed" (existing behaviour).
- **Capability.** The protocol is chosen when the upload is SENT, from the current socket's `connected.capabilities`. Without `upload.v1`, fall back to the legacy base64 `file_upload`, keeping its guards (the 72 MiB refusal, the `MAX_UPLOAD_SENDS` cap). A paused chunked upload that reconnects to a server without the capability fails with "server no longer supports resumable uploads, retry".
- **Cancel.** The existing `AbortSignal` sends `upload_abort` for an in-flight chunked upload.
- **The 72 MiB cap moves to send time and applies to the LEGACY path only.** Today the web rejects files over `MAX_WS_UPLOAD_FILE_BYTES` and base64-encodes the whole file (`uploadFileViaWebSocket` in `web/src/lib/wherever.ts`) BEFORE the client chooses a protocol; left as is, chunked uploads would stay capped and fully loaded in memory. The web now passes a byte source; on a legacy fallback the client refuses `size > 72 MiB` from the byte source's `size` BEFORE reading (so a huge video never crashes the tab against an old server), then reads, base64-encodes (platform-neutral, e.g. `btoa` over chunks, each chunk a multiple of 3 bytes so no `=` padding appears mid-stream) and keeps the `MAX_UPLOAD_BASE64_CHARS` check as a backstop.
- **Capabilities.** The client records the current socket's `connected.capabilities` (it ignores `capabilities` today). An upload whose socket's capabilities are not yet known is HELD, never sent as legacy by default.
- **Bounds.** `MAX_UPLOAD_SENDS` is legacy-only. A paused chunked upload keeps the existing waiting clock (`UPLOAD_TIMEOUT_MS`, 10 min of waiting, not transmitting).
- `uploadFile()` in `web/src/lib/wherever.ts` keeps its promise + `AbortSignal` signature and gains `onProgress({acked, size, state, error?})`, the SAME shape as the store entry. That callback is the web's single source of chip state, so `uploadFile` calls it on EVERY path: chunked as above; legacy WS `queued` → `sending` (acked 0) → `paused` when its socket is lost → `done` / `failed`; POST (until `post-upload-progress-and-gate` adds real progress) `sending` (acked 0) → `done` / `failed`. `error` is `{ message, code? }`, with `code: 'not_readable'` for the "pick it again" failure so the UI never matches on text. A cancel through the `AbortSignal` reports `state: 'aborted'` on every path (chunked, legacy WS, POST).

## Acceptance criteria

- [ ] A file is uploaded in chunks; progress reflects acked bytes only.
- [ ] A drop mid-upload pauses it; after reconnect and rejoin it resumes from the server offset, and acked bytes are never re-sent.
- [ ] An offset mismatch realigns; `done: true` on begin resolves without re-sending.
- [ ] Cancel sends `upload_abort`; `NotReadableError` gives the 'pick it again' failure.
- [ ] Without `upload.v1` it falls back to the legacy frame with the existing guards; a downgrade mid-upload fails with the retry message.
- [ ] Client tests (vitest, `client/test/harness.ts` extended to record binary frames) cover each case. The existing legacy upload tests (`client/test/upload-survives-reconnect.test.ts`) are adapted MECHANICALLY and keep every behaviour they assert: after each `open()`, deliver a `connected` frame without `upload.v1` (otherwise uploads are held for unknown capabilities); pass a byte source instead of a base64 string; await the async read before checking sent frames; and change the size-cap test to check the byte source's `size > 72 MiB` (the `MAX_UPLOAD_BASE64_CHARS` backstop keeps its own case, driven by a byte source whose `read` returns more bytes than its `size`).

## Blocked by

- `chunked-upload-server-protocol`
- `server-reaper-tolerates-a-missed-pong`
- `client-hydration-seam-and-server-key`

## Prompt

> Goal: implement the client half of `work/specs/tasked/resumable-chunked-uploads.md` (rationale: ADR 0012) in `client/src/client.ts`, building on the existing pending-upload machinery (`pendingUploads`, `uploadsHeldForRejoin`, `uploadsLostSocket`, `abandonUnsentUploads`, `MAX_UPLOAD_SENDS`, `MAX_UPLOAD_BASE64_CHARS`; see CONTEXT.md "File Upload"). The server protocol is defined by the completed `chunked-upload-server-protocol` task: read its done record and `docs/USAGE.md` for the exact frames.
>
> The fake socket in `client/test/harness.ts` JSON-parses everything it is sent; extend it to record binary frames separately. Wire the web side minimally (the byte source over `File`, `onProgress` plumbing in `uploadFile`); the chip UI belongs to `upload-chip-progress-pause-cancel-retry`. Done = all acceptance cases tested.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim chunked-upload-client-state-machine --arbiter origin
git fetch origin && git switch -c work/chunked-upload-client-state-machine origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/chunked-upload-client-state-machine.md work/tasks/done/chunked-upload-client-state-machine.md
```
