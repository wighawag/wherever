---
"wherever-dev": minor
---

Files now flow both ways on the assistant's Telegram channel. A photo, an album or a document from the paired user is downloaded into the upload dir (where a web upload into the assistant session lands) and reaches the assistant as `[Uploaded file: <path>]` lines, exactly as a web upload does, with the caption as the text. When the assistant calls `attach_file` in a reply to a Telegram message, the file is sent on Telegram (as a photo for jpg, png and webp images up to 10 MB, as a document otherwise), and a file over Telegram's 50 MB limit gets a clear note instead. Files attached in web, terminal or scheduled turns are never sent to Telegram.
