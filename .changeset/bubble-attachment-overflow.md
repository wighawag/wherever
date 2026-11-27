---
"wherever-dev": patch
---

Fix a user message bubble with a long attachment path overflowing past the left edge of the screen. The path's `truncate` never applied because, as a flex item, it would not shrink below its content width; it now gets `min-w-0` (and the bubble is capped at its column's width), so long paths end in an ellipsis inside the bubble.
