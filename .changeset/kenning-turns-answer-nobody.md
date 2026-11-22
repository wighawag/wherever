---
"wherever-dev": patch
---

A turn that kenning starts in a session (a message from another session waking it, or arriving as it finishes) no longer replies to wherever the human last wrote from. Before, an assistant you last messaged on Telegram answered every report from a session it had spawned on Telegram. Those turns are now silent, like scheduled ones; a delivery that arrives together with your own message, or mid-answer, still replies to you. A turn that needs you uses `human_ask` (the inbox, pushed when blocking) or `assistant_notify`.
