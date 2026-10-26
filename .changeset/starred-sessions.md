---
"wherever-dev": minor
---

Star sessions to come back to them later. A ☆ button in the top bar (and on each session row in the sidebar) marks a session, and the ★ stays visible on its sidebar row. Typical use: a session hands a prompt off to a new session and waits on it; the new session takes the top of the list, so star the original to find it again. Stars are stored on the server (`starred-sessions.json` in the state dir) so they show on every device, are exempt from `sessions.maxAgeDays` / `sessions.maxSessions`, and are dropped when the session is deleted. New endpoint: `POST /sessions/star`.
