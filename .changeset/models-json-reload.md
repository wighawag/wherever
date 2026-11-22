---
"wherever-dev": patch
---

The server re-reads models.json when it changes, so a model added to (or removed from) the file shows in the web picker and can start a session without restarting the server, which used to end every in-process session. An edit that fails to parse or validate is refused with a log line and the models already loaded are kept, instead of emptying the picker.
