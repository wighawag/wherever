// Pure helpers for `SessionRow.svelte`, the sidebar session row shared by the
// folder view and (spec `session-list-by-owner-view`) the By-owner view. The
// component only renders; anything that computes text lives here, tested.
import {truncateLabel, type LiveSessionLike} from './live-sessions';

/** "just now", "5m ago", "3h ago", "2d ago": the row's last-activity text. */
export function relativeTime(
	timeStr: string,
	now: number = Date.now(),
): string {
	const diff = now - new Date(timeStr).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** An owned-children chip's label: name, else first-message preview, else "session". */
export function ownedChipLabel(
	session: Pick<LiveSessionLike, 'name' | 'firstMessage'>,
): string {
	return session.name || truncateLabel(session.firstMessage || '') || 'session';
}

/**
 * What a nested row (depth > 0) hangs from: `fork` in the folder view (the
 * session above it is its fork parent), `spawned` in the By-owner view (the
 * session above it spawned it).
 */
export type RowNestKind = 'fork' | 'spawned';

/** The "↳" marker's tooltip and accessible name for a nested row. */
export function rowNestMarker(kind: RowNestKind): {
	title: string;
	ariaLabel: string;
} {
	return kind === 'spawned'
		? {title: 'Spawned by the session above', ariaLabel: 'Spawned session'}
		: {title: 'Forked from the session above', ariaLabel: 'Forked session'};
}
