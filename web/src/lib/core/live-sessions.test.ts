import {describe, it, expect} from 'vitest';
import {
	LIVE_STRIP_CAP,
	liveSessions,
	liveBadgeText,
	liveRowDetail,
	liveStateCounts,
	liveStripHeader,
	sessionListLabel,
	sessionLiveState,
	sessionMatchesFilter,
	waitingOnText,
	type LiveSessionLike,
} from './live-sessions';
import {presenceByFile, type ShipmatesPresence} from './shipmates';

const presence = (p: Partial<ShipmatesPresence> = {}): ShipmatesPresence => ({
	sessionFile: '/s/a.jsonl',
	sessionId: 'a',
	roles: [],
	state: 'idle',
	status: null,
	waitingOn: null,
	waitingOnSession: null,
	...p,
});

const session = (s: Partial<LiveSessionLike> = {}): LiveSessionLike => ({
	path: '/s/a.jsonl',
	firstMessage: '',
	modified: '2026-01-01T00:00:00Z',
	...s,
});

describe('sessionLiveState', () => {
	it('is idle for a session that is not working and has no presence', () => {
		expect(sessionLiveState(session(), undefined)).toBe('idle');
	});

	it('is idle for an idle presence alone (an idle presence is not live)', () => {
		expect(sessionLiveState(session(), presence({state: 'idle'}))).toBe('idle');
	});

	it('is running for a working session without presence (shipmates off)', () => {
		expect(sessionLiveState(session({isWorking: true}), undefined)).toBe(
			'running',
		);
	});

	it('is running for a working session whose presence says idle', () => {
		expect(
			sessionLiveState(session({isWorking: true}), presence({state: 'idle'})),
		).toBe('running');
	});

	it('is running for a running presence even when not working', () => {
		expect(sessionLiveState(session(), presence({state: 'running'}))).toBe(
			'running',
		);
	});

	it('is waiting-for-human over isWorking', () => {
		expect(
			sessionLiveState(
				session({isWorking: true}),
				presence({state: 'waiting-for-human'}),
			),
		).toBe('waiting-for-human');
	});

	it('is waiting-for-session over isWorking', () => {
		expect(
			sessionLiveState(
				session({isWorking: true}),
				presence({state: 'waiting-for-session'}),
			),
		).toBe('waiting-for-session');
	});
});

describe('sessionMatchesFilter', () => {
	const s = session({name: 'Refactor Parser', firstMessage: 'Fix the BUG'});

	it('matches everything on an empty query', () => {
		expect(sessionMatchesFilter(s, 'proj', '')).toBe(true);
	});

	it('matches the name, case-insensitively', () => {
		expect(sessionMatchesFilter(s, 'proj', 'parser')).toBe(true);
	});

	it('matches the first message, case-insensitively', () => {
		expect(sessionMatchesFilter(s, 'proj', 'bug')).toBe(true);
	});

	it('matches the folder name', () => {
		expect(sessionMatchesFilter(s, 'My-Project', 'my-proj')).toBe(true);
	});

	it('does not match anything else', () => {
		expect(sessionMatchesFilter(s, 'proj', 'zebra')).toBe(false);
	});

	it('tolerates a session without a name', () => {
		expect(
			sessionMatchesFilter(session({firstMessage: 'hello'}), 'p', 'hell'),
		).toBe(true);
	});
});

describe('sessionListLabel', () => {
	it('prefers the name, then the first-message preview, then "Empty session"', () => {
		expect(sessionListLabel(session({name: 'N', firstMessage: 'm'}))).toBe('N');
		expect(sessionListLabel(session({firstMessage: 'm'}))).toBe('m');
		expect(sessionListLabel(session())).toBe('Empty session');
	});

	it('truncates a long first message like the folder rows', () => {
		expect(sessionListLabel(session({firstMessage: 'x'.repeat(50)}))).toBe(
			'x'.repeat(40) + '...',
		);
	});
});

