---
"wherever-dev": patch
---

Fix two input auto-size bugs. Text set programmatically (forking a message, loading a draft, a speech transcript) left the input at one line until the next keystroke, because the resize measured the textarea before the new value reached the DOM; it now waits for the DOM update, and also re-fits when the input's width changes. On Firefox, typing in a multi-line input still nudged the conversation up behind the input: the measurement briefly collapses the textarea, and Firefox clamped the message list's scroll position during that collapse. The input row's height is now held fixed while measuring, so the surrounding layout never moves.

The input also caps at 25% of the visible viewport height instead of 40% of the viewport, so a long message leaves more of the conversation readable (especially with the mobile keyboard open), and its scrollbar now sits at the right edge of the input box instead of left of the mic: the attach, mic and send buttons float over the textarea's bottom corners, with padding reserving their measured widths.
