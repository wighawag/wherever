---
"@wherever-dev/pi": minor
---

A message relayed from wherever can now carry images (for example a photo sent to the assistant on Telegram): the extension passes them to `pi.sendUserMessage` as image content beside the text, so the terminal pi shows them to the model. Messages without images are sent as the plain text, exactly as before.
