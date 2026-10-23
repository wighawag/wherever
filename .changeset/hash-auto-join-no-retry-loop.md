---
"wherever-dev": patch
---

Opening a link (or reloading a page) whose URL names a session that cannot be loaded, e.g. one that was deleted, no longer retries the load every 300 ms forever with a flickering error and a permanent "Loading session..." spinner. The load is tried once: on failure the error is shown, the URL fragment is cleared (without adding a history entry, so Back still works) and the home screen comes back.
