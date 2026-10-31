---
"@wherever-dev/pi": minor
---

A terminal `pi` attached to wherever now has the assistant's five tools (`assistant_schedule_add`, `assistant_schedule_list`, `assistant_schedule_remove`, `assistant_set_timezone`, `assistant_notify`). They are registered inactive and only become active once the server says its assistant is configured (and are removed again if it says otherwise), so a session whose wherever has no assistant, a disabled bridge or no reachable server keeps exactly the tools and system prompt it had before. Each call goes to the server over the bridge and returns its result, or a clear error when the bridge is disconnected or disabled, the server is too old, or the assistant is not configured. In the assistant folder (and its `jobs/`), every turn's system prompt gets `User's current timezone: <tz>` from the cached assistant info, without waiting on the network.
