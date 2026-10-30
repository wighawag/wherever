---
"@wherever-dev/pi": minor
---

The bridge now tells the server more and can ask it things. `cli_register` carries `isNew` (true only on the first register of a session that had no messages when it started, so a fresh `pi` in the assistant folder becomes the current assistant session) and a `capabilities` list. The extension forwards `agent_settled` to the server (it still beeps as before). A new request/response path (`cli_request` / `cli_response`, correlated by id, with an unref'd timeout so `pi -p` exits as fast as before) lets the extension call the server; it asks `assistant_info` once after each register and caches the answer, including negative ones (not configured, older server, disconnected, disabled), and updates it on an `assistant_info_changed` push. Against an older server nothing changes.
