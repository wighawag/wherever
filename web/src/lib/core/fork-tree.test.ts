import {describe, it, expect} from 'vitest';
import {buildForkTree, pruneForkTree} from './fork-tree.js';

// Regression: the sidebar ordered fork groups by the ROOT session's own
// `modified`, so a session forked days ago and worked on all morning sat far
// down the list under its stale parent. A group must rank by its most recent
// message ACROSS the fork tree.

type S = {path: string; modified: string; parentSessionPath?: string};

const s = (path: string, modified: string, parentSessionPath?: string): S => ({
	path,
	modified,
	...(parentSessionPath ? {parentSessionPath} : {}),
});

const flat = (rows: {session: S; depth: number}[]) =>
	rows.map((r) => `${'  '.repeat(r.depth)}${r.session.path}`);

describe('buildForkTree', () => {
	it('nests a fork under its parent', () => {
		const rows = buildForkTree([
			s('/a.jsonl', '2026-01-01T00:00:00Z'),
			s('/b.jsonl', '2026-01-02T00:00:00Z', '/a.jsonl'),
		]);
		expect(flat(rows)).toEqual(['/a.jsonl', '  /b.jsonl']);
	});

	it('ranks a group by its newest fork, not by the root', () => {
		// Old root with a very active fork must beat a newer standalone session.
		const rows = buildForkTree([
			s('/fresh.jsonl', '2026-01-05T00:00:00Z'),
			s('/old-root.jsonl', '2026-01-01T00:00:00Z'),
			s('/active-fork.jsonl', '2026-01-09T00:00:00Z', '/old-root.jsonl'),
		]);
		expect(flat(rows)).toEqual([
			'/old-root.jsonl',
			'  /active-fork.jsonl',
			'/fresh.jsonl',
		]);
	});

	it('propagates recency through a deep fork chain', () => {
		const rows = buildForkTree([
			s('/fresh.jsonl', '2026-01-05T00:00:00Z'),
			s('/root.jsonl', '2026-01-01T00:00:00Z'),
			s('/mid.jsonl', '2026-01-02T00:00:00Z', '/root.jsonl'),
			s('/leaf.jsonl', '2026-01-10T00:00:00Z', '/mid.jsonl'),
		]);
		expect(flat(rows)).toEqual([
			'/root.jsonl',
			'  /mid.jsonl',
			'    /leaf.jsonl',
			'/fresh.jsonl',
		]);
	});

	it('orders siblings by their own subtree recency', () => {
		const rows = buildForkTree([
			s('/root.jsonl', '2026-01-01T00:00:00Z'),
			s('/fork-a.jsonl', '2026-01-02T00:00:00Z', '/root.jsonl'),
			s('/fork-b.jsonl', '2026-01-03T00:00:00Z', '/root.jsonl'),
			s('/fork-a-child.jsonl', '2026-01-08T00:00:00Z', '/fork-a.jsonl'),
		]);
		expect(flat(rows)).toEqual([
			'/root.jsonl',
			'  /fork-a.jsonl',
			'    /fork-a-child.jsonl',
			'  /fork-b.jsonl',
		]);
	});

	it('treats a cross-folder parent as a root and still ranks it by recency', () => {
		const rows = buildForkTree([
			s('/newer.jsonl', '2026-01-04T00:00:00Z'),
			s('/orphan.jsonl', '2026-01-06T00:00:00Z', '/elsewhere/parent.jsonl'),
		]);
		expect(flat(rows)).toEqual(['/orphan.jsonl', '/newer.jsonl']);
	});

	it('is stable for ties and never drops a session in a cycle', () => {
		const rows = buildForkTree([
			s('/x.jsonl', '2026-01-01T00:00:00Z', '/y.jsonl'),
			s('/y.jsonl', '2026-01-01T00:00:00Z', '/x.jsonl'),
			s('/z.jsonl', '2026-01-01T00:00:00Z'),
		]);
		expect(rows.map((r) => r.session.path).sort()).toEqual([
			'/x.jsonl',
			'/y.jsonl',
			'/z.jsonl',
		]);
	});
});

describe('pruneForkTree', () => {
	// Closed sessions: build over the FULL folder, then drop hidden rows that
	// have no shown descendant. Filtering first would make open children roots.
	const closed = new Set<string>();
	const shown = (x: S) => !closed.has(x.path);

	it('keeps a closed parent of an open child as context, at its depth', () => {
		closed.clear();
		closed.add('/a.jsonl');
		const rows = pruneForkTree(
			buildForkTree([
				s('/a.jsonl', '2026-01-01T00:00:00Z'),
				s('/b.jsonl', '2026-01-02T00:00:00Z', '/a.jsonl'),
			]),
			shown,
		);
		expect(flat(rows)).toEqual(['/a.jsonl', '  /b.jsonl']);
	});

	it('keeps a closed grandparent when only the grandchild is shown', () => {
		closed.clear();
		closed.add('/a.jsonl');
		closed.add('/b.jsonl');
		const rows = pruneForkTree(
			buildForkTree([
				s('/a.jsonl', '2026-01-01T00:00:00Z'),
				s('/b.jsonl', '2026-01-02T00:00:00Z', '/a.jsonl'),
				s('/c.jsonl', '2026-01-03T00:00:00Z', '/b.jsonl'),
			]),
			shown,
		);
		expect(flat(rows)).toEqual(['/a.jsonl', '  /b.jsonl', '    /c.jsonl']);
	});

	it('drops a closed leaf and a fully closed subtree', () => {
		closed.clear();
		closed.add('/b.jsonl');
		closed.add('/x.jsonl');
		closed.add('/y.jsonl');
		const rows = pruneForkTree(
			buildForkTree([
				s('/a.jsonl', '2026-01-01T00:00:00Z'),
				s('/b.jsonl', '2026-01-02T00:00:00Z', '/a.jsonl'),
				s('/x.jsonl', '2026-01-03T00:00:00Z'),
				s('/y.jsonl', '2026-01-04T00:00:00Z', '/x.jsonl'),
			]),
			shown,
		);
		expect(flat(rows)).toEqual(['/a.jsonl']);
	});

	it('keeps every row when all are shown', () => {
		closed.clear();
		const tree = buildForkTree([
			s('/a.jsonl', '2026-01-01T00:00:00Z'),
			s('/b.jsonl', '2026-01-02T00:00:00Z', '/a.jsonl'),
		]);
		expect(pruneForkTree(tree, shown)).toEqual(tree);
	});
});
