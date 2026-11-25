/**
 * The sidebar's "By owner" view (spec `session-list-by-owner-view`, ADR
 * `0026-the-by-owner-view-nests-by-ownership-first-and-forks-inside-it`): every
 * orchestration as ONE tree across folders, plus the "By folder / By owner"
 * toggle's pure state. `SessionBrowser.svelte` only renders the result.
 *
 * Placement (one parent per session, so the graph is a set of trees plus
 * possibly cycles):
 * 1. A listed owner (`ownerSessionPath`) wins: nest under it (edge `spawned`).
 * 2. An owner set but NOT listed: a root marked "(not listed)"; its fork
 *    parent is ignored.
 * 3. No owner: nest under the fork parent (`parentSessionPath`) when it is
 *    listed, wherever that parent sits (edge `fork`).
 * 4. The one exception to rule 1, only under a LISTED owner: a session whose
 *    fork parent is a sibling (same direct owner) nests under that sibling
 *    (edge `fork`). A fork parent outside the sibling set is ignored.
 * 5. Anything else is a root; groups are ordered by the latest `modified`
 *    anywhere in the group, then root path.
 * 6. Cycles: sessions no root reaches are walked in recency order (`modified`
 *    desc, then path), each walk starting a group; an edge back to a visited
 *    node is dropped. Unlike `buildForkTree`'s safety net (unreached sessions
 *    appended flat in input order), so a cycle keeps its shape.
 * 7. Closed visibility is applied AFTER nesting: a node that is not visible
 *    and has no visible descendant is pruned, a kept closed node is dimmed
 *    context, and a group with nothing visible disappears. (Not the folder
 *    view's flat `pruneForkTree`, which works on depth-ordered rows.)
 * 8. The summary (`summary`, `hasWaitingForHuman`) is counted over the nodes
 *    still VISIBLE after rule 7 (a closed node kept only as context is not
 *    counted), one `sessionLiveState` per session, and BEFORE the filter: it
 *    describes the whole orchestration, not the rows the filter leaves.
 * 9. The sidebar filter (`sessionMatchesFilter`, the folder view's rule) runs
 *    after rule 7, so only a visible node can match. A matching node is kept
 *    with its ancestors (non-matching ones are dimmed context, `matched`
 *    false); its non-matching descendants are dropped, as in the folder view;
 *    a group with no match disappears. `hasMatch` is true only while a filter
 *    is set and the group holds a match: it is what forces the group open
 *    (`ownerGroupExpanded`). Group order stays the rule 5 order of the whole
 *    group, so typing a filter never reshuffles the groups it keeps.
 * 10. "Only starred" (`onlyStarred`, spec `sidebar-compact-layout` story 22)
 *    is part of the rule 9 match: a node matches only when it is also
 *    starred, so an unstarred ancestor of a starred session stays as dimmed
 *    context and a group with no starred match disappears. Like rule 9 it
 *    leaves the summary (rule 8) whole; unlike the text filter it does not set
 *    `hasMatch`, so it never forces a group open (the folder view does not
 *    open folders for it either).
 *
 * Siblings are ordered like the fork tree: by the most recent `modified` in
 * their (kept) subtree, then their own `modified`, then path.
 */
import type {ForkTreeNodeInput} from './fork-tree';
import {sessionLiveState, sessionMatchesFilter} from './live-sessions';
import {stateLabel, type ShipmatesPresence} from './shipmates';
import {liveCountDots} from './state-dot';

/** The fields of a listed session (`SessionInfo`) the tree reads. */
export interface OwnerTreeSessionInput extends ForkTreeNodeInput {
	ownerSessionPath?: string;
	closed?: boolean;
	name?: string;
	firstMessage?: string;
	isWorking?: boolean;
	starred?: boolean;
}

/** How a nested node hangs from the node above it; null on a group's root. */
export type OwnerTreeEdge = 'spawned' | 'fork';

export interface OwnerTreeNode<S extends OwnerTreeSessionInput> {
	session: S;
	/** The folder the session is listed under (the row's folder tag). */
	folderName: string;
	children: OwnerTreeNode<S>[];
	/** The session is closed: render it dimmed (shown, or kept as context). */
	closed: boolean;
	edge: OwnerTreeEdge | null;
	/** Rule 2: its owner is set but not in the listing. */
	ownerNotListed: boolean;
	/**
	 * Rule 9: visible and matching the filter (every visible node when the
	 * filter is empty). False on a node kept only as context: render it dimmed.
	 */
	matched: boolean;
}

