---
"wherever-dev": minor
---

wherever is now kenning's host for spawning and stopping sessions. When an agent calls kenning's `session_spawn`, the new session is a wherever session in the sidebar, shown under the session that spawned it (with links from the owner to its children, across folders); nothing is sent into it as if typed, and kenning wakes it with the owner's first prompt. `session_stop` aborts only that session's current run. wherever loads a spawned session again when a message waits for it after the pool let it go while idle. Deleting a session that spawned others now hides it and everything it owns as one batch, which you can undo for 7 days from the sidebar; the transcripts are removed only after that. Web and Telegram messages now also close their kenning human-input mark once the send settles, so a message another extension handled can never be taken for a later identical one.
