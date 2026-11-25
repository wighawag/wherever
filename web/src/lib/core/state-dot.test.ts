import {describe, it, expect} from 'vitest';
import {
	anyoneWaitsForYou,
	liveCountDots,
	sessionDotState,
	stateDotLabel,
	type SessionDotLike,
} from './state-dot';
import {
	emptyShipmatesState,
	type ShipmatesInboxItem,
	type ShipmatesPresence,
	type ShipmatesState,
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
	question: 'Ship it?',
	options: null,
	blocking: false,
	createdAt: 0,
	sessionFile: '/s/x.jsonl',
	sessionId: null,
	from: 'x',
	onBehalfOf: 0,
	...i,
});

const session = (s: Partial<SessionDotLike> = {}): SessionDotLike => ({
	isWorking: false,
	isActive: false,
	...s,
});

describe('sessionDotState', () => {
	it('is not-loaded for a session that is not resident, live or closed', () => {
		expect(sessionDotState(session(), undefined, false)).toBe('not-loaded');
	});

	it('is idle (loaded, idle) for a resident session that is not live', () => {
		expect(sessionDotState(session({isActive: true}), undefined, false)).toBe(
			'idle',
		);
	});

	it('is idle for a resident session with an idle presence', () => {
		expect(
			sessionDotState(
				session({isActive: true}),
				presence({state: 'idle'}),
				false,
			),
		).toBe('idle');
	});

	it('is running for a working session (no shipmates needed)', () => {
		expect(
			sessionDotState(
				session({isWorking: true, isActive: true}),
				undefined,
				false,
			),
		).toBe('running');
	});

	it('is running for a running presence', () => {
		expect(
			sessionDotState(session(), presence({state: 'running'}), false),
		).toBe('running');
	});

	it('is waiting-for-session for a presence waiting on a session', () => {
		expect(
			sessionDotState(
				session({isActive: true}),
				presence({state: 'waiting-for-session'}),
				false,
			),
		).toBe('waiting-for-session');
	});

	it('is waiting-for-human for a presence waiting for the human, even while working', () => {
		expect(
			sessionDotState(
				session({isWorking: true, isActive: true}),
				presence({state: 'waiting-for-human'}),
				false,
			),
		).toBe('waiting-for-human');
	});

	it('is closed for a closed session that is not live', () => {
		expect(sessionDotState(session(), undefined, true)).toBe('closed');
	});

	it('is closed for a closed session that is loaded but idle (closed beats idle)', () => {
		expect(
			sessionDotState(
				session({isActive: true}),
				presence({state: 'idle'}),
				true,
			),
		).toBe('closed');
	});

	it('shows a closed session that is running as running (live beats closed)', () => {
		expect(
			sessionDotState(
				session({isWorking: true, isActive: true}),
				undefined,
				true,
			),
		).toBe('running');
	});

	it('shows a closed session waiting for the human as waiting-for-human', () => {
		expect(
			sessionDotState(session(), presence({state: 'waiting-for-human'}), true),
		).toBe('waiting-for-human');
	});

	it('shows a closed session waiting on a session as waiting-for-session', () => {
		expect(
			sessionDotState(
				session(),
				presence({state: 'waiting-for-session'}),
				true,
			),
		).toBe('waiting-for-session');
	});
});

describe('stateDotLabel', () => {
	it('names every state', () => {
		expect(stateDotLabel('waiting-for-human')).toBe('waiting for you');
		expect(stateDotLabel('waiting-for-session')).toBe(
			'waiting on another session',
		);
		expect(stateDotLabel('running')).toBe('running');
		expect(stateDotLabel('idle')).toBe('loaded, idle');
		expect(stateDotLabel('not-loaded')).toBe('not loaded');
		expect(stateDotLabel('closed')).toBe('closed');
	});
});

describe('liveCountDots', () => {
	it('lists the non-zero live counts in need order', () => {
		expect(
			liveCountDots({
				running: 3,
				'waiting-for-human': 1,
				'waiting-for-session': 0,
			}),
		).toEqual([
			{state: 'waiting-for-human', count: 1},
			{state: 'running', count: 3},
		]);
	});

	it('is empty when nothing is live', () => {
		expect(liveCountDots({})).toEqual([]);
	});
});

describe('anyoneWaitsForYou', () => {
	const state = (s: Partial<ShipmatesState>): ShipmatesState => ({
		...emptyShipmatesState,
		available: true,
		...s,
	});
	const listed = [{path: '/s/a.jsonl'}, {path: '/s/b.jsonl'}];

	it('is false with neither an inbox item nor a waiting session', () => {
		expect(
			anyoneWaitsForYou(
				state({presence: [presence({state: 'running'})]}),
				listed,
			),
		).toEqual({inbox: 0, sessions: 0, waiting: false});
	});

	it('is true for an open inbox item alone', () => {
		expect(anyoneWaitsForYou(state({inbox: [item()]}), listed)).toEqual({
			inbox: 1,
			sessions: 0,
			waiting: true,
		});
	});

	it('is true for a listed session waiting for the human alone', () => {
		expect(
			anyoneWaitsForYou(
				state({presence: [presence({state: 'waiting-for-human'})]}),
				listed,
			),
		).toEqual({inbox: 0, sessions: 1, waiting: true});
	});

	it('counts both', () => {
		expect(
			anyoneWaitsForYou(
				state({
					inbox: [item(), item({id: 'h_2'})],
					presence: [
						presence({state: 'waiting-for-human'}),
						presence({sessionFile: '/s/b.jsonl', state: 'waiting-for-human'}),
					],
				}),
				listed,
			),
		).toEqual({inbox: 2, sessions: 2, waiting: true});
	});

	it('ignores a waiting presence whose session is not listed', () => {
		expect(
			anyoneWaitsForYou(
				state({
					presence: [
						presence({
							sessionFile: '/s/gone.jsonl',
							state: 'waiting-for-human',
						}),
					],
				}),
				listed,
			),
		).toEqual({inbox: 0, sessions: 0, waiting: false});
	});

	it('is false when shipmates is not available', () => {
		expect(
			anyoneWaitsForYou(
				{
					...emptyShipmatesState,
					inbox: [item()],
					presence: [presence({state: 'waiting-for-human'})],
				},
				listed,
			),
		).toEqual({inbox: 0, sessions: 0, waiting: false});
	});
});
