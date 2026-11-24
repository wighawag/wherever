import {describe, it, expect} from 'vitest';
import {
	LIVE_STRIP_CAP,
	liveSessions,
	liveStripHeader,
	sessionListLabel,
	sessionLiveState,
	sessionMatchesFilter,
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

describe('LIVE_STRIP_CAP', () => {
	it('shows at most 6 rows before "+N more"', () => {
		expect(LIVE_STRIP_CAP).toBe(6);
	});
});
