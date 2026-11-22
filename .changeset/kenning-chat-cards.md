---
"wherever-dev": minor
"@wherever-dev/client": minor
---

The chat now shows what kenning delivered into a session. A session woken by a message from another session, or a spawned session receiving its owner's first prompt, used to show the agent replying to nothing; each delivery is now a card with its sender, an origin badge (agent, human, human-relayed), its kind, the message text, "First prompt from <owner>" for a spawn, and the full text the agent read one click away. They appear in history and live (a new `kenning_delivery` frame), and are never user messages: no fork point, no reply routing, never sent to Telegram. A client receives them only when it asks (`kenning=1` on the socket URL; `kenningCards: true` in `@wherever-dev/client`, which the web app sets), so older clients see nothing new.

While kenning's inbox holds questions for you, the tab title starts with "(N) " and the installed app shows N on its icon where the browser supports app badges. This needs no assistant; pushes for blocking questions still do.
