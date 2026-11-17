---
"wherever-dev": patch
---

A server whose assistant is configured but not active (the folder lock is held by another server, or could not be taken) no longer registers the `assistant_schedule_add`, `assistant_schedule_list`, `assistant_schedule_remove` and `assistant_set_timezone` tools in its sessions, and adds no timezone line: its sessions are exactly as with `assistantFolder` unset, like `assistant_notify` already was. The CLI tool-twin ops still answer the lock-state error on such a server. In the boot window before the scheduler starts, the tools on an active server now answer "still starting" instead of a misleading lock-state message.
