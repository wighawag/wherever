# Search in this chat

## Context

The approved chat redesign mockup (`docs/design/sidebar-and-chat-redesign/phone.png`, frame 4) lists "Search in this chat" at the top of the top-bar ⋯ session menu. Nothing like it exists today, so the human left it out of spec `chat-compact-layout` (2026-11-25) and asked for it to be kept as an idea.

## Why it is not trivial

- Conversation search (`GET /search`, memonaut) has no per-session scope.
- A search result opens the session, not the matched message: history is windowed by message offset, and memonaut reports a `seq`, so jumping to a match needs a seq to offset mapping (see `CONTEXT.md` "Conversation search", "Not implemented (deliberately)").

## Options considered

- A client-side find over the messages already loaded (highlight, next / previous); older history is not searched until loaded.
- The Search tab scoped to this session (a new `session=` filter on `/search`); results still only open the session.
- The full version: scoped search plus jump-to-message (the seq to offset mapping), which also benefits the global search.

## Next step

Write a spec when it is wanted; the ⋯ session menu from `chat-compact-layout` is where the entry goes.
