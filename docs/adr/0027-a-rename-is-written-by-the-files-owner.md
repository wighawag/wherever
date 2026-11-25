# A rename is written by the file's owner

A session's name is the last `session_info` entry in its pi transcript, and a transcript must have exactly one writer at a time: a live pi holds its tree (entry ids, the leaf) in memory and appends to it, so a line written behind its back is either lost from its view or forks its tree. So `POST /sessions/name` never writes a file another live process owns. The name is written by whichever process owns the file right now: the server's own agent for a session it runs (`AgentSession.setSessionName`); the terminal pi for a CLI-bridged session, through a new server-to-bridge frame `cli_rename {id, name}` that the `@wherever-dev/pi` extension answers with `cli_rename_result {id, ok, error?}`; and, for a session only on disk (not in the pool, no load in flight), pi's own `SessionManager.open(file).appendSessionInfo(name)`, done synchronously so no load can start between the check and the write. Anything that cannot be done this way is refused with a message instead of written around: a bridge whose extension did not advertise the `cli_rename` capability ("update the wherever extension in that terminal"), a file with a load in flight or a server entry that is reloading, and a session with no user or assistant message yet (pi persists nothing before the first one, so the name would never reach the file).

## Considered Options

- **The server appends `session_info` itself for every session.** Simplest, and works with any extension version. Rejected: for a resident server session or a bridged terminal it races the live writer, whose next append would carry a stale parent id, and the live pi would not know its own name.
- **Fire-and-forget to the bridge, like `cli_model_change`.** Rejected: the web could not tell an old or failing terminal from a success, and would show a name that was never written. The reply is the reverse direction of ADR 0016's `cli_request` / `cli_response`, matched by id and by the socket the frame went to, with a 10 s timeout.
- **Rename an empty session by keeping the name until the first message.** Rejected: nothing on the server would hold it across a restart or a takeover, so the rename could silently vanish.

## Consequences

- **A terminal pi WITHOUT the wherever extension is invisible to the pool.** Its session looks "only on disk", so the disk append cannot be guaranteed exclusive. The damage is bounded: the append is one `session_info` line, a child of the leaf the server read; that terminal will not see the name until it reopens the file, and its own next entry still parents to its in-memory leaf.
- **A rename is refused while a CLI-to-server handoff (or any load) is in flight.** The user retries a moment later; the error says so.
- **Conversation search lags.** The listing (`session-transcript.ts`, last `session_info` wins) and every dashboard update at once through `sessions_updated`; the memonaut index picks the new name up at its next index.
- **The extension gains a capability** (`cli_rename` in `BRIDGE_CAPABILITIES`); older extensions keep working for everything else and are refused only for rename.
