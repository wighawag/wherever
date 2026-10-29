---
"wherever-dev": minor
---

Show which sessions have an agent currently working in the sidebar: a pulsing amber dot replaces the green "active" dot while a turn is running. `GET /sessions` now reports `isWorking: true` for mid-turn sessions, and a new `session_working` WebSocket broadcast (sent on `agent_start` / `agent_end`) lets the dashboard flip that one row in place without refetching the session list.
