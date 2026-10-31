---
"wherever-dev": minor
---

Talk to the assistant from Telegram. Once the bot is paired, your messages go to the current assistant session: an idle session starts a turn, and a message sent mid-turn steers it (shown by a ✍ reaction on your message, or a short "Added to the current reply" note when reactions are unavailable). Replies to your Telegram messages stream back as a draft (`sendMessageDraft`, falling back to a message edited in place) and are split below Telegram's 4096-character limit; output answering web, terminal or scheduled messages is never sent to Telegram. `stop` aborts the running turn, `/new` and `/reset` reset the assistant, `!` shell commands are refused with an explanation, and other `/` text (such as `/skill:`) is passed through untouched. `assistant_notify` arrives as its own `🔔 <source>: <title>` message, with a link to the session when `publicUrl` is configured, immediately even mid-reply. Messages dropped by a reset or a stop are listed back on Telegram.
