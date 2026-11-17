---
"wherever-dev": minor
---

A retired assistant session is now read-only for web viewers and never blocks the current one (ADR 0020). After a reset (or a `/new` in the assistant folder), a tab still showing the old assistant session turns read-only live, with a notice that the assistant was reset and an "Open current session" button; "Continue anyway" does not lift it, and its sends are refused with a message naming the reset. The retired session no longer counts as an occupant of the assistant folder, so the new current session opens writable instead of behind the folder-conflict banner. Older assistant sessions opened from the session list are read-only the same way; sessions in `jobs/` are never retired, a terminal `pi -c` on a retired session is not blocked, and with `assistantFolder` unset nothing changes.
