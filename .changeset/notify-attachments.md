---
"wherever-dev": minor
"@wherever-dev/pi": minor
---

`assistant_notify` takes optional `attachments` (file paths, resolved like `attach_file`'s, validated at call time). Telegram sends each file after the notification message, as a reply to it (photo or document, or the existing too-large / missing / failed note), without ever failing the notify; the tool result reports each file's outcome. Web Push is unchanged. The CLI twin's schema and text are updated to match.
