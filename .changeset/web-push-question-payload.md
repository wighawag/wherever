---
"wherever-dev": patch
---

Web Push: a shipmates question now arrives as a short system notification (title "<source> asks", the question only as its body), tagged `shipmates-<itemId>` so a re-push of the same item replaces it instead of adding a duplicate, with `data: {kind: 'question', itemId, sentAt}`. Every other notification keeps its title and body and gets `data: {kind: 'update'}` and a tag of its own. Telegram keeps the full wording (options and "Answer in the wherever inbox."). A failed read of shipmates' database now sends `inboxError: true` in `shipmates_update`, which the web keeps, so it can tell a failed read from an empty inbox.
