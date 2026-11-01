---
"wherever-dev": minor
"@wherever-dev/client": minor
---

Wherever is now usable on a slow connection. Before, opening or reconnecting to a session whose recent history held a large tool image (a `read` on a screenshot) could loop forever on a weak link: the history was one multi-MB WebSocket frame, the browser only delivers a frame once it has fully arrived, and the client's liveness watchdog took the long silence for a dead socket, reconnected and asked for the same history again. Measured at 30 KB/s with a 3 MB image: the history never painted; now it paints in about 2 s.

- Large server frames are split into small chunks for clients that ask (`frames=chunk.v1`), so a big transfer keeps proving the socket alive and no longer times out the session load.
- History tool images larger than 16 KB are sent by reference for clients that ask (`imageRefs=1`; `WhereverClient` gains an `imageRefs` option, off by default, which the web app turns on) and loaded lazily from the new `GET /session/tool-image`, which the browser caches for good. A reconnect now re-sends text only, and the on-device conversation cache keeps those images.
- WebSocket frames are compressed (`permessage-deflate`), and the web app's JS/CSS/HTML are served with brotli or gzip.
- Streamed reply, thinking and tool-output deltas are merged into about one frame per 50 ms instead of one frame per token (order unchanged, nothing dropped), and a client that falls behind catches up in a few large frames instead of thousands of tiny ones.

Chunking and images by reference are opt-in per connection, so an older cached web build or client keeps the previous behaviour; delta merging is transparent to every client.
