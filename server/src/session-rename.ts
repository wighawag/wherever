/**
 * Renaming a session (`POST /sessions/name`, ADR 0027 "a rename is written by
 * the file's owner").
 *
 * A pi session's name is the LAST `session_info` entry in its transcript (the
 * listing reads it, `session-transcript.ts`). Exactly one process may append to
 * a transcript at a time, so the rename is written by whichever process owns
 * the file right now:
 *
 *  - a SERVER session in the pool: its own agent (`AgentSession.setSessionName`);
 *  - a CLI-BRIDGED session: the terminal pi, through the bridge. The server sends
 *    `cli_rename {id, name}` and the `@wherever-dev/pi` extension answers
 *    `cli_rename_result {id, ok, error?}` (the reverse direction of ADR 0016's
 *    `cli_request` / `cli_response`). A bridge that did not advertise the
 *    `cli_rename` capability is REFUSED, never written around;
 *  - a session only ON DISK (not in the pool, no load in flight): pi's own
 *    `SessionManager.open(file).appendSessionInfo(name)`, synchronously, so no
 *    load can start between the check and the write.
 *
 * Refused: a load in flight for the file, a server entry that is reloading, and
 * a session with no user or assistant message yet (pi writes nothing to the file
 * before the first one, so the name would never reach it).
 *
 * Kept free of `index.ts` so the write paths are testable against a bare pool
 * and a fake bridge socket.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SessionManager } from './pi-sdk.js';
import type { SessionPool } from './session-pool.js';

/** The capability a bridge extension advertises in `cli_register` when it handles `cli_rename`. */
export const CLI_RENAME_CAPABILITY = 'cli_rename';

/** Longest accepted name, after whitespace is collapsed. */
export const MAX_SESSION_NAME_CHARS = 200;

/** Longest accepted `sessionFile` (same bound as the star endpoint). */
const MAX_PATH_CHARS = 4096;

/** How long the server waits for a bridge's `cli_rename_result` (same as the extension's request timeout). */
export const DEFAULT_CLI_RENAME_TIMEOUT_MS = 10_000;

export const RENAME_REFUSALS = {
  pending: 'This session is being loaded right now, so it was not renamed. Try again in a moment.',
  reloading: 'This session is reloading, so it was not renamed. Try again once it is ready.',
  empty: 'This session has no message yet, so a name would not be saved. Send a message first, then rename it.',
  oldBridge:
    'This session runs in a terminal pi whose wherever extension is too old to rename it. Update the wherever extension in that terminal (@wherever-dev/pi), then try again.',
  bridgeClosed: 'The terminal running this session disconnected, so it was not renamed. Try again.',
  timeout: 'The terminal running this session did not answer the rename in time.',
  notFound: 'Session not found',
} as const;

/**
 * Validate a rename request body. Returns the error text, or the cleaned input:
 * `name` has every run of whitespace (newlines included) collapsed to one space
 * and is trimmed; empty is refused (the web treats an empty field as cancel).
 */
export function validateRenameInput(
  input: { sessionFile?: unknown; name?: unknown } | null | undefined,
): { error: string } | { sessionFile: string; name: string } {
  if (!input || typeof input !== 'object') return { error: 'Invalid request' };
  if (typeof input.sessionFile !== 'string' || input.sessionFile.length === 0) return { error: 'Missing sessionFile' };
  if (input.sessionFile.length > MAX_PATH_CHARS) return { error: 'sessionFile is too long' };
  if (typeof input.name !== 'string') return { error: 'name must be a string' };
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'name must not be empty' };
  if (name.length > MAX_SESSION_NAME_CHARS) return { error: `name is too long (at most ${MAX_SESSION_NAME_CHARS} characters)` };
  return { sessionFile: input.sessionFile, name };
}

/** How the rename went. `status` is the HTTP status the endpoint answers. */
export type RenameResult =
  | { ok: true; path: 'server' | 'cli' | 'disk' }
  | { ok: false; status: number; error: string };

/** The bridge socket slice the renamer needs (the test seam). */
export interface RenameBridgeSocket {
  send(data: string): void;
  readyState?: number;
}

/** True when a session's entries hold a user or assistant message (pi's own "has a conversation" test). */
export function hasConversation(entries: readonly unknown[]): boolean {
  return entries.some((e: any) => e?.type === 'message' && (e.message?.role === 'user' || e.message?.role === 'assistant'));
}

