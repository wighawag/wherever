---
"wherever-dev": patch
---

Render Nerd Font symbols (Powerline separators, git branch, clock and folder icons used by fancy shell prompts) instead of tofu boxes. The web UI now bundles Symbols Nerd Font Mono as a `unicode-range`-limited fallback in both the sans and mono font stacks, so it is only downloaded when such a glyph is shown and a locally installed copy is preferred. The font is kept out of the service worker install-time precache (it is cached on first use instead). The server also serves `.woff2` with the `font/woff2` MIME type.
