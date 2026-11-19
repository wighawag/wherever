import {describe, it, expect} from 'vitest';
import {
	emptyKenningState,
	inboxBadge,
	ownedChildren,
	parseKenningUpdate,
	presenceByFile,
	presenceLine,
	type KenningInboxItem,
	type KenningPresence,
} from './kenning';

const presence = (p: Partial<KenningPresence> = {}): KenningPresence => ({
	sessionFile: '/s/a.jsonl',
	sessionId: 'a',
	roles: [],
	state: 'idle',
	status: null,
	waitingOn: null,
	...p,
});

const item = (i: Partial<KenningInboxItem> = {}): KenningInboxItem => ({
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

describe('kenning on the web', () => {
	it('reads a kenning_update, and anything unavailable or malformed as no kenning', () => {
		expect(
			parseKenningUpdate({
				type: 'kenning_update',
				available: false,
				inbox: [item()],
			}),
		).toBe(emptyKenningState);
		expect(parseKenningUpdate(null)).toBe(emptyKenningState);
		expect(
			parseKenningUpdate({
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
		expect(parseKenningUpdate({available: true})).toEqual({
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
			parseKenningUpdate({available: true, archives: [archive, {batch: 5}]})
				.archives,
		).toEqual([archive]);
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
