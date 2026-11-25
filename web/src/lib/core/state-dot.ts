/**
 * The one state-dot legend of the session list (spec `sidebar-compact-layout`,
 * stories 1 to 4): the folder rows, the By-owner rows, the By-owner group
 * summaries and the Live strip all colour a session the same way, with amber
 * reserved for "waiting for you". Pure, so it is unit-tested; `StateDot.svelte`
 * renders it.
 *
 * Also home of "anyone waits for you", the signal the chat top bar's menu dot
 * will show (spec `chat-compact-layout`).
 */
import {sessionLiveState, type LiveState} from './live-sessions';
import {
	presenceByFile,
	type ShipmatesPresence,
	type ShipmatesState,
} from './shipmates';

/**
 * What a session's dot shows. The three live states are `sessionLiveState`'s;
 * `idle` is a loaded (resident) session that is not live (green, the old
 * "active" dot); `not-loaded` is grey; `closed` is a hollow ring.
 */
export type DotState = LiveState | 'idle' | 'not-loaded' | 'closed';

/** The fields of a listed session (`SessionInfo`) the dot reads. */
export interface SessionDotLike {
	isWorking?: boolean;
	isActive?: boolean;
}

/**
 * A session's dot. Precedence, first match wins: a live state (from
 * `sessionLiveState`, the single source of live state); closed; loaded but
 * idle; not loaded. Live beats closed because a closed session reopens on
 * activity (ADR 0025), so a live closed session shows its live colour.
 */
export function sessionDotState(
	session: SessionDotLike,
	presence: Pick<ShipmatesPresence, 'state'> | undefined,
	closed: boolean,
): DotState {
	const live = sessionLiveState(session, presence);
	if (live !== 'idle') return live;
	if (closed) return 'closed';
	return session.isActive ? 'idle' : 'not-loaded';
}

const DOT_LABEL: Record<DotState, string> = {
	'waiting-for-human': 'waiting for you',
	'waiting-for-session': 'waiting on another session',
	running: 'running',
	idle: 'loaded, idle',
	'not-loaded': 'not loaded',
	closed: 'closed',
};

/** A dot's label: its tooltip, its accessible name, and what a long-press shows. */
export function stateDotLabel(state: DotState): string {
	return DOT_LABEL[state];
}

/** The live states in need order (as the Live strip orders its rows). */
export const LIVE_DOT_ORDER: readonly LiveState[] = [
	'waiting-for-human',
	'waiting-for-session',
	'running',
];

/**
 * Count dots for a summary line (a collapsed By-owner group, the Live strip
 * header): the non-zero live counts, in need order.
 */
export function liveCountDots(
	counts: Partial<Record<LiveState, number>>,
): {state: LiveState; count: number}[] {
	return LIVE_DOT_ORDER.flatMap((state) => {
		const count = counts[state] ?? 0;
		return count > 0 ? [{state, count}] : [];
	});
}

export interface AnyoneWaitsForYou {
	/** Open inbox items (the same source as the sidebar's "Needs you" badge). */
	inbox: number;
	/** Listed sessions whose presence is `waiting-for-human`. */
	sessions: number;
	/** Either count is non-zero. */
	waiting: boolean;
}

/**
 * Does anything wait for the human: an open inbox item, or a listed session
 * waiting for them. Nothing without shipmates (`available: false`), like the
 * inbox badge. Only sessions in `listed` count, so a presence the listing
 * hides never lights the dot.
 */
export function anyoneWaitsForYou(
	shipmates: ShipmatesState,
	listed: Iterable<{path: string}>,
): AnyoneWaitsForYou {
	if (!shipmates.available) return {inbox: 0, sessions: 0, waiting: false};
	const byFile = presenceByFile(shipmates.presence);
	let sessions = 0;
	const seen = new Set<string>();
	for (const s of listed) {
		if (seen.has(s.path)) continue;
		seen.add(s.path);
		if (byFile.get(s.path)?.state === 'waiting-for-human') sessions++;
	}
	const inbox = shipmates.inbox.length;
	return {inbox, sessions, waiting: inbox > 0 || sessions > 0};
}