interface PendingRename {
  ws: RenameBridgeSocket;
  resolve: (r: RenameResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionRenamer {
  private readonly pool: SessionPool;
  private readonly timeoutMs: number;
  private readonly newId: () => string;
  private readonly pending = new Map<string, PendingRename>();

  constructor(pool: SessionPool, opts: { timeoutMs?: number; newId?: () => string } = {}) {
    this.pool = pool;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CLI_RENAME_TIMEOUT_MS;
    this.newId = opts.newId ?? (() => randomUUID());
  }

  /**
   * Rename `sessionFile` (already resolved and checked to be inside the
   * sessions dir by the caller) to `name` (already validated). Never throws.
   */
  async rename(sessionFile: string, name: string): Promise<RenameResult> {
    // A load in flight holds an in-memory copy of the file: whatever we wrote
    // now, it would write over or fork from. Checked BEFORE the pool entry,
    // since a CLI register or a handoff can have both.
    if (this.pool.hasPendingLoad(sessionFile)) return { ok: false, status: 409, error: RENAME_REFUSALS.pending };

    const tracked = this.pool.getSession(sessionFile);
    if (tracked?.type === 'server') {
      if (tracked.reloading) return { ok: false, status: 409, error: RENAME_REFUSALS.reloading };
      const sm = tracked.agentSession.sessionManager;
      if (!hasConversation(sm.getEntries())) return { ok: false, status: 409, error: RENAME_REFUSALS.empty };
      try {
        tracked.agentSession.setSessionName(name);
        return { ok: true, path: 'server' };
      } catch (err) {
        return { ok: false, status: 500, error: (err as Error).message || 'Failed to rename the session' };
      }
    }

    if (tracked?.type === 'cli') {
      if (!tracked.capabilities.includes(CLI_RENAME_CAPABILITY)) return { ok: false, status: 409, error: RENAME_REFUSALS.oldBridge };
      // The terminal pi writes its file on the first user message; no file yet
      // means no message yet (the server cannot see the terminal's memory).
      if (!fs.existsSync(tracked.sessionFile)) return { ok: false, status: 409, error: RENAME_REFUSALS.empty };
      return this.askBridge(tracked.cliWs as unknown as RenameBridgeSocket, name);
    }

    // On disk only. Synchronous from here to the append, so no load or register
    // can slip in between the checks above and the write.
    if (!fs.existsSync(sessionFile)) return { ok: false, status: 404, error: RENAME_REFUSALS.notFound };
    try {
      const sm = SessionManager.open(sessionFile);
      if (!sm.getHeader()) return { ok: false, status: 400, error: 'Not a pi session file (it has no header)' };
      if (!hasConversation(sm.getEntries())) return { ok: false, status: 409, error: RENAME_REFUSALS.empty };
      sm.appendSessionInfo(name);
      return { ok: true, path: 'disk' };
    } catch (err) {
      return { ok: false, status: 500, error: (err as Error).message || 'Failed to rename the session' };
    }
  }

  /** A bridge's `cli_rename_result`. Only the socket the request went to can answer it. */
  handleResult(ws: RenameBridgeSocket, frame: { id?: unknown; ok?: unknown; error?: unknown }): void {
    if (typeof frame.id !== 'string') return;
    const p = this.pending.get(frame.id);
    if (!p || p.ws !== ws) return;
    this.settle(frame.id, frame.ok === true
      ? { ok: true, path: 'cli' }
      : {
          ok: false,
          status: 502,
          error: `The terminal could not rename the session: ${typeof frame.error === 'string' && frame.error ? frame.error : 'unknown error'}`,
        });
  }

  /** A bridge socket closed: fail its renames now rather than at the timeout. */
  dropSocket(ws: RenameBridgeSocket): void {
    for (const [id, p] of this.pending) {
      if (p.ws === ws) this.settle(id, { ok: false, status: 502, error: RENAME_REFUSALS.bridgeClosed });
    }
  }

  private askBridge(ws: RenameBridgeSocket, name: string): Promise<RenameResult> {
    if (ws.readyState === 2 || ws.readyState === 3) {
      return Promise.resolve({ ok: false, status: 502, error: RENAME_REFUSALS.bridgeClosed });
    }
    const id = this.newId();
    return new Promise<RenameResult>((resolve) => {
      const timer = setTimeout(() => this.settle(id, { ok: false, status: 504, error: RENAME_REFUSALS.timeout }), this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { ws, resolve, timer });
      try {
        ws.send(JSON.stringify({ type: 'cli_rename', id, name }));
      } catch {
        this.settle(id, { ok: false, status: 502, error: RENAME_REFUSALS.bridgeClosed });
      }
    });
  }

  private settle(id: string, result: RenameResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(result);
  }
}
