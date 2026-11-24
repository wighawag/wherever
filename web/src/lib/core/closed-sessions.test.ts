import {describe, it, expect} from 'vitest';
import {
	SHOW_CLOSED_KEY,
	folderListView,
	isSessionShown,
	shownSessions,
	type ClosedSessionLike,
} from './closed-sessions';

const s = (
	path: string,
	extra: Partial<ClosedSessionLike> = {},
): ClosedSessionLike => ({
	path,
	firstMessage: '',
	modified: '2026-01-01T00:00:00Z',
	...extra,
});

const paths = (
	view: {
		path: string;
		rows: {depth: number; session: {path: string}}[];
		shownCount: number;
	}[],
) =>
	view.map((f) => ({
		folder: f.path,
		rows: f.rows.map((r) => `${'  '.repeat(r.depth)}${r.session.path}`),
		shown: f.shownCount,
	}));

describe('isSessionShown', () => {
	it('shows an open session either way', () => {
		expect(isSessionShown(s('/a'), false)).toBe(true);
		expect(isSessionShown(s('/a'), true)).toBe(true);
	});

	it('hides a closed session unless "Show closed" is on', () => {
		expect(isSessionShown(s('/a', {closed: true}), false)).toBe(false);
		expect(isSessionShown(s('/a', {closed: true}), true)).toBe(true);
	});
});

describe('shownSessions (owned chips)', () => {
	const children = [s('/open'), s('/shut', {closed: true})];

	it('hides closed children unless "Show closed" is on', () => {
		expect(shownSessions(children, false).map((c) => c.path)).toEqual([
			'/open',
		]);
		expect(shownSessions(children, true).map((c) => c.path)).toEqual([
			'/open',
			'/shut',
		]);
	});
});

describe('folderListView', () => {
	const folder = (path: string, sessions: ClosedSessionLike[]) => ({
		path,
		name: path.slice(1),
		sessions,
	});

	it('hides closed sessions from the rows', () => {
		const view = folderListView(
			[folder('/p', [s('/a'), s('/b', {closed: true})])],
			'',
			false,
		);
		expect(paths(view)).toEqual([{folder: '/p', rows: ['/a'], shown: 1}]);
	});

	it('shows closed sessions when "Show closed" is on', () => {
		const view = folderListView(
			[folder('/p', [s('/a'), s('/b', {closed: true})])],
			'',
			true,
		);
		expect(paths(view)[0].rows.sort()).toEqual(['/a', '/b']);
		expect(paths(view)[0].shown).toBe(2);
	});

	it('hides a folder whose sessions are all closed, unless "Show closed"', () => {
		const folders = [folder('/dead', [s('/a', {closed: true})])];
		expect(folderListView(folders, '', false)).toEqual([]);
		expect(paths(folderListView(folders, '', true))).toEqual([
			{folder: '/dead', rows: ['/a'], shown: 1},
		]);
	});

	it('keeps an empty folder (the listing keeps those on purpose)', () => {
		expect(paths(folderListView([folder('/empty', [])], '', false))).toEqual([
			{folder: '/empty', rows: [], shown: 0},
		]);
	});

	it('keeps a closed parent of an open fork as context, not counted', () => {
		const view = folderListView(
			[
				folder('/p', [
					s('/root', {closed: true}),
					s('/fork', {
						parentSessionPath: '/root',
						modified: '2026-01-02T00:00:00Z',
					}),
				]),
			],
			'',
			false,
		);
		expect(paths(view)).toEqual([
			{folder: '/p', rows: ['/root', '  /fork'], shown: 1},
		]);
	});

	it('filter results skip closed sessions unless "Show closed"', () => {
		const folders = [
			folder('/p', [
				s('/a', {name: 'deploy api'}),
				s('/b', {name: 'deploy web', closed: true}),
				s('/c', {name: 'other'}),
			]),
			folder('/q', [s('/d', {name: 'deploy docs', closed: true})]),
		];
		expect(paths(folderListView(folders, 'deploy', false))).toEqual([
			{folder: '/p', rows: ['/a'], shown: 1},
		]);
		const on = paths(folderListView(folders, 'deploy', true));
		expect(on.map((f) => f.folder)).toEqual(['/p', '/q']);
		expect(on[0].rows.sort()).toEqual(['/a', '/b']);
	});

	it('drops a folder with no match when a query is typed', () => {
		expect(folderListView([folder('/empty', [])], 'zzz', false).length).toBe(0);
	});
});

describe('SHOW_CLOSED_KEY', () => {
	it('is a wherever- prefixed localStorage key', () => {
		expect(SHOW_CLOSED_KEY).toBe('wherever-show-closed');
	});
});