/** A group's members by live state (rule 8). */
export interface OwnerGroupSummary {
	sessions: number;
	running: number;
	waitingForHuman: number;
	waitingForSession: number;
	idle: number;
}

export interface OwnerGroup<S extends OwnerTreeSessionInput> {
	root: OwnerTreeNode<S>;
	/** The most recent `modified` among the group's kept nodes (before the filter). */
	latestActivity: string;
	summary: OwnerGroupSummary;
	/** `summary.waitingForHuman > 0`: the head is highlighted, even collapsed. */
	hasWaitingForHuman: boolean;
	/** A filter is set and the group holds a match (rule 9). */
	hasMatch: boolean;
}

export interface OwnerTreeOptions<S> {
	/** Whether a session is shown on its own (closed + "Show closed", `isSessionShown`). */
	isVisible: (session: S) => boolean;
	/** The sidebar filter text; empty (or omitted) matches everything. */
	filter?: string;
	/** "Only starred" (rule 10): only starred sessions match. */
	onlyStarred?: boolean;
	/** shipmates presence by session path, for the summary's live states. */
	presence?: ReadonlyMap<string, Pick<ShipmatesPresence, 'state'>>;
}

/** Recency order: `modified` desc, then path. */
function byRecency(a: {modified: string; path: string}, b: typeof a): number {
	return (
		(b.modified ?? '').localeCompare(a.modified ?? '') ||
		a.path.localeCompare(b.path)
	);
}

/**
 * Build the By-owner groups over the FULL listing (closed sessions included):
 * every listed session appears at most once, and exactly once unless pruned
 * by rule 7. A path listed in two folders is taken from the first.
 */
