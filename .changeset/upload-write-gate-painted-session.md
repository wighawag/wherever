---
"wherever-dev": patch
---

Uploads are now bound to the session the socket painted. A `file_upload` for any other session is refused with a reason. Before this, a client on a writable session could write into another session's folder. An upload made while a cold session's agent is still building now lands in that session's upload dir instead of falling back to tmp. A leave or switch during a cold load no longer lets the slow build re-attach the socket or send a stale `session_ready` / `session_error`. New config key `uploads.maxBytes` (default 1 GiB) refuses oversized uploads with a reason.
