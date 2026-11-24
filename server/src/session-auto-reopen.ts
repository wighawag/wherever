// A closed session reopens itself on new activity (ADR 0025, spec
// `closed-sessions` resolved decision 2): nothing that needs the user may hide
// behind "closed".
//
// Two triggers, both wired in `index.ts`:
//
// - **Agent events** (`onEvent`, subscribed through `SessionPool.subscribeEvents`,
//   which sees server AND CLI-bridged sessions and isolates a throwing
//   listener): an `agent_start`, a user `message_end` (any channel: web,
//   Telegram, a CLI terminal) and a shipmates delivery (a `custom` message or a
//   `custom_message` entry whose `customType` is `shipmates`). The membership
//   check is the store's in-memory set: no disk read per event; only a hit
//   writes.
// - **The inbox** (`onInbox`, called on every shipmates change with the open
//   items of the service's snapshot): a closed session with an open item created
//   AFTER it was closed reopens. Stateless (it compares `createdAt` with the
//   entry's `closedAt`), so it holds across restarts and a session can still be
//   closed while an older item of its stays open. Both clocks are epoch ms
//   (`Date.now`); a test that injects shipmates' clock must close on it too.
//
// Not triggers, by design: a `!command` typed into a closed CLI session (it
// emits only tool events), and a transcript written while wherever cannot see it
// (no bridge, server down). Both reopen it on their next turn, if any.
//
// A reopen removes the store entry (with its `batch` and `unstarred`), then
// calls `onReopened` (the server broadcasts `sessions_updated`: an
// `agent_start` alone only sends `session_working`). A reopen write that throws
// is caught and logged here, so it never breaks event routing; the session stays
// closed and the next trigger tries again.

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { SHIPMATES_CUSTOM_TYPE } from './shipmates-delivery.js';
import { closedAtOf, isSessionClosed, readClosedSet, reopenSessions } from './session-closed.js';

/** True for the agent events that reopen a closed session. */
export function isReopenEvent(event: AgentSessionEvent): boolean {
  const type = event.type as string;
  if (type === 'agent_start') return true;
  if (type === 'message_end') {
    const m = (event as any).message;
    if (m?.role === 'user') return true;
    return m?.role === 'custom' && m.customType === SHIPMATES_CUSTOM_TYPE;
  }
  if (type === 'entry_appended') {
    const e = (event as any).entry;
    return e?.type === 'custom_message' && e.customType === SHIPMATES_CUSTOM_TYPE;
  }
  return false;
}

/** The part of an open inbox item the rule reads (`ShipmatesInboxItemView`). */
export interface InboxItemForReopen {
  /** Normalized session file (the snapshot's view already is). */
  sessionFile: string;
  createdAt: number;
}

/**
 * The closed sessions with an open item created after they were closed, each
 * once, in inbox order. `closedAt` answers undefined for a session not closed.
 */
export function sessionsToReopenForInbox(
  inbox: readonly InboxItemForReopen[],
  closedAt: (sessionFile: string) => number | undefined,
): string[] {
  const out: string[] = [];
  for (const item of inbox) {
    if (out.includes(item.sessionFile)) continue;
    const at = closedAt(item.sessionFile);
    if (at !== undefined && item.createdAt > at) out.push(item.sessionFile);
  }
  return out;
}

export interface AutoReopenDeps {
  /** In-memory membership (never reads the disk once loaded). */
  isClosed?: (sessionFile: string) => boolean;
  /** In-memory `closedAt`, undefined when not closed. */
  closedAt?: (sessionFile: string) => number | undefined;
  /** True when nothing at all is closed (lets the inbox rule skip the snapshot). */
  noneClosed?: () => boolean;
  /** Persist the reopen; returns the sessions it reopened. May throw. */
  reopen?: (files: string[]) => string[];
  /** Called with the sessions just reopened (the server broadcasts `sessions_updated`). */
  onReopened: (files: string[]) => void;
  log?: Pick<Console, 'error'>;
}

export interface AutoReopen {
  /** A pool event listener (`SessionPool.subscribeEvents`). Never throws. */
  onEvent(sessionFile: string, event: AgentSessionEvent): void;
  /**
   * The shipmates-change half. `inbox` is a thunk so nothing reads shipmates'
   * database while no session is closed. Never throws.
   */
  onInbox(inbox: () => readonly InboxItemForReopen[]): void;
}

export function createAutoReopen(deps: AutoReopenDeps): AutoReopen {
  const isClosed = deps.isClosed ?? isSessionClosed;
  const closedAt = deps.closedAt ?? closedAtOf;
  const noneClosed = deps.noneClosed ?? (() => readClosedSet().size === 0);
  const reopen = deps.reopen ?? reopenSessions;
  const log = deps.log ?? console;

  const reopenNow = (files: string[], why: string) => {
    let reopened: string[];
    try {
      reopened = reopen(files);
    } catch (err) {
      log.error(`[wherever] could not reopen closed session(s) on ${why}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (reopened.length === 0) return;
    try {
      deps.onReopened(reopened);
    } catch (err) {
      log.error(`[wherever] reopen listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    onEvent(sessionFile, event) {
      try {
        if (!isReopenEvent(event) || !isClosed(sessionFile)) return;
      } catch (err) {
        log.error(`[wherever] closed-session check failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      reopenNow([sessionFile], event.type as string);
    },
    onInbox(inbox) {
      let files: string[];
      try {
        if (noneClosed()) return;
        files = sessionsToReopenForInbox(inbox(), closedAt);
      } catch (err) {
        log.error(`[wherever] closed-session inbox check failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (files.length > 0) reopenNow(files, 'a new inbox item');
    },
  };
}
