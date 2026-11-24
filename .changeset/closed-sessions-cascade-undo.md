---
"wherever-dev": minor
---

Closing a session that owns spawned sessions now asks "Also close the N sessions it owns?" (default yes, N counted by the server across folders and through children's children) and closes the whole owned subtree as one batch. After any close, a "Closed X (and N owned). Undo" banner appears at the top of the sidebar; Undo reopens the whole batch and restores any star the close removed. Server side, `POST /sessions/close` accepts `cascade: true` and `{batch, closed: false}`, and the new `GET /sessions/owned` answers the sessions a cascade would close.
