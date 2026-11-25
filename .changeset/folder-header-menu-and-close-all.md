---
"wherever-dev": patch
---

Folder headers in the sidebar now take one line (▶, name, session count, the "Missing" badge) with a ⋯ menu holding the folder's path, "New session here", a new "Close all in folder" and "Delete all…" (red, asks again); on the read-only page the menu shows only the path. "Close all in folder" closes the open sessions the folder shows (the text filter and "Only starred" apply) as one batch, with a "Closed N sessions in <folder>" banner whose Undo reopens them and puts their stars back. The server's `POST /sessions/close` accepts `{sessionFiles: [...], closed: true}` for that (up to 1,000 sessions, one batch, no cascade). The ⋯ menus and the ☰ view options share one menu: a bottom sheet on phones, a popover on desktop, closing on a tap outside, Escape or an action, and usable with the keyboard.
