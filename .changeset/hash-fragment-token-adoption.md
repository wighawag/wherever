---
"wherever-dev": minor
---

Reach a token-protected instance with a single link: opening `https://host/#token=SECRET` now gives a fully working session with nothing to configure by hand.

The dashboard takes the token out of the page URL on boot, merges it into the stored connection config and removes it from the address bar with `history.replaceState`, so no history entry keeps the secret. Previously the token was only ever read from Connection Settings, so a link authenticated the page request but left the WebSocket upgrade with no credential: the dashboard rendered and then failed to connect.

The hash fragment is the documented form because a fragment is never sent to the server, keeping the token out of HTTP access logs, out of the `Referer` header and out of any intermediary proxy's request log. A legacy `?token=` link still works and is scrubbed from the address bar too. Adopting a link only touches the token field, so host, port and display preferences are preserved, and a blank `#token=` is ignored rather than stored, so a malformed link cannot clear a token that is already working.

The token is stored exactly as written in the link, since the server compares it byte for byte, and the `token` key is recognised whatever its capitalisation, so a retyped link is adopted rather than being mistaken for a session deep link (the fragment is also how the dashboard addresses a session).
