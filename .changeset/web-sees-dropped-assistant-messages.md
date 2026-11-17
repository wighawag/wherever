---
"wherever-dev": patch
---

Messages dropped from the assistant session are now shown in the web, not only on channels. When a stop or a reset of the assistant session discards queued messages, every web viewer of that session (the retired one, on a reset) gets a notice listing the dropped web messages ("Stopped before it read ..." / "The assistant was reset before it read ..."), and the queued-steer badge and Cancel button clear as before. Messages a scheduled job had queued are logged rather than dropped silently; Telegram messages are still reported on Telegram only. Nothing changes for sessions outside the assistant folder, or with `assistantFolder` unset.
