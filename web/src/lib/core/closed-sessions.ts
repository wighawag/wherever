/**
 * Closed sessions in the sidebar's folder list (spec `closed-sessions`, ADR
 * 0025). `/sessions` always returns closed sessions; this is where the client
 * hides them. The rule lives ONLY in the folder-list path: the shared text
 * filter (`sessionMatchesFilter`) and the Live strip (`liveSessions`) stay
 * closed-agnostic, so a working closed session is always in the strip.
 *
 * Pure, so it is unit-tested here; `SessionBrowser.svelte` renders the result.
 */
import {sessionMatchesFilter, type LiveSessionLike} from './live-sessions';
import {
	buildForkTree,
	pruneForkTree,
	type ForkTreeNodeInput,
	type ForkTreeRow,
} from './fork-tree';

/** The fields of a listed session (`SessionInfo`) these helpers read. */
export interface ClosedSessionLike extends LiveSessionLike, ForkTreeNodeInput {
	closed?: boolean;
	starred?: boolean;
}

/** Where "Show closed" is remembered on this device (on when `'1'`). */
export const SHOW_CLOSED_KEY = 'wherever-show-closed';

/**
 * Where "Only starred" (the ☰ view options, spec `sidebar-compact-layout`
 * story 22) is remembered on this device (on when `'1'`). It filters the
 * folder list and the By-owner view, never the Live strip.
 */
export const ONLY_STARRED_KEY = 'wherever-only-starred';

/** Whether a session is listed: open ones always, closed ones only with "Show closed". */
export function isSessionShown(
	session: Pick<ClosedSessionLike, 'closed'>,
	showClosed: boolean,
): boolean {
	return showClosed || !session.closed;
}

/** The shown subset of a list (the owned-children chips under an owner row). */
export function shownSessions<S extends Pick<ClosedSessionLike, 'closed'>>(
	sessions: readonly S[],
	showClosed: boolean,
): S[] {
	return sessions.filter((s) => isSessionShown(s, showClosed));
}

export type FolderListEntry<
	F extends {sessions: S[]},
	S extends ForkTreeNodeInput,
> = F & {
	/** The fork tree to render. Closed rows in it are dimmed (context when hidden). */
	rows: ForkTreeRow<S>[];
	/** Shown sessions in the folder, not counting closed context rows. */
	shownCount: number;
};

/**
 * The folder list: each folder's text-matched sessions as a fork tree, closed
 * sessions pruned unless "Show closed" (a closed ancestor of a shown session
 * stays, as dimmed context). A folder is dropped when it has nothing shown,
 * except an empty folder with no query typed (`/sessions` keeps empty folders
 * on purpose). So a folder whose sessions are all closed disappears while
 * "Show closed" is off.
 *
 * `onlyStarred` ("Only starred") narrows the folder's sessions to the starred
 * ones BEFORE the fork tree is built, exactly like the text filter: a starred
 * fork of an unstarred session is listed on its own (no context row), and a
 * folder with no starred shown session is dropped, an empty one included.
 */
export function folderListView<
	S extends ClosedSessionLike,
	F extends {name: string; sessions: S[]},
>(
	folders: readonly F[],
	query: string,
	showClosed: boolean,
	onlyStarred = false,
): FolderListEntry<F, S>[] {
	const out: FolderListEntry<F, S>[] = [];
	for (const folder of folders) {
		const matched =
			query || onlyStarred
				? folder.sessions.filter(
						(s) =>
							(!onlyStarred || !!s.starred) &&
							(!query || sessionMatchesFilter(s, folder.name, query)),
					)
				: folder.sessions;
		const shown = (s: S) => isSessionShown(s, showClosed);
		const rows = pruneForkTree(buildForkTree(matched), shown);
		const shownCount = rows.filter((r) => shown(r.session)).length;
		const keepEmpty = !query && !onlyStarred && folder.sessions.length === 0;
		if (shownCount === 0 && !keepEmpty) continue;
		out.push({...folder, sessions: matched, rows, shownCount});
	}
	return out;
}
