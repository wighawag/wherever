/**
 * The upload WRITE GATE: one decision, shared by every path that writes an
 * uploaded file (the legacy base64 `file_upload` frame today; the chunked
 * protocol and `POST /session/upload` reuse it).
 *
 * An upload WRITES a file to disk, so it is a write capability and sits behind
 * the same verdict as a send. It is bound to the session this socket PAINTED
 * (`session_created` of its last `session_load` / `session_new`), not only to
 * the one it is attached to: with fast-first loading a cold session is painted
 * seconds before the socket is attached, and that window is exactly when a
 * resumed upload arrives (docs/adr/0012).
 *
 * Decision (recorded here, the choice site): when a session is painted, ONLY
 * that session is accepted. The attached session is the fallback only while
 * nothing is painted (the start of a `session_load`, before its cheap read
 * returns, when `readOnly` still describes the attached session). Accepting
 * "painted OR attached" at all times was considered and rejected: between a
 * cold load's paint of B and its attach, the socket is still attached to the
 * previous session A while `client.readOnly` already holds B's verdict, so an
 * upload for A would be judged by B's verdict, which is the very cross-session
 * bug this gate exists to close.
 */

import type { WhereverConfig } from './session-pool.js';

/** Default for `uploads.maxBytes`: 1 GiB. Phone videos easily exceed the 100 MiB download cap. */
export const DEFAULT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

/** The parts of a WS client the gate reads. */
export interface UploadGateClient {
  /** The ATTACHED session file, or null. */
  sessionId: string | null;
  readOnly: boolean;
  paintedSessionFile?: string;
  paintedSessionId?: string;
  paintedCwd?: string;
}

/** The parts of the session pool the gate reads. */
export interface UploadGatePool {
  getSession(sessionFileOrId: string): { sessionFile: string; cwd: string } | null;
}

export type UploadGateVerdict = { ok: true; cwd: string } | { ok: false; reason: string };

/**
 * May this client write an upload for `sessionId` (a session id or file)?
 * On success, returns the cwd of the session the file belongs to: the PAINTED
 * cwd, never `pool.getSession()` of a cold session, which is null while its
 * agent builds and used to send the file to tmp.
 */
export function gateUploadWrite(
  client: UploadGateClient,
  pool: UploadGatePool,
  sessionId: string,
): UploadGateVerdict {
  let cwd: string | undefined;
  if (client.paintedSessionFile) {
    if (
      client.paintedCwd &&
      (sessionId === client.paintedSessionId || sessionId === client.paintedSessionFile)
    ) {
      cwd = client.paintedCwd;
    }
  } else if (client.sessionId) {
    const tracked = pool.getSession(sessionId);
    if (tracked && tracked.sessionFile === client.sessionId) cwd = tracked.cwd;
  }
  if (cwd === undefined) {
    return {
      ok: false,
      reason: 'This upload is not for the session this connection is on, so the file was not uploaded.',
    };
  }
  if (client.readOnly) {
    return { ok: false, reason: 'This session is read-only from here, so the file was not uploaded.' };
  }
  return { ok: true, cwd };
}

/** The configured `uploads.maxBytes`, or the 1 GiB default when unset or not a positive number. */
export function uploadMaxBytes(config: WhereverConfig): number {
  const v = config.uploads?.maxBytes;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_UPLOAD_MAX_BYTES;
}

/** Refusal reason when `bytes` exceeds the limit, else null. */
export function uploadTooLarge(bytes: number, maxBytes: number): string | null {
  return bytes > maxBytes
    ? `File too large (${bytes} bytes, the limit is ${maxBytes} bytes), so it was not uploaded.`
    : null;
}