describe('liveSessions', () => {
	const folder = (name: string, sessions: LiveSessionLike[]) => ({
		name,
		sessions,
	});

	it('lists only live sessions, across folders, with their folder name', () => {
		const rows = liveSessions(
			[
				folder('one', [
					session({path: '/1', isWorking: true}),
					session({path: '/2'}),
				]),
				folder('two', [session({path: '/3'})]),
			],
			presenceByFile([presence({sessionFile: '/3', state: 'running'})]),
			'',
		);
		expect(rows.map((r) => [r.session.path, r.folderName, r.state])).toEqual([
			['/1', 'one', 'running'],
			['/3', 'two', 'running'],
		]);
	});

	it('orders by need: waiting for you, waiting on a session, running; then newest first', () => {
		const rows = liveSessions(
			[
				folder('f', [
					session({path: '/run-old', isWorking: true, modified: '2026-01-01'}),
					session({path: '/run-new', isWorking: true, modified: '2026-01-05'}),
					session({path: '/ws', modified: '2026-01-09'}),
					session({path: '/wh-old', modified: '2026-01-02'}),
					session({path: '/wh-new', modified: '2026-01-03'}),
				]),
			],
			presenceByFile([
				presence({sessionFile: '/ws', state: 'waiting-for-session'}),
				presence({sessionFile: '/wh-old', state: 'waiting-for-human'}),
				presence({sessionFile: '/wh-new', state: 'waiting-for-human'}),
			]),
			'',
		);
		expect(rows.map((r) => r.session.path)).toEqual([
			'/wh-new',
			'/wh-old',
			'/ws',
			'/run-new',
			'/run-old',
		]);
	});

	it('drops a presence whose session is not in the listing', () => {
		const rows = liveSessions(
			[folder('f', [])],
			presenceByFile([
				presence({sessionFile: '/gone', state: 'waiting-for-human'}),
			]),
			'',
		);
		expect(rows).toEqual([]);
	});

	it('labels a row by its first role, else the sidebar label', () => {
		const rows = liveSessions(
			[
				folder('f', [
					session({path: '/r', name: 'named', modified: '2026-01-03'}),
					session({
						path: '/n',
						name: 'named',
						isWorking: true,
						modified: '2026-01-02',
					}),
					session({
						path: '/m',
						firstMessage: 'hi there',
						isWorking: true,
						modified: '2026-01-01',
					}),
					session({path: '/e', isWorking: true, modified: '2025-12-31'}),
				]),
			],
			presenceByFile([
				presence({
					sessionFile: '/r',
					roles: ['lane/one', 'other'],
					state: 'running',
				}),
			]),
			'',
		);
		expect(rows.map((r) => r.label)).toEqual([
			'lane/one',
			'named',
			'hi there',
			'Empty session',
		]);
	});

	it('names the session a waiting-for-session row waits on, like the sidebar names it', () => {
		const waiting = (path: string, on: string | null) =>
			presence({
				sessionFile: path,
				state: 'waiting-for-session',
				waitingOn: 'q_1',
				waitingOnSession: on,
			});
		const rows = liveSessions(
			[
				folder('a', [
					session({path: '/w1', modified: '2026-01-05'}),
					session({path: '/w2', modified: '2026-01-04'}),
					session({path: '/w3', modified: '2026-01-03'}),
					session({path: '/w4', modified: '2026-01-02'}),
					session({path: '/w5', modified: '2026-01-01'}),
					session({path: '/run', isWorking: true}),
				]),
				folder('b', [
					session({path: '/role'}),
					session({path: '/named', name: 'the parser'}),
					session({path: '/empty'}),
				]),
			],
			presenceByFile([
				waiting('/w1', '/named'),
				waiting('/w2', '/role'),
				waiting('/w3', null),
				waiting('/w4', '/not-listed'),
				waiting('/w5', '/empty'),
				presence({sessionFile: '/role', roles: ['tree/push'], state: 'idle'}),
			]),
			'',
		);
		expect(rows.map((r) => [r.session.path, r.waitingOn])).toEqual([
			['/w1', 'waiting on the parser'],
			['/w2', 'waiting on tree/push'],
			['/w3', 'waiting on a session'],
			['/w4', 'waiting on a session'],
			['/w5', 'waiting on a session'],
			['/run', null],
		]);
	});

	it('names a waited-on session filtered out by the filter box (it is listed, not hidden)', () => {
		const rows = liveSessions(
			[
				folder('a', [session({path: '/w', name: 'waiter'})]),
				folder('b', [session({path: '/t', name: 'target'})]),
			],
			presenceByFile([
				presence({
					sessionFile: '/w',
					state: 'waiting-for-session',
					waitingOnSession: '/t',
				}),
			]),
			'waiter',
		);
		expect(rows.map((r) => r.waitingOn)).toEqual(['waiting on target']);
	});

	it('never names a waited-on session that is no longer listed, even if it was seen before', () => {
		// A remembered label (the sidebar's seenLabels) of a now-hidden session must not leak.
		const listed = new Map([['/t', session({path: '/t', name: 'target'})]]);
		const presence_ = presenceByFile([
			presence({
				sessionFile: '/hidden',
				roles: ['secret/role'],
				state: 'running',
			}),
		]);
		expect(waitingOnText('/t', listed, presence_)).toBe('waiting on target');
		expect(waitingOnText('/hidden', listed, presence_)).toBe(
			'waiting on a session',
		);
		expect(waitingOnText(null, listed, presence_)).toBe('waiting on a session');
	});

	it('applies the sidebar filter with the same rule as the list', () => {
		const rows = liveSessions(
			[
				folder('alpha', [
					session({path: '/1', name: 'parser', isWorking: true}),
					session({path: '/2', name: 'lexer', isWorking: true}),
				]),
				folder('beta', [session({path: '/3', isWorking: true})]),
			],
			new Map(),
			'BETA',
		);
		expect(rows.map((r) => r.session.path)).toEqual(['/3']);
		expect(
			liveSessions(
				[
					folder('alpha', [
						session({path: '/1', name: 'parser', isWorking: true}),
					]),
				],
				new Map(),
				'pars',
			).map((r) => r.session.path),
		).toEqual(['/1']);
	});
});

