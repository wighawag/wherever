---
"wherever-dev": patch
---

POST uploads (`uploads.method: 'post'`) now show real progress on the attachment chip (the web client uses XMLHttpRequest instead of `fetch`), report a cancel as cancelled and show the server's reason on a refusal. `POST /session/upload` now writes into the session's own upload dir even while its agent is still building (it used to fall back to tmp), answers 404 for an unknown session, refuses a read-only, missing or being-restored folder (403), and enforces `uploads.maxBytes` (413), removing any partial file.
