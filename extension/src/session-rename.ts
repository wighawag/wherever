/**
 * The bridge half of a wherever rename (server `POST /sessions/name`, wherever
 * ADR 0027 "a rename is written by the file's owner").
 *
 * A CLI-bridged session's transcript is owned by THIS terminal pi, so the server
 * never writes it: it sends `cli_rename {id, name}` and this extension writes the
 * name with pi's own `setSessionName`, then answers `cli_rename_result {id, ok}`
 * (or `{id, ok: false, error}` when pi throws). That reply is the reverse
 * direction of ADR 0016's `cli_request` / `cli_response`: the server waits for
 * it and answers the web only on `ok`.
 *
 * The extension advertises `cli_rename` in `cli_register.capabilities`
 * (`BRIDGE_CAPABILITIES`); the server refuses to rename through a bridge that
 * did not, rather than writing a file a live terminal owns.
 *
 * Kept free of pi and `ws` imports so it can be tested with plain fakes.
 */

/** The frame the server sends. */
export interface CliRenameFrame {
  type: "cli_rename";
  id?: unknown;
  name?: unknown;
}

/** What the handler needs from pi and the bridge socket (the test seam). */
export interface CliRenameDeps {
  /** pi's `setSessionName` (ExtensionAPI). */
  setSessionName(name: string): void;
  /** Send a frame on the bridge socket. */
  send(frame: object): unknown;
}

/** Handle a `cli_rename`: write the name with pi, answer `cli_rename_result`. A frame without an id is dropped (it cannot be answered). */
export function handleCliRename(msg: CliRenameFrame, deps: CliRenameDeps): void {
  if (typeof msg.id !== "string" || !msg.id) return;
  const id = msg.id;
  const name = typeof msg.name === "string" ? msg.name.trim() : "";
  if (!name) {
    deps.send({ type: "cli_rename_result", id, ok: false, error: "empty name" });
    return;
  }
  try {
    deps.setSessionName(name);
  } catch (err) {
    deps.send({ type: "cli_rename_result", id, ok: false, error: (err as Error)?.message || String(err) });
    return;
  }
  deps.send({ type: "cli_rename_result", id, ok: true });
}
