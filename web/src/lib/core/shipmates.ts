/**
 * shipmates on the web (wherever ADR 0023): the shapes of the server's
 * `shipmates_update` frame, and the pure helpers the inbox panel, its badge and
 * the session list's presence line are built from.
 *
 * Every session is named by its normalized transcript path, the same string
 * the `/sessions` listing uses as `path`, so presence joins the list by that key.
 */

export type ShipmatesSessionState =
	| 'running'
	| 'waiting-for-human'
	| 'waiting-for-session'
	| 'idle';

export interface ShipmatesInboxItem {
	id: string;
	question: string;
	options: string[] | null;
	blocking: boolean;
	createdAt: number;
	sessionFile: string;
	sessionId: string | null;
	from: string;
	onBehalfOf: number;
}

export interface ShipmatesPresence {
	sessionFile: string;
	sessionId: string | null;
	roles: string[];
	state: ShipmatesSessionState;
	status: string | null;
	waitingOn: string | null;
}

/** A delete that took a session and everything it owns, undoable until `undoUntil` (shipmates D24). */
export interface ShipmatesArchive {
	batch: string;
	root: string;
	sessions: string[];
	at: number;
	undoUntil: number;
}

export interface ShipmatesState {
	available: boolean;
	inbox: ShipmatesInboxItem[];
	presence: ShipmatesPresence[];
	archives: ShipmatesArchive[];
}

export const emptyShipmatesState: ShipmatesState = {
	available: false,
	inbox: [],
	presence: [],
	archives: [],
};

/** A `shipmates_update` frame as the store keeps it; anything malformed reads as no shipmates. */
export function parseShipmatesUpdate(frame: unknown): ShipmatesState {
	const f = frame as Partial<ShipmatesState> | null | undefined;
	if (!f || f.available !== true) return emptyShipmatesState;
	return {
		available: true,
		inbox: Array.isArray(f.inbox)
			? f.inbox.filter(
					(i): i is ShipmatesInboxItem =>
						!!i && typeof i.id === 'string' && typeof i.question === 'string',
				)
			: [],
		presence: Array.isArray(f.presence)
			? f.presence.filter(
					(p): p is ShipmatesPresence =>
						!!p && typeof p.sessionFile === 'string',
				)
			: [],
		// Absent from an older server: none.
		archives: Array.isArray(f.archives)
			? f.archives.filter(
					(a): a is ShipmatesArchive =>
						!!a &&
						typeof a.batch === 'string' &&
						Array.isArray(a.sessions) &&
						typeof a.undoUntil === 'number',
				)
			: [],
	};
}

/**
 * The sessions each owner spawned, from the listing's `ownerSessionPath`
 * (shipmates D23), by owner path, in listing order. Owner and child may be in
 * different folders (a worktree), so this spans the whole listing.
 */
export function ownedChildren<
	T extends {path: string; ownerSessionPath?: string},
>(sessions: T[]): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const s of sessions) {
		if (!s.ownerSessionPath) continue;
		const list = out.get(s.ownerSessionPath) ?? [];
		list.push(s);
		out.set(s.ownerSessionPath, list);
	}
	return out;
}

/** Presence by session file, for the session list. */
export function presenceByFile(
	presence: ShipmatesPresence[],
): Map<string, ShipmatesPresence> {
	return new Map(presence.map((p) => [p.sessionFile, p]));
}

const STATE_LABEL: Record<ShipmatesSessionState, string> = {
	running: 'running',
	'waiting-for-human': 'waiting for you',
	'waiting-for-session': 'waiting on a session',
	idle: 'idle',
};

export function stateLabel(state: ShipmatesSessionState): string {
	return STATE_LABEL[state] ?? state;
}

/**
 * The one presence line under a session in the list: its role(s), its state
 * when that says something (idle says nothing), and its own status line.
 * Empty when there is nothing worth a line.
 */
export function presenceLine(p: ShipmatesPresence | undefined): string {
	if (!p) return '';
	const parts: string[] = [];
	if (p.roles.length) parts.push(p.roles.join(', '));
	if (p.state !== 'idle') parts.push(stateLabel(p.state));
	if (p.status) parts.push(p.status);
	return parts.join(' · ');
}

/** The badge: how many items, and whether any blocks a session. Null when the inbox is empty. */
export function inboxBadge(
	inbox: ShipmatesInboxItem[],
): {count: number; blocking: boolean} | null {
	if (!inbox.length) return null;
	return {count: inbox.length, blocking: inbox.some((i) => i.blocking)};
}

/**
 * The inbox count outside the page: the tab title's "(N) " prefix and the
 * installed app's icon badge. Both come from `shipmates_update` alone, so they
 * work without the assistant (its push channels are what reach a phone that
 * is not looking; see CONTEXT.md).
 */
export function inboxCount(state: ShipmatesState): number {
	return state.available ? state.inbox.length : 0;
}

/** `title` prefixed with "(N) " while N items wait; idempotent, so a prefixed title is re-counted, not doubled. */
export function titleWithInboxCount(title: string, count: number): string {
	const base = title.replace(/^\(\d+\) /, '');
	return count > 0 ? `(${count}) ${base}` : base;
}

/** The Badging API surface this needs (absent outside a secure context or on most desktop browsers). */
export interface AppBadgeNavigator {
	setAppBadge?: (count?: number) => Promise<void>;
	clearAppBadge?: () => Promise<void>;
}

/**
 * Show `count` on the app icon, or clear it at 0. A browser without the API
 * does nothing; a refusal (the app not installed, a denied permission) is
 * dropped, because the badge is a convenience the title already covers.
 */
export function syncAppBadge(
	nav: AppBadgeNavigator | undefined,
	count: number,
): void {
	if (!nav) return;
	const done =
		count > 0
			? nav.setAppBadge?.(count)
			: nav.clearAppBadge
				? nav.clearAppBadge()
				: nav.setAppBadge?.(0);
	done?.catch?.(() => {});
}
