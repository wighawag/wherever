---
"wherever-dev": patch
"@wherever-dev/pi": patch
---

Fix `attach_file` downloads that 404ed when the file lived outside the session cwd (e.g. a PDF built in a sibling project). A successful `attach_file` call is now a download grant for exactly that file, read from the session transcript so it survives restarts and covers CLI-bridge sessions. `GET /session/download` also resolves sessions the server has not loaded (cwd + grants from disk). As a fallback, `attach_file` now errors with an actionable message when the server would refuse the download anyway (downloads disabled, or the file over `downloads.maxBytes`).
