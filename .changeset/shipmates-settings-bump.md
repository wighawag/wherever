---
"wherever-dev": patch
---

Depend on `shipmates` 0.4 and `@shipmates/pi` 0.5. Waking off and a declared `waiting-for-human` now survive a session being unloaded (shipmates D40) and are read from shipmates itself, for spawned children too. A session that declared it waits for the human keeps its amber "waiting for you" dot and Live strip row after wherever unloads it, even with no open inbox item.
