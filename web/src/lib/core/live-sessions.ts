/**
 * The Live strip at the top of the session list (spec `session-list-live-strip`):
 * which listed sessions are live right now, whatever folder they are in, and in
 * what order the human should look at them. Pure, so it is unit-tested here and
 * reused by the sibling by-owner view.
 *
 * Also home of the sidebar's filter rule and row label, so the folder list and
 * the strip match and name sessions the same way.
 */
import type {ShipmatesPresence, ShipmatesSessionState} from './shipmates';

/** The fields of a listed session (`SessionInfo`) these helpers read. */
export interface LiveSessionLike {
	path: string;
	name?: string;
	firstMessage: string;
	modified: string;
	isWorking?: boolean;
}

/**
 * A session's live state. Precedence, first match wins: the presence says it
 * waits for the human; it waits on a session; it is working (`isWorking`, from
 * `/sessions` and `session_working`, so it holds without shipmates) or its
 * presence says running; otherwise idle. Live means not idle: an idle presence
 * alone is not live.
 */
export function sessionLiveState(
	session: Pick<LiveSessionLike, 'isWorking'>,
	presence: Pick<ShipmatesPresence, 'state'> | undefined,
): ShipmatesSessionState {
	if (presence?.state === 'waiting-for-human') return 'waiting-for-human';
	if (presence?.state === 'waiting-for-session') return 'waiting-for-session';
	if (session.isWorking || presence?.state === 'running') return 'running';
	return 'idle';
}

/** The sidebar filter: name, first message, or folder name, case-insensitive. Empty matches all. */
export function sessionMatchesFilter(
	session: Pick<LiveSessionLike, 'name' | 'firstMessage'>,
	folderName: string,
	query: string,
): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	return (
		(session.name || '').toLowerCase().includes(q) ||
		(session.firstMessage || '').toLowerCase().includes(q) ||
		folderName.toLowerCase().includes(q)
	);
}

export function truncateLabel(text: string, max: number = 40): string {
	return text.length > max ? text.slice(0, max) + '...' : text;
}

/** A folder row's label: name, else first-message preview, else "Empty session". */
export function sessionListLabel(
	session: Pick<LiveSessionLike, 'name' | 'firstMessage'>,
): string {
	return (
		session.name || truncateLabel(session.firstMessage || '') || 'Empty session'
	);
}

export type LiveState = Exclude<ShipmatesSessionState, 'idle'>;

export interface LiveSessionRow<S extends LiveSessionLike = LiveSessionLike> {
	session: S;
	folderName: string;
	state: LiveState;
	label: string;
}

const NEED_RANK: Record<LiveState, number> = {
	'waiting-for-human': 0,
	'waiting-for-session': 1,
	running: 2,
};

function modifiedTime(s: LiveSessionLike): number {
	const t = new Date(s.modified).getTime();
	return Number.isNaN(t) ? 0 : t;
}

/**
 * The strip's rows: every listed session that matches the filter and is live,
 * ordered by need (waiting for you, waiting on a session, running), then most
 * recently modified first. Built from the listing, so a presence whose session
 * is not listed is dropped. Label: the first shipmates role, else the folder
 * row label (never a remembered label of a session no longer listed).
 */
export function liveSessions<S extends LiveSessionLike>(
	folders: {name: string; sessions: S[]}[],
	presence: Map<string, ShipmatesPresence>,
	query: string,
): LiveSessionRow<S>[] {
	const rows: LiveSessionRow<S>[] = [];
	for (const folder of folders) {
		for (const session of folder.sessions) {
			if (!sessionMatchesFilter(session, folder.name, query)) continue;
			const p = presence.get(session.path);
			const state = sessionLiveState(session, p);
			if (state === 'idle') continue;
			rows.push({
				session,
				folderName: folder.name,
				state,
				label: p?.roles[0] || sessionListLabel(session),
			});
		}
	}
	return rows.sort(
		(a, b) =>
			NEED_RANK[a.state] - NEED_RANK[b.state] ||
			modifiedTime(b.session) - modifiedTime(a.session),
	);
}

/** "Live · 4 · 1 waiting for you" (the waiting part only when some wait). */
export function liveStripHeader(rows: {state: LiveState}[]): string {
	const waiting = rows.filter((r) => r.state === 'waiting-for-human').length;
	return `Live · ${rows.length}${waiting ? ` · ${waiting} waiting for you` : ''}`;
}

/** Rows shown before "+N more". */
export const LIVE_STRIP_CAP = 6;

/** Where the strip's collapsed state is remembered on this device. */
export const LIVE_STRIP_COLLAPSED_KEY = 'wherever-live-strip-collapsed';
