---
"wherever-dev": minor
---

wherever is now a host for [kenning](https://github.com/wighawag/kenning), the sessions-that-know-about-each-other layer whose pi extension (kenning-pi) already runs in server sessions:

- **Human input is marked.** Before a web or Telegram message is sent into a session, the server emits `kenning:human-input` on that session's own event bus (server sessions through a per-session inline extension, CLI-bridge sessions through a new `humanInput` field on `cli_message`), so kenning records it as the human's words and another session can receive them as `human-relayed`. Scheduled jobs and anything an agent sends are never marked (ADR 0023). Server sends of `/`-prefixed text now report the `input` source `extension` instead of `interactive`, as CLI-bridge sessions already did, so a scheduled `/`-prompt no longer looks typed.
- **The attention inbox on the web.** A "Needs you" sidebar entry with a badge, a panel listing the questions sessions raised with `human_ask`, and a reply box that answers as the human (channel `web`). It is pushed live over the WebSocket (`kenning_update`, throttled like `sessions_updated`); a CLI bridge connection cannot answer.
- **Blocking questions reach you.** While the assistant's channels run, each blocking item is sent once through Web Push and Telegram, linking to the asking session; replying to that Telegram message answers it (channel `telegram`). Recorded in `<stateDir>/kenning-notified.json`, so a restart never repeats one.
- **Presence in the session list.** Each live session shows its kenning role, state and status line.

wherever never creates kenning's database: everything stays off until kenning-pi (or the kenning CLI) has made it, and `kenning.enabled: false` in config.json turns it off.

Requires kenning 0.1.0 (`npm:kenning-pi@0.1.0` in your pi settings for the sessions to use it).
