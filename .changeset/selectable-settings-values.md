---
"wherever-dev": patch
---

The Telegram pairing code can be selected again (the sidebar's unlayered `user-select: none` rule beat Tailwind's `select-all`), and has Copy buttons for the code and for `/pair <code>`, with a "Copied" confirmation and a fallback when the clipboard API is unavailable. A new `.selectable` opt-in also makes the Telegram and push error messages, the paired user line, the version string and form fields in the sidebar selectable.
