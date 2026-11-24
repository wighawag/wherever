import {describe, it, expect} from 'vitest';
import {
	ownerTree,
	ownerGroupRows,
	ownerRowHint,
	ownerGroupExpanded,
	ownerGroupSummaryText,
	parseCollapsedGroups,
	serializeCollapsedGroups,
	toggleCollapsedGroup,
	parseSessionListView,
	sessionListViewState,
	type OwnerGroup,
	type OwnerTreeNode,
} from './owner-tree.js';

// The "By owner" sidebar view (spec `session-list-by-owner-view`, ADR 0026):
// ownership first, forks inside it, nested across folders.

type S = {
	path: string;
	modified: string;
	parentSessionPath?: string;
	ownerSessionPath?: string;
	closed?: boolean;
	name?: string;
	firstMessage?: string;
	isWorking?: boolean;
};

const s = (
	path: string,
	day: number,
	extra: Partial<Omit<S, 'path' | 'modified'>> = {},
): S => ({
	path,
	modified: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`,
	...extra,
});

const all = () => true;
const open = (x: S) => !x.closed;

/** One folder per argument list: `folder('a', [...])`. */
const folder = (name: string, sessions: S[]) => ({name, sessions});

/** Each group as indented lines, "<edge>" marking how a row hangs from its parent. */
function render(groups: OwnerGroup<S>[]): string[][] {
	return groups.map((g) =>
		ownerGroupRows(g).map(
			({node, depth}) =>
				`${'  '.repeat(depth)}${node.session.path}${node.edge ? ` <${node.edge}>` : ''}${node.ownerNotListed ? ' (not listed)' : ''}${node.closed ? ' [closed]' : ''}`,
		),
	);
}

function allPaths(groups: OwnerGroup<S>[]): string[] {
	const out: string[] = [];
	const walk = (n: OwnerTreeNode<S>) => {
		out.push(n.session.path);
		n.children.forEach(walk);
	};
	groups.forEach((g) => walk(g.root));
	return out;
}

describe('ownerTree', () => {
	it('makes every unrelated session a group of one, newest first', () => {
		const groups = ownerTree(
			[folder('f', [s('/a', 1), s('/b', 3), s('/c', 2)])],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([['/b'], ['/c'], ['/a']]);
		expect(groups[0].latestActivity).toBe('2026-01-03T00:00:00Z');
	});

	it('records each row folder', () => {
		const groups = ownerTree(
			[
				folder('main', [s('/o', 1)]),
				folder('wt', [s('/w', 2, {ownerSessionPath: '/o'})]),
			],
			{isVisible: all},
		);
		expect(groups[0].root.folderName).toBe('main');
		expect(groups[0].root.children[0].folderName).toBe('wt');
	});

	it('groups one orchestration across folders', () => {
		const groups = ownerTree(
			[
				folder('main', [s('/o', 1)]),
				folder('wt1', [s('/w1', 2, {ownerSessionPath: '/o'})]),
				folder('wt2', [s('/w2', 3, {ownerSessionPath: '/o'})]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([
			['/o', '  /w2 <spawned>', '  /w1 <spawned>'],
		]);
	});

	it('nests transitively', () => {
		const groups = ownerTree(
			[
				folder('f', [
					s('/sub', 3, {ownerSessionPath: '/w'}),
					s('/w', 2, {ownerSessionPath: '/o'}),
					s('/o', 1),
				]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([
			['/o', '  /w <spawned>', '    /sub <spawned>'],
		]);
	});

	it('nests an unowned fork of a worker under the worker', () => {
		const groups = ownerTree(
			[
				folder('main', [s('/o', 1)]),
				folder('wt', [
					s('/w', 2, {ownerSessionPath: '/o'}),
					s('/hand', 3, {parentSessionPath: '/w'}),
				]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([
			['/o', '  /w <spawned>', '    /hand <fork>'],
		]);
	});

	it('makes two unowned sessions where one forked the other one group', () => {
		const groups = ownerTree(
			[
				folder('a', [s('/p', 1)]),
				folder('b', [s('/f', 2, {parentSessionPath: '/p'})]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([['/p', '  /f <fork>']]);
	});

	it('nests an owned fork under its owner, not its fork parent', () => {
		const groups = ownerTree(
			[
				folder('f', [
					s('/o', 1),
					s('/x', 2),
					s('/w', 3, {ownerSessionPath: '/o', parentSessionPath: '/x'}),
				]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([['/o', '  /w <spawned>'], ['/x']]);
	});

	it('nests a same-owner sibling forked from another sibling under it', () => {
		const groups = ownerTree(
			[
				folder('f', [
					s('/o', 1),
					s('/a', 2, {ownerSessionPath: '/o'}),
					s('/b', 3, {ownerSessionPath: '/o', parentSessionPath: '/a'}),
				]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([['/o', '  /a <spawned>', '    /b <fork>']]);
	});

	it('makes a session whose owner is not listed a root, even with a listed fork parent', () => {
		const groups = ownerTree(
			[
				folder('f', [
					s('/p', 1),
					s('/w', 2, {ownerSessionPath: '/gone', parentSessionPath: '/p'}),
				]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([['/w (not listed)'], ['/p']]);
	});

	it('keeps two roots sharing an unlisted owner as roots even if one forked the other', () => {
		const groups = ownerTree(
			[
				folder('f', [
					s('/a', 1, {ownerSessionPath: '/gone'}),
					s('/b', 2, {ownerSessionPath: '/gone', parentSessionPath: '/a'}),
				]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([['/b (not listed)'], ['/a (not listed)']]);
	});

	it('never hides a rootless cycle, grouping it from the most recent member', () => {
		const sessions = [
			s('/a', 1, {ownerSessionPath: '/c'}),
			s('/b', 3, {ownerSessionPath: '/a'}),
			s('/c', 2, {ownerSessionPath: '/b'}),
			s('/z', 4),
		];
		const groups = ownerTree([folder('f', sessions)], {isVisible: all});
		// The walk starts at /b (newest); the edge back to /b is dropped.
		expect(render(groups)).toEqual([
			['/z'],
			['/b', '  /c <spawned>', '    /a <spawned>'],
		]);
		// Deterministic: the input order does not matter.
		const reversed = ownerTree([folder('f', [...sessions].reverse())], {
			isVisible: all,
		});
		expect(render(reversed)).toEqual(render(groups));
	});

	it('breaks a recency tie in a cycle by path', () => {
		const groups = ownerTree(
			[
				folder('f', [
					s('/y', 1, {parentSessionPath: '/x'}),
					s('/x', 1, {parentSessionPath: '/y'}),
				]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([['/x', '  /y <fork>']]);
	});

	it('shows a session that owns itself once, as a root', () => {
		const groups = ownerTree(
			[
				folder('f', [
					s('/me', 2, {ownerSessionPath: '/me'}),
					s('/w', 1, {ownerSessionPath: '/me'}),
				]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([['/me', '  /w <spawned>']]);
	});

	it('emits every listed session exactly once', () => {
		const sessions = [
			s('/o', 1),
			s('/w1', 2, {ownerSessionPath: '/o'}),
			s('/w2', 3, {ownerSessionPath: '/o', parentSessionPath: '/w1'}),
			s('/h', 4, {parentSessionPath: '/w2'}),
			s('/u', 5, {ownerSessionPath: '/gone', parentSessionPath: '/o'}),
			s('/c1', 6, {ownerSessionPath: '/c2'}),
			s('/c2', 7, {parentSessionPath: '/c1'}),
			s('/self', 8, {parentSessionPath: '/self'}),
			s('/f1', 9, {ownerSessionPath: '/o', parentSessionPath: '/f2'}),
			s('/f2', 9, {ownerSessionPath: '/o', parentSessionPath: '/f1'}),
		];
		const groups = ownerTree(
			[folder('a', sessions.slice(0, 5)), folder('b', sessions.slice(5))],
			{isVisible: all},
		);
		const paths = allPaths(groups);
		expect(new Set(paths).size).toBe(paths.length);
		expect([...paths].sort()).toEqual(sessions.map((x) => x.path).sort());
	});

	it('lists a path that appears in two folders once', () => {
		const groups = ownerTree(
			[folder('a', [s('/x', 1)]), folder('b', [s('/x', 1)])],
			{isVisible: all},
		);
		expect(allPaths(groups)).toEqual(['/x']);
		expect(groups[0].root.folderName).toBe('a');
	});

	it('orders groups by the latest activity anywhere in the group', () => {
		const groups = ownerTree(
			[
				folder('f', [
					s('/fresh', 5),
					s('/old', 1),
					s('/w', 2, {ownerSessionPath: '/old'}),
					s('/deep', 9, {ownerSessionPath: '/w'}),
				]),
			],
			{isVisible: all},
		);
		expect(render(groups)).toEqual([
			['/old', '  /w <spawned>', '    /deep <spawned>'],
			['/fresh'],
		]);
		expect(groups[0].latestActivity).toBe('2026-01-09T00:00:00Z');
	});

	it('breaks a group recency tie by root path', () => {
		const groups = ownerTree([folder('f', [s('/b', 1), s('/a', 1)])], {
			isVisible: all,
		});
		expect(render(groups)).toEqual([['/a'], ['/b']]);
	});

	describe('closed sessions', () => {
		it('keeps a closed owner of an open child as dimmed context', () => {
			const groups = ownerTree(
				[
					folder('f', [
						s('/o', 1, {closed: true}),
						s('/w', 2, {ownerSessionPath: '/o'}),
					]),
				],
				{isVisible: open},
			);
			expect(render(groups)).toEqual([['/o [closed]', '  /w <spawned>']]);
		});

		it('prunes a closed node with no visible descendant', () => {
			const groups = ownerTree(
				[
					folder('f', [
						s('/o', 1),
						s('/w', 2, {ownerSessionPath: '/o', closed: true}),
						s('/x', 3, {ownerSessionPath: '/w', closed: true}),
					]),
				],
				{isVisible: open},
			);
			expect(render(groups)).toEqual([['/o']]);
			// A pruned closed node does not count toward the group's activity.
			expect(groups[0].latestActivity).toBe('2026-01-01T00:00:00Z');
		});

		it('hides a group whose members are all closed', () => {
			const groups = ownerTree(
				[
					folder('f', [
						s('/o', 1, {closed: true}),
						s('/w', 2, {ownerSessionPath: '/o', closed: true}),
						s('/k', 3),
					]),
				],
				{isVisible: open},
			);
			expect(render(groups)).toEqual([['/k']]);
		});

		it('shows closed sessions dimmed when they are visible ("Show closed")', () => {
			const groups = ownerTree(
				[
					folder('f', [
						s('/o', 1),
						s('/w', 2, {ownerSessionPath: '/o', closed: true}),
					]),
				],
				{isVisible: all},
			);
			expect(render(groups)).toEqual([['/o', '  /w <spawned> [closed]']]);
		});

		it('nests before hiding: a hidden closed parent never turns its children into roots', () => {
			const groups = ownerTree(
				[
					folder('f', [
						s('/p', 1, {closed: true}),
						s('/q', 2, {parentSessionPath: '/p', closed: true}),
						s('/r', 3, {parentSessionPath: '/q'}),
					]),
				],
				{isVisible: open},
			);
			expect(render(groups)).toEqual([
				['/p [closed]', '  /q <fork> [closed]', '    /r <fork>'],
			]);
		});
	});
});

describe('ownerRowHint', () => {
	const label = (p: string) => `label of ${p}`;
	const groups = ownerTree(
		[
			folder('f', [
				s('/o', 1),
				s('/a', 2, {ownerSessionPath: '/o'}),
				s('/b', 3, {ownerSessionPath: '/o', parentSessionPath: '/a'}),
				s('/u', 4, {ownerSessionPath: '/gone'}),
			]),
		],
		{isVisible: all},
	);
	const hints = Object.fromEntries(
		groups
			.flatMap(ownerGroupRows)
			.map(({node}) => [node.session.path, ownerRowHint(node, label)]),
	);

	it('names no owner on a row nested right under it, or on an unowned row', () => {
		expect(hints['/a']).toBeUndefined();
		expect(hints['/o']).toBeUndefined();
	});

	it('names the owner of a sibling fork, whose parent row is not its owner', () => {
		expect(hints['/b']).toBe('label of /o');
	});

	it('says "(not listed)" for an unlisted owner', () => {
		expect(hints['/u']).toBe('(not listed)');
	});
});

describe('session list view toggle', () => {
	it('parses the saved choice, defaulting to "By folder"', () => {
		expect(parseSessionListView('owner')).toBe('owner');
		expect(parseSessionListView('folder')).toBe('folder');
		expect(parseSessionListView(null)).toBe('folder');
		expect(parseSessionListView('garbage')).toBe('folder');
	});

	it('shows the toggle only with shipmates and at least one owned session', () => {
		const owned = [{ownerSessionPath: '/o'}, {}];
		const none = [{}, {}];
		expect(
			sessionListViewState('folder', {
				shipmatesAvailable: true,
				sessions: owned,
			}),
		).toEqual({showToggle: true, view: 'folder'});
		expect(
			sessionListViewState('owner', {
				shipmatesAvailable: true,
				sessions: owned,
			}),
		).toEqual({showToggle: true, view: 'owner'});
		expect(
			sessionListViewState('folder', {
				shipmatesAvailable: false,
				sessions: owned,
			}).showToggle,
		).toBe(false);
		expect(
			sessionListViewState('folder', {
				shipmatesAvailable: true,
				sessions: none,
			}).showToggle,
		).toBe(false);
	});

	it('falls back to "By folder" when the toggle is hidden, without touching the saved choice', () => {
		const saved = 'owner' as const;
		const state = sessionListViewState(saved, {
			shipmatesAvailable: false,
			sessions: [{ownerSessionPath: '/o'}],
		});
		expect(state).toEqual({showToggle: false, view: 'folder'});
		expect(saved).toBe('owner');
		// Once meaningful again, the saved choice comes back.
		expect(
			sessionListViewState(saved, {
				shipmatesAvailable: true,
				sessions: [{ownerSessionPath: '/o'}],
			}).view,
		).toBe('owner');
	});
});

describe('ownerTree summary and attention', () => {
	const presence = new Map([
		['/o', {state: 'running' as const}],
		['/w1', {state: 'waiting-for-human' as const}],
		['/w2', {state: 'waiting-for-session' as const}],
		['/w3', {state: 'idle' as const}],
	]);

	it('counts one live state per visible member', () => {
		const [g] = ownerTree(
			[
				folder('f', [
					s('/o', 1),
					s('/w1', 2, {ownerSessionPath: '/o'}),
					s('/w2', 3, {ownerSessionPath: '/o'}),
					s('/w3', 4, {ownerSessionPath: '/o'}),
					s('/w4', 5, {ownerSessionPath: '/o', isWorking: true}),
				]),
			],
			{isVisible: all, presence},
		);
		expect(g.summary).toEqual({
			sessions: 5,
			running: 2,
			waitingForHuman: 1,
			waitingForSession: 1,
			idle: 1,
		});
		expect(g.hasWaitingForHuman).toBe(true);
	});

	it('does not count a closed row kept only as context', () => {
		const [g] = ownerTree(
			[
				folder('f', [
					s('/o', 1, {closed: true}),
					s('/w1', 2, {ownerSessionPath: '/o', closed: true}),
					s('/w2', 3, {ownerSessionPath: '/o'}),
				]),
			],
			{isVisible: open, presence},
		);
		expect(render([g])).toEqual([['/o [closed]', '  /w2 <spawned>']]);
		expect(g.summary.sessions).toBe(1);
		expect(g.summary.waitingForHuman).toBe(0);
		expect(g.hasWaitingForHuman).toBe(false);
	});

	it('counts everything idle without presence', () => {
		const [g] = ownerTree([folder('f', [s('/o', 1)])], {isVisible: all});
		expect(g.summary).toEqual({
			sessions: 1,
			running: 0,
			waitingForHuman: 0,
			waitingForSession: 0,
			idle: 1,
		});
	});

	it('words the summary, leaving out zero counts and idle', () => {
		expect(
			ownerGroupSummaryText({
				sessions: 5,
				running: 2,
				waitingForHuman: 1,
				waitingForSession: 1,
				idle: 1,
			}),
		).toBe(
			'5 sessions · 2 running · 1 waiting for you · 1 waiting on a session',
		);
		expect(
			ownerGroupSummaryText({
				sessions: 1,
				running: 0,
				waitingForHuman: 0,
				waitingForSession: 0,
				idle: 1,
			}),
		).toBe('1 session');
	});
});

describe('ownerTree filter', () => {
	const tree = () => [
		folder('main', [
			s('/o', 1, {name: 'orchestrator'}),
			s('/w1', 2, {ownerSessionPath: '/o', name: 'alpha worker'}),
			s('/w2', 3, {ownerSessionPath: '/w1', name: 'beta'}),
			s('/x', 4, {name: 'unrelated'}),
		]),
	];

	it('marks every visible node matched, and no group hasMatch, without a filter', () => {
		const groups = ownerTree(tree(), {isVisible: all});
		expect(groups.every((g) => !g.hasMatch)).toBe(true);
		expect(
			groups.flatMap((g) => ownerGroupRows(g)).every((r) => r.node.matched),
		).toBe(true);
	});

	it('keeps a match with its ancestors as context, drops other members and groups', () => {
		const groups = ownerTree(tree(), {isVisible: all, filter: 'BETA'});
		expect(render(groups)).toEqual([
			['/o', '  /w1 <spawned>', '    /w2 <spawned>'],
		]);
		const rows = ownerGroupRows(groups[0]).map((r) => [
			r.node.session.path,
			r.node.matched,
		]);
		expect(rows).toEqual([
			['/o', false],
			['/w1', false],
			['/w2', true],
		]);
		expect(groups[0].hasMatch).toBe(true);
	});

	it('drops non-matching descendants of a match', () => {
		const groups = ownerTree(tree(), {isVisible: all, filter: 'alpha'});
		expect(render(groups)).toEqual([['/o', '  /w1 <spawned>']]);
	});

	it('matches the folder name like the folder view', () => {
		const groups = ownerTree(
			[folder('main', [s('/a', 1)]), folder('other', [s('/b', 2)])],
			{isVisible: all, filter: 'oth'},
		);
		expect(render(groups)).toEqual([['/b']]);
	});

	it('never matches a hidden closed session', () => {
		const groups = ownerTree(
			[
				folder('f', [
					s('/o', 1, {name: 'head'}),
					s('/w', 2, {ownerSessionPath: '/o', name: 'needle', closed: true}),
				]),
			],
			{isVisible: open, filter: 'needle'},
		);
		expect(groups).toEqual([]);
	});

	it('keeps the summary of the whole group while filtering', () => {
		const [g] = ownerTree(tree(), {isVisible: all, filter: 'beta'});
		expect(g.summary.sessions).toBe(3);
	});
});

describe('collapsed groups', () => {
	it('parses a saved list, ignoring garbage', () => {
		expect([...parseCollapsedGroups('["/a","/b"]')]).toEqual(['/a', '/b']);
		expect(parseCollapsedGroups(null).size).toBe(0);
		expect(parseCollapsedGroups('nope').size).toBe(0);
		expect(parseCollapsedGroups('{"a":1}').size).toBe(0);
		expect([...parseCollapsedGroups('["/a",3]')]).toEqual(['/a']);
	});

	it('round-trips through storage (survives a reload)', () => {
		const saved = serializeCollapsedGroups(
			toggleCollapsedGroup(new Set(), '/a'),
			new Set(['/a']),
		);
		expect([...parseCollapsedGroups(saved)]).toEqual(['/a']);
	});

	it('toggles without mutating the input', () => {
		const before = new Set(['/a']);
		const after = toggleCollapsedGroup(before, '/a');
		expect(after.has('/a')).toBe(false);
		expect(before.has('/a')).toBe(true);
		expect(toggleCollapsedGroup(after, '/a').has('/a')).toBe(true);
	});

	it('forgets sessions no longer listed when saving', () => {
		expect(
			serializeCollapsedGroups(new Set(['/a', '/gone']), new Set(['/a', '/b'])),
		).toBe('["/a"]');
	});

	it('expands a group unless it is saved collapsed', () => {
		expect(ownerGroupExpanded({hasMatch: false}, new Set(), '/a')).toBe(true);
		expect(ownerGroupExpanded({hasMatch: false}, new Set(['/a']), '/a')).toBe(
			false,
		);
	});

	it('expands a collapsed group holding a filter match, without changing the saved state', () => {
		const collapsed = new Set(['/a']);
		expect(ownerGroupExpanded({hasMatch: true}, collapsed, '/a')).toBe(true);
		expect(collapsed.has('/a')).toBe(true);
		// Filter cleared: back to the saved state.
		expect(ownerGroupExpanded({hasMatch: false}, collapsed, '/a')).toBe(false);
	});
});
