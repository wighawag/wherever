---
"wherever-dev": patch
---

A question's system notification now closes by itself once the question is answered anywhere (another device, Telegram, a terminal, the session itself): any open wherever page on the device closes the stale `shipmates-<itemId>` notifications on each fresh shipmates snapshot, instantly while a tab or the PWA is alive, otherwise at the next open. Failed inbox reads, notifications newer than the snapshot and snapshots received before a return to the page close nothing.
