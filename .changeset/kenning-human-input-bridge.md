---
"@wherever-dev/pi": minor
---

When the wherever server relays a message a human typed (in the web dashboard or on Telegram) into a terminal session, the bridge now emits `kenning:human-input` `{text, channel}` on the session's event bus right before sending it, so kenning-pi records the turn as the human's own words. The server asks for it with a new `humanInput` field on `cli_message`; messages from scheduled jobs carry no such field and are never marked.
