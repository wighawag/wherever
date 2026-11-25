# rename-session-endpoint: decisions made while building

Dated 2026-11-25. The load-bearing one (who writes the name) is ADR 0027 (`docs/adr/0027-a-rename-is-written-by-the-files-owner.md`). These are the smaller in-scope choices, for the reviewer and for `session-row-rename` / `chat-session-menu`, which show the error texts.

1. **Frame and capability names: `cli_rename {id, name}`, `cli_rename_result {id, ok, error?}`, capability `cli_rename`.** Short, in the existing `cli_*` family, and the capability names the frame it enables (as `cli_request` does). Alternative: `cli_set_session_name` (mirrors pi's method, but longer and leaks pi's API name into the protocol). Touches: `server/src/protocol.ts`, `extension/src/bridge-requests.ts` `BRIDGE_CAPABILITIES`, CONTEXT.md CLI bridge section.

2. **HTTP status per outcome.** 400 validation and path; 404 file missing (and not in the pool); 409 for every "cannot be done safely right now" refusal (old bridge, no message yet, load in flight, reloading); 502 the terminal said `ok:false` or disconnected; 504 the terminal did not answer in time; 500 an unexpected throw. Alternative: one 409/500 for everything. Chosen so a UI could tell "retry later" from "fix your terminal" without parsing text; the UI tasks can still just show `error`. Texts are in `RENAME_REFUSALS` (`server/src/session-rename.ts`).

3. **Name normalisation: every whitespace run (newlines included) becomes one space, then trim; 1 to 200 characters.** A name is one line in the sidebar; a pasted multi-line title would otherwise render oddly. Over-long is refused, never truncated (same rule as drafts). Alternative: store verbatim. Does not touch the shipmates spawn title, which still calls `setSessionName` directly.

4. **"No message yet" for a CLI-bridged session is decided server-side by "the transcript file exists".** The server cannot see the terminal's memory, and pi writes the file exactly when the first user or assistant message lands. The extension does not re-check; it only refuses an empty name. Alternative: let the extension check `sessionManager` entries and answer `ok:false` (would also work, but a second place to keep in sync, and the server would send a frame it already knows is pointless).

5. **Bridge reply matching and timeout.** Matched by id AND by the socket the frame went to (another bridge cannot settle it); a bridge disconnect fails pending renames at once (`SessionRenamer.dropSocket`, from the WS close handler); otherwise 10 s, the same value as the extension's `DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS`. Not configurable; the timeout is tested at the module level with an injected short timeout rather than through a new env knob.

6. **The disk-only path opens the whole transcript with `SessionManager.open` (synchronous).** This departs from CONTEXT.md's "never materialize a whole session file", and on a very large transcript it blocks the event loop for the parse. Accepted because a rename is a rare, user-initiated action, the task names this API, and pi's own `appendSessionInfo` gives a correctly parented entry (writing the line by hand would need the leaf id, i.e. the same parse). If it bites, the fix is a tail read for the leaf id plus a hand-written line.

7. **Pool seam: `SessionPool.hasPendingLoad(file)`**; all rename logic lives in `server/src/session-rename.ts` (`SessionRenamer`), not in the 3,800-line pool. The WS `cli_rename_result` case is in `handleWSMessage` (new trailing `renamer` parameter).

8. **Response body `{sessionFile, name}`** (the name as stored), so a caller can show the normalised name without waiting for the relist.

9. **Browser check.** This task adds no UI (only the store function), so there was nothing to look at at 390 px or desktop width; the endpoint is covered by the real-server tests. The visual checks belong to `session-row-rename` and `chat-session-menu`.