describe('liveStripHeader', () => {
	it('counts the rows and the ones waiting for you', () => {
		expect(
			liveStripHeader([
				{state: 'waiting-for-human'},
				{state: 'running'},
				{state: 'running'},
				{state: 'waiting-for-session'},
			]),
		).toBe('Live · 4 · 1 waiting for you');
	});

	it('omits the waiting part when nobody waits for you', () => {
		expect(liveStripHeader([{state: 'running'}])).toBe('Live · 1');
	});
});

describe('liveBadgeText', () => {
	it('is short: you, session, running', () => {
		expect(liveBadgeText('waiting-for-human')).toBe('you');
		expect(liveBadgeText('waiting-for-session')).toBe('session');
		expect(liveBadgeText('running')).toBe('running');
	});
});

describe('liveRowDetail', () => {
	const row = (
		r: Partial<{
			folderName: string;
			waitingOn: string | null;
		}> = {},
	) => ({folderName: 'wherever', waitingOn: null, ...r});

	it('is just the folder when nothing else is present', () => {
		expect(liveRowDetail(row(), null, undefined)).toBe('wherever');
	});

	it('adds the presence status line', () => {
		expect(liveRowDetail(row(), 'building mockups', undefined)).toBe(
			'wherever · building mockups',
		);
	});

	it('shows what a row waits on instead of its status line', () => {
		expect(
			liveRowDetail(
				row({waitingOn: 'waiting on memonaut/search-order'}),
				'blocked',
				undefined,
			),
		).toBe('wherever · waiting on memonaut/search-order');
	});

	it('ends with the owner when the session was spawned', () => {
		expect(liveRowDetail(row(), null, 'drive-sidebar-tasks')).toBe(
			'wherever · ↳ drive-sidebar-tasks',
		);
		expect(liveRowDetail(row(), 'Ship 0.5.0 now?', 'lead')).toBe(
			'wherever · Ship 0.5.0 now? · ↳ lead',
		);
	});

	it('skips empty parts', () => {
		expect(liveRowDetail(row(), '', '')).toBe('wherever');
	});
});

describe('liveStateCounts', () => {
	it('counts the rows per live state', () => {
		expect(
			liveStateCounts([
				{state: 'waiting-for-human'},
				{state: 'running'},
				{state: 'running'},
				{state: 'waiting-for-session'},
			]),
		).toEqual({
			'waiting-for-human': 1,
			'waiting-for-session': 1,
			running: 2,
		});
	});

	it('is all zero with no rows', () => {
		expect(liveStateCounts([])).toEqual({
			'waiting-for-human': 0,
			'waiting-for-session': 0,
			running: 0,
		});
	});
});

describe('LIVE_STRIP_CAP', () => {
	it('shows at most 6 rows before "+N more"', () => {
		expect(LIVE_STRIP_CAP).toBe(6);
	});
});

describe('liveSessions and closed sessions', () => {
	// The strip is closed-agnostic: a working session shows even while closed.
	const closedWorking = {
		...session({path: '/s/c.jsonl', name: 'deploy', isWorking: true}),
		closed: true,
	};

	it('includes a closed session that is working', () => {
		const rows = liveSessions(
			[{name: 'proj', sessions: [closedWorking]}],
			new Map(),
			'',
		);
		expect(rows.map((r) => r.session.path)).toEqual(['/s/c.jsonl']);
	});

	it('includes it with a query typed that matches it', () => {
		const rows = liveSessions(
			[{name: 'proj', sessions: [closedWorking]}],
			new Map(),
			'depl',
		);
		expect(rows.map((r) => r.session.path)).toEqual(['/s/c.jsonl']);
	});
});
