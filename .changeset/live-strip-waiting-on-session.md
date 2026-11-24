---
"wherever-dev": minor
---

The Live strip names the session a `waiting-for-session` session waits on ("waiting on <session>"), falling back to "waiting on a session". `shipmates_update` presence entries gain `waitingOnSession`: the waited-on session's normalized file, resolved on the server from the question the session waits for (its target session, or the current holder of its target role), null when it cannot be told or for any other state. A failed lookup never empties the inbox or presence, and a session missing from the current listing is never named.
