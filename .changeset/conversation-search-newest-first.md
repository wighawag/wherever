---
"wherever-dev": minor
---

Conversation search can sort Newest first: a Relevance / Newest toggle in the search panel (main and read-only views, remembered on this device, default Relevance). Newest is sent as `GET /search?sort=recent` and forwarded to memonaut's `order: 'recent'`, which orders by when the matched message was said, newest first, BEFORE the result limit, so a recent match ranked low by relevance still appears. Under `recent` the server over-fetches up to 50 results so hidden or closed sessions do not shorten the page, and `hiddenHits` counts only hidden results above the cut. An unknown `sort` answers `status: "error"`. Bumps `memonaut` to `^0.5.0` (and regenerates `pnpmDepsHash` in `package.nix`).