export function ownerTree<S extends OwnerTreeSessionInput>(
	folders: readonly {name: string; sessions: readonly S[]}[],
	{isVisible, filter = '', onlyStarred = false, presence}: OwnerTreeOptions<S>,
): OwnerGroup<S>[] {
	const byPath = new Map<string, {session: S; folderName: string}>();
	for (const f of folders)
		for (const session of f.sessions)
			if (!byPath.has(session.path))
				byPath.set(session.path, {session, folderName: f.name});

	// Each session's single parent (rules 1 to 4), and its children.
	const parentOf = new Map<string, {path: string; edge: OwnerTreeEdge}>();
	const notListed = new Set<string>();
	const childrenOf = new Map<string, S[]>();
	for (const {session} of byPath.values()) {
		const owner = session.ownerSessionPath;
		const fork = session.parentSessionPath;
		let parent: {path: string; edge: OwnerTreeEdge} | null = null;
		if (owner) {
			if (!byPath.has(owner)) notListed.add(session.path);
			else {
				const forkParent = fork ? byPath.get(fork)?.session : undefined;
				parent =
					forkParent &&
					forkParent.path !== session.path &&
					forkParent.ownerSessionPath === owner
						? {path: forkParent.path, edge: 'fork'}
						: {path: owner, edge: 'spawned'};
			}
		} else if (fork && byPath.has(fork)) {
			parent = {path: fork, edge: 'fork'};
		}
		if (!parent) continue;
		parentOf.set(session.path, parent);
		const list = childrenOf.get(parent.path) ?? [];
		list.push(session);
		childrenOf.set(parent.path, list);
	}

	// Walk from every root, then (rule 6) from unreached sessions by recency.
	const visited = new Set<string>();
	const walk = (session: S, isRoot: boolean): OwnerTreeNode<S> => {
		visited.add(session.path);
		const children: OwnerTreeNode<S>[] = [];
		for (const child of childrenOf.get(session.path) ?? [])
			if (!visited.has(child.path)) children.push(walk(child, false));
		return {
			session,
			folderName: byPath.get(session.path)!.folderName,
			children,
			closed: !!session.closed,
			edge: isRoot ? null : (parentOf.get(session.path)?.edge ?? null),
			ownerNotListed: notListed.has(session.path),
			matched: false,
		};
	};
	const all = [...byPath.values()].map((e) => e.session).sort(byRecency);
	const roots: OwnerTreeNode<S>[] = [];
	for (const session of all)
		if (!parentOf.has(session.path)) roots.push(walk(session, true));
	for (const session of all)
		if (!visited.has(session.path)) roots.push(walk(session, true));

	// Rule 7, then order siblings and groups by their kept subtree's recency.
	const prune = (
		node: OwnerTreeNode<S>,
	): {node: OwnerTreeNode<S>; latest: string} | null => {
		const kept = node.children
			.map(prune)
			.filter((c): c is NonNullable<typeof c> => c !== null);
		if (!kept.length && !isVisible(node.session)) return null;
		kept.sort(
			(a, b) =>
				b.latest.localeCompare(a.latest) ||
				byRecency(a.node.session, b.node.session),
		);
		let latest = node.session.modified ?? '';
		for (const c of kept)
			if (c.latest.localeCompare(latest) > 0) latest = c.latest;
		return {node: {...node, children: kept.map((c) => c.node)}, latest};
	};
	// Rule 8: count the visible nodes of a closed-pruned group.
	const summarize = (root: OwnerTreeNode<S>): OwnerGroupSummary => {
		const sum: OwnerGroupSummary = {
			sessions: 0,
			running: 0,
			waitingForHuman: 0,
			waitingForSession: 0,
			idle: 0,
		};
		const walk = (node: OwnerTreeNode<S>) => {
			if (isVisible(node.session)) {
				sum.sessions++;
				const state = sessionLiveState(
					node.session,
					presence?.get(node.session.path),
				);
				if (state === 'waiting-for-human') sum.waitingForHuman++;
				else if (state === 'waiting-for-session') sum.waitingForSession++;
				else if (state === 'running') sum.running++;
				else sum.idle++;
			}
			node.children.forEach(walk);
		};
		walk(root);
		return sum;
	};
	// Rules 9 and 10: mark matches, keep their ancestors, drop the rest.
	const matchPrune = (node: OwnerTreeNode<S>): OwnerTreeNode<S> | null => {
		const matched =
			isVisible(node.session) &&
			(!onlyStarred || !!node.session.starred) &&
			sessionMatchesFilter(
				{
					name: node.session.name,
					firstMessage: node.session.firstMessage ?? '',
				},
				node.folderName,
				filter,
			);
		const kept = node.children
			.map(matchPrune)
			.filter((c): c is OwnerTreeNode<S> => c !== null);
		if (!matched && !kept.length) return null;
		return {...node, matched, children: kept};
	};
	return roots
		.map(prune)
		.filter((g): g is NonNullable<typeof g> => g !== null)
		.sort(
			(a, b) =>
				b.latest.localeCompare(a.latest) ||
				a.node.session.path.localeCompare(b.node.session.path),
		)
		.flatMap(({node, latest}) => {
			const filtered = matchPrune(node);
			if (!filtered) return [];
			const summary = summarize(node);
			return [
				{
					root: filtered,
					latestActivity: latest,
					summary,
					hasWaitingForHuman: summary.waitingForHuman > 0,
					// A group matchPrune keeps holds a match by construction.
					hasMatch: !!filter,
				},
			];
		});
}

/**
 * A collapsed group's summary: "5 sessions · 2 running · 1 waiting for you ·
 * 1 waiting on a session". Zero counts are left out, and so is idle (the
 * rest of the sessions).
 */
export function ownerGroupSummaryText(summary: OwnerGroupSummary): string {
	const parts = [ownerGroupSessionsText(summary)];
	if (summary.running)
		parts.push(`${summary.running} ${stateLabel('running')}`);
	if (summary.waitingForHuman)
		parts.push(`${summary.waitingForHuman} ${stateLabel('waiting-for-human')}`);
	if (summary.waitingForSession)
		parts.push(
			`${summary.waitingForSession} ${stateLabel('waiting-for-session')}`,
		);
	return parts.join(' · ');
}

/** The session count of a collapsed group's summary: "5 sessions". */
export function ownerGroupSessionsText(summary: OwnerGroupSummary): string {
	return `${summary.sessions} ${summary.sessions === 1 ? 'session' : 'sessions'}`;
}

/**
 * A collapsed group's live-state counts as state dots (spec
 * `sidebar-compact-layout` story 4): the non-zero live counts in need order,
 * like the collapsed Live strip. Idle is left out, as in the text.
 */
export function ownerGroupSummaryDots(summary: OwnerGroupSummary) {
	return liveCountDots({
		'waiting-for-human': summary.waitingForHuman,
		'waiting-for-session': summary.waitingForSession,
		running: summary.running,
	});
}

