import {describe, it, expect} from 'vitest';
import {
	emptyShipmatesState,
	inboxBadge,
	inboxCount,
	syncAppBadge,
	titleWithInboxCount,
	ownedChildren,
	parseShipmatesUpdate,
	presenceByFile,
	presenceLine,
	type ShipmatesInboxItem,
	type ShipmatesPresence,
} from './shipmates';

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

const item = (i: Partial<ShipmatesInboxItem> = {}): ShipmatesInboxItem => ({
	id: 'h_1',
	question: 'Publish?',
	options: null,
	blocking: false,
	createdAt: 0,
	sessionFile: '/s/a.jsonl',
	sessionId: 'a',
	from: 'tree/push',
	onBehalfOf: 0,
	...i,
});

describe('shipmates on the web', () => {
	it('reads a shipmates_update, and anything unavailable or malformed as no shipmates', () => {
		expect(
			parseShipmatesUpdate({
				type: 'shipmates_update',
				available: false,
				inbox: [item()],
			}),
		).toBe(emptyShipmatesState);
		expect(parseShipmatesUpdate(null)).toBe(emptyShipmatesState);
		expect(
			parseShipmatesUpdate({
				available: true,
				inbox: [item(), {nope: 1}],
				presence: [presence(), 5],
			}),
		).toEqual({
			available: true,
			inbox: [item()],
			presence: [presence()],
			archives: [],
		});
		expect(parseShipmatesUpdate({available: true})).toEqual({
			available: true,
			inbox: [],
			presence: [],
			archives: [],
		});
		const archive = {
			batch: 'ar_1',
			root: '/s/a.jsonl',
			sessions: ['/s/a.jsonl', '/s/b.jsonl'],
			at: 1,
			undoUntil: 2,
		};
		expect(
			parseShipmatesUpdate({available: true, archives: [archive, {batch: 5}]})
				.archives,
		).toEqual([archive]);
	});

	it('carries waitingOnSession, and reads it as null from an older server or when malformed', () => {
		const old = {
			...presence({sessionFile: '/s/old.jsonl'}),
		} as Partial<ShipmatesPresence>;
		delete old.waitingOnSession;
		const {presence: got} = parseShipmatesUpdate({
			available: true,
			presence: [
				presence({
					state: 'waiting-for-session',
					waitingOn: 'q_1',
					waitingOnSession: '/s/b.jsonl',
				}),
				old,
				presence({
					sessionFile: '/s/bad.jsonl',
					waitingOnSession: 7 as unknown as string,
				}),
			],
		});
		expect(got.map((p) => p.waitingOnSession)).toEqual([
			'/s/b.jsonl',
			null,
			null,
		]);
		expect(got[1]).toEqual(presence({sessionFile: '/s/old.jsonl'}));
	});

	it('the presence line: roles, a state worth saying, the status; nothing for a plain idle session', () => {
		expect(presenceLine(undefined)).toBe('');
		expect(presenceLine(presence())).toBe('');
		expect(
			presenceLine(
				presence({roles: ['tree/push'], state: 'running', status: 'rebasing'}),
			),
		).toBe('tree/push · running · rebasing');
		expect(presenceLine(presence({state: 'waiting-for-human'}))).toBe(
			'waiting for you',
		);
		expect(presenceLine(presence({roles: ['a', 'b'], status: 'done'}))).toBe(
			'a, b · done',
		);
	});

	it('owned children are grouped by owner across folders, in listing order', () => {
		const m = ownedChildren([
			{path: '/a/owner.jsonl'},
			{path: '/b/lane1.jsonl', ownerSessionPath: '/a/owner.jsonl'},
			{path: '/c/lane2.jsonl', ownerSessionPath: '/a/owner.jsonl'},
			{path: '/b/helper.jsonl', ownerSessionPath: '/b/lane1.jsonl'},
		]);
		expect(m.get('/a/owner.jsonl')?.map((s) => s.path)).toEqual([
			'/b/lane1.jsonl',
			'/c/lane2.jsonl',
		]);
		expect(m.get('/b/lane1.jsonl')?.map((s) => s.path)).toEqual([
			'/b/helper.jsonl',
		]);
		expect(m.has('/b/helper.jsonl')).toBe(false);
	});

	it('presence joins the session list by file; the badge counts items and flags blocking ones', () => {
		const m = presenceByFile([
			presence(),
			presence({sessionFile: '/s/b.jsonl'}),
		]);
		expect(m.get('/s/b.jsonl')?.sessionFile).toBe('/s/b.jsonl');
		expect(inboxBadge([])).toBeNull();
		expect(inboxBadge([item(), item({id: 'h_2', blocking: true})])).toEqual({
			count: 2,
			blocking: true,
		});
		expect(inboxBadge([item()])).toEqual({count: 1, blocking: false});
	});
});

describe('the inbox count outside the page', () => {
	const item = (id: string): ShipmatesInboxItem => ({
		id,
		question: 'q',
		options: null,
		blocking: false,
		createdAt: 0,
		sessionFile: '/s/a.jsonl',
		sessionId: 'a',
		from: 'a',
		onBehalfOf: 0,
	});

	it('counts open items only while shipmates is available', () => {
		expect(
			inboxCount({
				...emptyShipmatesState,
				available: true,
				inbox: [item('1'), item('2')],
			}),
		).toBe(2);
		expect(
			inboxCount({
				...emptyShipmatesState,
				available: false,
				inbox: [item('1')],
			}),
		).toBe(0);
	});

	it('prefixes the title, idempotently, and drops the prefix at 0', () => {
		expect(titleWithInboxCount('Wherever', 3)).toBe('(3) Wherever');
		expect(titleWithInboxCount('(3) Wherever', 1)).toBe('(1) Wherever');
		expect(titleWithInboxCount('(3) Wherever', 0)).toBe('Wherever');
		expect(titleWithInboxCount('Wherever', 0)).toBe('Wherever');
	});

	it('sets and clears the app badge where supported, and ignores a refusal', async () => {
		const calls: string[] = [];
		const nav = {
			setAppBadge: (n?: number) => {
				calls.push(`set ${n}`);
				return Promise.reject(new Error('not installed'));
			},
			clearAppBadge: () => {
				calls.push('clear');
				return Promise.resolve();
			},
		};
		syncAppBadge(nav, 2);
		syncAppBadge(nav, 0);
		expect(calls).toEqual(['set 2', 'clear']);
		// No Badging API (or no navigator at all): nothing to do, nothing thrown.
		expect(() => syncAppBadge({}, 2)).not.toThrow();
		expect(() => syncAppBadge(undefined, 2)).not.toThrow();
		// Only setAppBadge: clear by setting 0.
		const only: string[] = [];
		syncAppBadge(
			{setAppBadge: (n) => (only.push(`set ${n}`), Promise.resolve())},
			0,
		);
		expect(only).toEqual(['set 0']);
		await Promise.resolve();
	});
});
