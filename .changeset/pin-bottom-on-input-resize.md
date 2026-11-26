---
"wherever-dev": patch
---

Keep the conversation pinned to the bottom when the message list resizes. Typing on the last line of the input grows the textarea, which shrank the message list without moving its scroll position, so the last message went behind the input and later messages stayed hidden too. A ResizeObserver on the list now scrolls it back to the bottom whenever it was at the bottom before the resize. This also covers the mobile keyboard opening.
