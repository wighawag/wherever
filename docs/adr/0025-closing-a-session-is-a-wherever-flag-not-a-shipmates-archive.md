# Closing a session is a wherever flag, not a shipmates archive

"Close" (hide a finished session from the sidebar and from search, without deleting it) is stored in wherever's own `<state dir>/closed-sessions.json`, written by one module like the starred-sessions store. It is not stored as shipmates' archive marker (`archive(..., {kind: 'archived'})`, shipmates D24), even though that marker already cascades through ownership and has an undo. We chose this for three reasons. Close must work without shipmates (plain sessions, shipmates off). shipmates' archive also means "archived headless children are never woken", which contradicts the rule that any new activity reopens a closed session. And the archive's 7-day undo window and `expiredArchives()` were designed around delete. shipmates' ownership record is still what a cascading close walks.

## Consequences

- **Closed sessions reopen themselves.** Any agent activity reopens a closed session, and so does a new inbox item created after the close. This guarantees that nothing that needs the human can hide behind "closed".
- **The closed list never sheds old entries.** Unlike stars, the store never drops an old entry to stay under its cap, because dropping one would silently reopen that session. Only entries whose transcript no longer exists are pruned.
- **Close and star are exclusive.** Closing a session removes its star, and the close records that it did, so undo can restore the star. Starring a closed session reopens it.
- **Retention ignores the flag.** Closed sessions are not retention-exempt the way starred ones are.
- **The listing still returns closed sessions.** `/sessions` always includes them, and the client hides them. This keeps the Live strip able to show a closed session that is working.
