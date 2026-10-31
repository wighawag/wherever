---
"wherever-dev": minor
---

The CLI bridge's `cli_request` path answers the five ops behind the terminal `pi` twins of the assistant tools: `schedule_add`, `schedule_list`, `schedule_remove`, `set_timezone` and `notify`. They run the same code as the server sessions' assistant tools, with the calling terminal session (resolved from its bridge registration) as the origin. With `assistantFolder` unset they answer "not configured", and with the folder lock held by another server the same lock-state error as the server tools.
