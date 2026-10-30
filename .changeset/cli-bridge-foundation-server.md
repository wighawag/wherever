---
"wherever-dev": minor
---

The server side of the richer CLI bridge. A `cli_register` with `isNew: true` fires the session-created callback, so starting a fresh terminal `pi` in `assistantFolder` makes it the current assistant session (`pi -c`, reconnects and older extensions do not). The extension's `capabilities` are recorded per CLI session. A new `cli_request` / `cli_response` path answers requests from a registered bridge, resolving the caller from its registration; its first op, `assistant_info`, reports the active assistant folder (or that the assistant is not configured), and unknown ops answer an error. A forwarded `agent_settled` reaches the pool's event fan-out without sending anything to the web. With `assistantFolder` unset nothing is written.
