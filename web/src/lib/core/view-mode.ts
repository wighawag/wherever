// Single source of truth for "which top-level view are we in", derived from the
// session lifecycle flags. Both the message area (ChatMessageList) and the
// bottom composer (+page.svelte) key off this so they can never disagree -- the
// bug being fixed was the composer showing the search input while the message
// area showed "Loading session..." because each computed the no-session state
// independently.

export interface SessionViewInputs {
	connected: boolean;
	/** A session's transcript is loaded (activeSessionFile is set). */
	hasSession: boolean;
	/** A fresh session load is in flight (loadingSession). */
	loading: boolean;
	/** A reconnect is rejoining a cached session (resyncing). */
	resyncing: boolean;
	/** A URL hash points at a session we are about to open. */
	hasSessionHash: boolean;
	/**
	 * The last session load failed (an error is showing, nothing is loading and
	 * no session is active). A hash that is still present is then NOT a pending
	 * open: it would otherwise keep the "Loading session..." spinner up forever.
	 */
	loadFailed?: boolean;
}

/**
 * True when a session is being opened (or reopened) but its transcript is not
 * yet on screen: a fresh load, a resync, or a hash that will drive a load. In
 * this window sessionFile is briefly null, but this is NOT the search / new-
 * session home state -- the message area shows a "Loading session..." spinner,
 * so the composer must NOT present the search input.
 */
export function isSessionPendingOpen(i: SessionViewInputs): boolean {
	return i.loading || i.resyncing || (i.hasSessionHash && !i.loadFailed);
}

/**
 * True only at the genuine no-session home state where the composer acts as the
 * web-search input: connected, a search folder configured, no active session,
 * and no session mid-open. Mirrors the message area's empty-state condition so
 * the two views stay consistent.
 */
export function isSearchActive(
	i: SessionViewInputs & {searchConfigured: boolean},
): boolean {
	return (
		i.connected &&
		i.searchConfigured &&
		!i.hasSession &&
		!isSessionPendingOpen(i)
	);
}

export interface HashJoinInputs {
	connected: boolean;
	/** Session id from the URL hash ('' when there is none). */
	hashId: string;
	/** The active session's id (null when none). */
	currentSessionId: string | null;
	loading: boolean;
	resyncing: boolean;
	/**
	 * The hash id the auto-join last issued a load for, still unresolved by a
	 * success. Reset on disconnect, on success, and on a hash change.
	 */
	attemptedHashId: string | null;
}

/**
 * What the URL-hash auto-join should do now.
 * - 'skip': nothing to do (no hash, not connected, already on it, or a load or
 *   resync is in flight).
 * - 'join': issue a load for the hash session.
 * - 'failed': we already tried THIS hash id and the load ended without the
 *   session becoming active (an untagged session_error such as "session not
 *   found", or the load watchdog). Do NOT retry: without this the effect
 *   re-joined every ~300 ms forever, since the error clears `loading` (which
 *   re-runs the effect) while nothing clears the hash.
 */
export function decideHashJoin(i: HashJoinInputs): 'skip' | 'join' | 'failed' {
	if (!i.connected || !i.hashId) return 'skip';
	if (i.currentSessionId === i.hashId || i.loading || i.resyncing)
		return 'skip';
	// Only a failure when nothing is active: a session that IS active (e.g. the
	// hash names it by file path rather than id, so the ids never match) must
	// not be treated as a failed load, which would clear the hash and leave it.
	if (i.attemptedHashId === i.hashId)
		return i.currentSessionId ? 'skip' : 'failed';
	return 'join';
}
