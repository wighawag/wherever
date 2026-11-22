---
"wherever-dev": patch
---

Answering a kenning question from the web inbox or Telegram now reaches a session that is waiting for you even when nobody types into it. With kenning 0.1.0, a session that asked a non-blocking question and then declared it was waiting for you kept the answer pending until you also sent it a message. wherever now requires kenning 0.1.1, which wakes such a session for your answer (install `npm:kenning-pi@0.1.1` in your pi settings).
