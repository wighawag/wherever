# Slow links: incremental reconnect resync, and coalesced streaming deltas

Follow-ups to the slow-link work (CONTEXT.md, "Slow links: chunked frames, history images by reference, compression").

- **Coalesced streaming deltas: SHIPPED** (`server/src/delta-coalescer.ts`, see CONTEXT.md).
- **Incremental reconnect resync: promoted to a spec**, `work/specs/proposed/incremental-reconnect-resync.md`. Why it was kept out of the first round: the client's history mapper pairs `tool_result` with its open `tool_call` inside one batch, freezes unanswered calls, and replaces the live (unpersisted) streaming state on resync; a delta crosses those boundaries, and a mistake corrupts the visible conversation silently. It needs its own tests.
