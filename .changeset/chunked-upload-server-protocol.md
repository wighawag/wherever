---
"wherever-dev": patch
---

Server: resumable, binary, chunked uploads over the existing WebSocket (`upload.v1`, advertised in `connected.capabilities`). `upload_begin` / binary chunk frames / `upload_finish` / `upload_abort`, acked with `upload_offset`, resumable from the server offset after a reconnect, serialised per upload id, idempotent across a lost reply or a server restart (a repeated finish returns the same `savedPath`), and gated on every frame by the painted-session write gate. Partials are staged under `<state dir>/upload-staging`, never downloadable, and garbage-collected after 24 h. The legacy base64 `file_upload` frame keeps working.
