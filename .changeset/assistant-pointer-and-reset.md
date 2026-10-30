---
"wherever-dev": minor
---

Give the assistant a current session and a reset. With `assistantFolder` set, the server keeps a pointer to the CURRENT assistant session in its state dir (`assistant-session.json`), surviving restarts and idle eviction. The web gains an "Assistant" entry in the sidebar that opens the current session (creating one when there is none) and a Reset button on it; `/new` and `/reset` typed in the assistant session reset it too. A reset aborts the old session's running turn, clears and records its queued messages, and makes a fresh session in the folder current, even while another tab still views the old one. Sessions created in `jobs/` or elsewhere never move the pointer. `GET /config` reports the current session id. With `assistantFolder` unset nothing changes.
