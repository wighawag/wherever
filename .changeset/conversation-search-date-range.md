---
"wherever-dev": minor
---

Conversation search can now be bounded by date: a selector in the search panel (Any time, last 24 hours, last 7 days, last 30 days; default Any time, remembered on this device and shared by the main and read-only views) re-runs the current query at once. The bound is on when the matched message was said, not on the session's last activity, and relevance order is unchanged. `GET /search` gains `since` (an ISO date, normalized to UTC; absent or empty means no bound); an unparseable `since` answers `status: "error"` with a message. Entries with no timestamp are excluded whenever a range is set, and `sessions.ignore`, `sessions.readOnly`, closed sessions and memonaut `private` apply unchanged.
