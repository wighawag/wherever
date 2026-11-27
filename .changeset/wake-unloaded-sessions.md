---
"wherever-dev": patch
---

shipmates: a session the server unloaded (idle eviction or restart) is loaded again when a message waits for it, not only the sessions wherever spawned. Previously a message sent to an evicted sidebar session sat undelivered until the user opened it, which then started a turn out of nowhere. The wake follows the rule the session's own delivery would have applied, captured as it leaves the pool (`<stateDir>/shipmates-unloaded.json`): never with waking off, only a human-origin message once it declared `waiting-for-human`, never a message already pending when it was unloaded or older than its last stop, and never a session open in another process. At most three loads run at once, and a failed load is retried after a minute.

With a shipmates that keeps per-session settings across an unload (its D40), waking off and a declared `waiting-for-human` are read from shipmates itself (spawned children included), and a session that declared it waits for the human keeps its amber "waiting for you" dot and Live strip row in the sidebar after wherever unloads it, even when it has no open inbox item. On an older shipmates nothing changes.
