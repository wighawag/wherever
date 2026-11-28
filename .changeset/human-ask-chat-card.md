---
"wherever-dev": patch
---

A `human_ask` tool call now shows in the chat as a question card instead of a generic tool chip: the question text (Markdown), its options as buttons and an answer field. Answering from the card is the same human act as the Needs you inbox (channel `web`), so the waiting tool returns the answer and the item leaves every inbox. Once answered, the card shows the answer; ⤢ opens the question in the Needs you reader. The card is never hidden by "hide tools".

A live tool call's arguments are now decoded properly in the chat: a quoted value keeps its newlines and quotes instead of showing JSON escapes, and an array value with spaces (such as `human_ask` options) is no longer cut at the first space.
