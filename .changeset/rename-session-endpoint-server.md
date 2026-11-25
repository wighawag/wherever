---
"wherever-dev": patch
---

Add `POST /sessions/name` to rename a session, written by whichever process owns its file (ADR 0027): the server's own agent for a session it runs, the terminal pi through a new `cli_rename` / `cli_rename_result` bridge exchange for a CLI-bridged session, or a `session_info` append for a session only on disk. A rename that cannot be done safely (an older terminal extension, a session with no message yet, a load or reload in progress) is refused with a clear message, and every dashboard relists on success. The web store gains `renameSession(sessionFile, name)` for the rename UI.
