---
"wherever-dev": minor
---

Conversation search now leaves out closed sessions by default, on both the main and the read-only view. An "Include closed" checkbox in the search panel (remembered on this device) brings them back, dimmed and marked "Closed", and re-runs the current query at once. `GET /search` gains `includeClosed=1`, and each returned thread carries `closed`. A fork family with a closed member still shows its open threads, with `threadTotal` counting only the visible ones; `sessions.ignore`, `sessions.readOnly` and memonaut `private` are unchanged by the toggle.