/**
 * Where the collapsed By-owner groups are remembered on this device: a JSON
 * array of the root session paths of the collapsed groups (a group is
 * expanded unless listed).
 */
export const OWNER_GROUPS_COLLAPSED_KEY = 'wherever-owner-groups-collapsed';

/** The saved collapsed groups; anything unreadable is none. */
export function parseCollapsedGroups(
	raw: string | null | undefined,
): Set<string> {
	if (!raw) return new Set();
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return new Set();
		return new Set(value.filter((v): v is string => typeof v === 'string'));
	} catch {
		return new Set();
	}
}

/**
 * The value to save: the collapsed groups whose root is still listed, so the
 * entry does not grow forever with deleted sessions.
 */
export function serializeCollapsedGroups(
	collapsed: ReadonlySet<string>,
	listed: ReadonlySet<string>,
): string {
	return JSON.stringify([...collapsed].filter((p) => listed.has(p)));
}

/** Collapse an expanded group or expand a collapsed one (a new set). */
export function toggleCollapsedGroup(
	collapsed: ReadonlySet<string>,
	rootPath: string,
): Set<string> {
	const next = new Set(collapsed);
	if (next.has(rootPath)) next.delete(rootPath);
	else next.add(rootPath);
	return next;
}

/**
 * Whether a group renders expanded: it is not saved collapsed, OR the filter
 * is set and the group holds a match (the analogue of the folder view showing
 * folders open while filtering). The saved state is only read, so typing a
 * filter never changes it; clearing the filter restores it.
 */
export function ownerGroupExpanded(
	group: Pick<OwnerGroup<OwnerTreeSessionInput>, 'hasMatch'>,
	collapsed: ReadonlySet<string>,
	rootPath: string,
): boolean {
	return group.hasMatch || !collapsed.has(rootPath);
}

/** A group's nodes depth-first, with their depth (the rows to render). */
export function ownerGroupRows<S extends OwnerTreeSessionInput>(
	group: OwnerGroup<S>,
): {node: OwnerTreeNode<S>; depth: number}[] {
	const out: {node: OwnerTreeNode<S>; depth: number}[] = [];
	const walk = (node: OwnerTreeNode<S>, depth: number) => {
		out.push({node, depth});
		for (const c of node.children) walk(c, depth + 1);
	};
	walk(group.root, 0);
	return out;
}

/**
 * The "↳ spawned by <owner>" text for a By-owner row, or undefined for none.
 * "(not listed)" for rule 2. A row hanging from its owner (edge `spawned`)
 * gets none: the row above IS the owner, and the "↳" marker already says so.
 * A row whose parent is not its owner (a sibling fork under rule 4, or a cycle
 * walk's root) still names it.
 */
export function ownerRowHint<S extends OwnerTreeSessionInput>(
	node: OwnerTreeNode<S>,
	labelOf: (path: string) => string,
): string | undefined {
	if (node.ownerNotListed) return '(not listed)';
	const owner = node.session.ownerSessionPath;
	if (!owner || node.edge === 'spawned') return undefined;
	return labelOf(owner);
}

/** The main session list's layout: "By folder" (the default) or "By owner". */
export type SessionListView = 'folder' | 'owner';

/** Where the chosen layout is remembered on this device. */
export const SESSION_LIST_VIEW_KEY = 'wherever-session-list-view';

/** A saved layout; anything unknown (or nothing saved) is "By folder". */
export function parseSessionListView(
	raw: string | null | undefined,
): SessionListView {
	return raw === 'owner' ? 'owner' : 'folder';
}

/**
 * Whether the toggle is offered and which layout renders. "By owner" means
 * nothing without shipmates or without a single owned session, so the toggle
 * is hidden then and the list shows "By folder"; the saved choice is left as
 * it is (the caller never writes it here), so it returns once owners do.
 */
export function sessionListViewState(
	saved: SessionListView,
	{
		shipmatesAvailable,
		sessions,
	}: {
		shipmatesAvailable: boolean;
		sessions: readonly {ownerSessionPath?: string}[];
	},
): {showToggle: boolean; view: SessionListView} {
	const showToggle =
		shipmatesAvailable && sessions.some((s) => !!s.ownerSessionPath);
	return {showToggle, view: showToggle ? saved : 'folder'};
}
