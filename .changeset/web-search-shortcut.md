---
"wherever-dev": patch
"@wherever-dev/client": patch
---

Chat top bar: 🔍 Search the web is back as a button (it had moved into the ⋯ menu), and it now shows while a session is still loading too, not only once it has loaded. Conversation search (searching what was said in past sessions) gets a 🕘 icon in the sidebar tab, its links and its panel, so the magnifier only means web search.

Leaving a session that is still loading now really stops it. The client sends `session_leave` even before `session_created` (it has no session id yet), and the server stops any load still reading the session when a leave or a newer load arrives (a per-socket load generation). Before, such a load finished anyway and attached the tab as a hidden viewer of the session it had left, so that session's agent events could reach the search screen.
