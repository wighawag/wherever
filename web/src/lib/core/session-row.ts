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

/**
 * One entry of the row ⋯ menu (spec `sidebar-compact-layout` stories 29 to 31).
 * `separator` is the line before the red Delete….
 */
export type RowMenuItem =
	| 'close'
	| 'reopen'
	| 'star'
	| 'rename'
	| 'copy-link'
	| 'open-new-tab'
	| 'separator'
	| 'delete';

/**
 * The row ⋯ menu's items, in order: Close (Reopen on a closed row), Star /
 * Unstar, Rename, Copy link, Open in new tab (desktop only, where the menu is
 * a popover), then a separator and Delete…. The read-only page keeps only the
 * harmless ones: Star, Copy link, Open in new tab (no Rename).
 */
export function rowMenuItems(opts: {
	readOnly: boolean;
	closed: boolean;
	desktop: boolean;
}): RowMenuItem[] {
	const items: RowMenuItem[] = [];
	if (!opts.readOnly) items.push(opts.closed ? 'reopen' : 'close');
	items.push('star');
	if (!opts.readOnly) items.push('rename');
	items.push('copy-link');
	if (opts.desktop) items.push('open-new-tab');
	if (!opts.readOnly) items.push('separator', 'delete');
	return items;
}

/**
 * The one-click action a desktop hover shows beside ⋯: ⊘ Close on an open
 * row, ↺ Reopen on a closed one, nothing on the read-only page.
 */
export function rowHoverAction(opts: {
	readOnly: boolean;
	closed: boolean;
}): 'close' | 'reopen' | null {
	if (opts.readOnly) return null;
	return opts.closed ? 'reopen' : 'close';
}

/**
 * The hint beside the menu's Close when the close would cascade ("and 2
 * owned"); none while the `/sessions/owned` count has not answered
 * (`undefined`) or is 0.
 */
export function closeOwnedHint(n: number | undefined): string | undefined {
	return n ? `and ${n} owned` : undefined;
}

/**
 * The full URL that opens `sessionId` in this web app: the page's origin and
 * path (so a base path the app is served under is kept) and `#<session id>`.
 * The query is dropped on purpose (it may carry the auth `token`).
 */
export function sessionLinkUrl(
	loc: {origin: string; pathname: string},
	sessionId: string,
): string {
	return `${loc.origin}${loc.pathname || '/'}#${encodeURIComponent(sessionId)}`;
}

/**
 * A row's second line before its ★: "age · N msgs", plus "owns N" when the
 * session owns any (the ★, amber, is appended by the row when starred).
 */
export function rowMetaLine(
	session: {modified: string; messageCount: number},
	owns: number,
	now: number = Date.now(),
): string {
	const line = `${relativeTime(session.modified, now)} · ${session.messageCount} msgs`;
	return owns > 0 ? `${line} · owns ${owns}` : line;
}

/** The bottom sheet's second header line: "folder · age · N msgs". */
export function rowMenuHeaderMeta(
	session: {modified: string; messageCount: number},
	folder: string | undefined,
	now: number = Date.now(),
): string {
	const parts = [
		relativeTime(session.modified, now),
		`${session.messageCount} msgs`,
	];
	if (folder) parts.unshift(folder);
	return parts.join(' · ');
}
