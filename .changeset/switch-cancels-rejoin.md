---
"wherever-dev": patch
"@wherever-dev/client": patch
---

Switching session while the previous one is still reconnecting no longer snaps back to it. Coming back to the PWA reconnects and rejoins the session that was open; if the user opened another session or created a new one before that finished, the rejoin landed afterwards and switched the view back. A switch is now the newer intent and cancels the rejoin: a session load or create requested while the socket is still opening is sent once it opens (instead of the rejoin, and it used to be lost), the late reply of an abandoned load is dropped (a create in flight used to accept it as its own), and the page no longer auto-joins a URL hash still naming the left session while a create is in flight or after leaving while disconnected.
