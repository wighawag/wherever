---
"wherever-dev": patch
"@wherever-dev/client": patch
---

Mobile resilience fixes for loading sessions, reconnecting and uploading files:

- Opening a session no longer flashes "New Session Started" while its history is still arriving. A "Loading conversation..." spinner is shown until the history lands.
- While disconnected or resyncing, the composer stays editable: you can keep reading, typing and attaching. Only sending (Send/Steer, Enter, dictation auto-send) waits for the connection and the resync.
- A WebSocket file upload is no longer tied to the socket it started on. If the socket drops (e.g. the file picker or camera backgrounds the page on mobile), the upload waits and is sent again automatically once the session has rejoined (after the server re-applies its read-only verdict). The chip shows "waiting for connection" in the meantime. Uploads always settle: they used to hang forever, leaving Send disabled. They now complete, fail, or time out after 10 minutes of waiting for a connection (time spent actually transferring does not count).
- Removing an attachment chip cancels its pending upload, and no longer updates the wrong chip.
- Uploads that waited for an unreachable server now time out after 10 minutes as intended (the clock used to restart on every reconnect attempt). An upload whose connection drops during the transfer on 3 consecutive attempts now fails with a clear message instead of retrying forever, and files too large for a single WebSocket frame (over 72 MB) are refused before being read.
