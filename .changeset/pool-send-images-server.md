---
"wherever-dev": minor
---

Photos and images sent to the assistant on Telegram now reach the model as images, not only as file paths. Every received file that is an image (a photo, or an image sent as a document) is passed to the assistant session as a model image input, and its `[Uploaded file: <path>]` line stays in the message so the agent can still open, move or attach the file. This works for server-built sessions and, through the CLI bridge, for a terminal `pi` attached to wherever. A text-only model gets pi's "image omitted" note instead. Messages without images are sent exactly as before, and reply routing is unchanged.
