---
"wherever-dev": minor
---

shipmates 0.3.0 / @shipmates/pi 0.4.0 (shipmates D39): every open inbox item is now pushed to Web Push and Telegram once, not only blocking ones, saying "This blocks <role or folder> until you answer." or "answer when you can". When a pushed item is answered elsewhere (in the asking session, the web inbox, the shipmates CLI, a terminal) or withdrawn, its Telegram message loses its answer buttons and gets a "✅ Answered in ..." or "↩️ Withdrawn" reply, once (recorded in `shipmates-notified.json`). A Telegram reply or tap on an already closed question answers "Already answered in <channel>." (or "This question was withdrawn.") and delivers nothing. A web send consumed by a waiting `human_ask` (preflight `handled`) is confirmed as delivered, and the notice shipmates sends when a reply closes a session's items shows as a "Notice from shipmates" card.
