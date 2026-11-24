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
 *
 * Siblings are ordered like the fork tree: by the most recent `modified` in
 * their (kept) subtree, then their own `modified`, then path.
 */
import type {ForkTreeNodeInput} from './fork-tree';

/** The fields of a listed session (`SessionInfo`) the tree reads. */
export interface OwnerTreeSessionInput extends ForkTreeNodeInput {
	ownerSessionPath?: string;
	closed?: boolean;
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
}

export interface OwnerGroup<S extends OwnerTreeSessionInput> {
	root: OwnerTreeNode<S>;
	/** The most recent `modified` among the group's kept nodes. */
	latestActivity: string;
}

export interface OwnerTreeOptions<S> {
	/** Whether a session is shown on its own (closed + "Show closed", `isSessionShown`). */
	isVisible: (session: S) => boolean;
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
	{isVisible}: OwnerTreeOptions<S>,
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
	return roots
		.map(prune)
		.filter((g): g is NonNullable<typeof g> => g !== null)
		.sort(
			(a, b) =>
				b.latest.localeCompare(a.latest) ||
				a.node.session.path.localeCompare(b.node.session.path),
		)
		.map(({node, latest}) => ({root: node, latestActivity: latest}));
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
