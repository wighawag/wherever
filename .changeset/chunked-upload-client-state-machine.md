---
"wherever-dev": patch
"@wherever-dev/client": minor
---

Uploads over the WebSocket are now resumable and report real progress when the server supports it (`upload.v1`). The client sends the file as binary chunks, counts progress only from the server's acknowledgements, pauses on a dropped connection and, after the reconnect rejoins the session, continues from where the server got to instead of starting over. Cancelling an upload now tells the server to drop the partial file. Against an older server the client falls back to the previous single-frame upload, with the same limits as before (72 MB, three attempts). A file the phone can no longer read fails with "The file is no longer readable, pick it again".

Breaking for `@wherever-dev/client`: `uploadFileViaWebSocket(sessionId, filename, source, options)` now takes a byte source (`{size, read(offset, length)}`) instead of a base64 string, and gains `options.onProgress` and `options.mime`. The client also exposes `uploadsStore` (progress per upload id) and `forgetUpload(id)`. In the web app, `uploadFile()` accepts an `onProgress` callback that reports `{acked, size, state, error?}` for every upload method.
