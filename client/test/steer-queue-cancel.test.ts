import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import type {WhereverState} from '../src/types.js';
import {makeWSFactory} from './harness.js';

// A mid-stream steer is queued on the server (pi injects it at the next step
// boundary). The server relays the current queue via `queue_update`, and the
// client tracks it as `pendingSteering` so the UI can offer a per-message
// "Cancel". Cancelling sends `cancel_steer` (which clears the server queue via
// pi's clearQueue) WITHOUT aborting the running turn.

function createAndLoad(
	ws: ReturnType<typeof makeWSFactory>,
	client: WhereverClient,
	{streaming = true}: {streaming?: boolean} = {},
) {
	client.joinSession('/tmp/project/session.jsonl');
	ws.last().receive({
		type: 'session_created',
		sessionId: 'sid-1',
		sessionFile: '/tmp/project/session.jsonl',
		cwd: '/tmp/project',
		model: 'fake:model',
		isStreaming: streaming,
	});
	ws.last().receive({
		type: 'message_history',
		sessionId: 'sid-1',
		messages: [{role: 'user', content: 'go build it', timestamp: 1}],
		totalCount: 1,
		offset: 0,
	});
}

describe('queued steer tracking + cancel', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;
	const state = () => get<WhereverState>(client.stateStore);

	beforeEach(() => {
		vi.useFakeTimers();
		ws = makeWSFactory();
		client = new WhereverClient({
			host: 'localhost',
			port: 1234,
			secure: false,
			WebSocketCtor: ws.ctor,
		});
		client.connect();
		ws.last().open();
		createAndLoad(ws, client);
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	it('tracks the queued steer from queue_update', () => {
		expect(state().pendingSteering).toEqual([]);
		ws.last().receive({
			type: 'queue_update',
			sessionId: 'sid-1',
			steering: ['do X instead'],
		});
		expect(state().pendingSteering).toEqual(['do X instead']);
	});

	it('replaces the pending set outright on each queue_update', () => {
		ws.last().receive({
			type: 'queue_update',
			sessionId: 'sid-1',
			steering: ['first steer', 'second steer'],
		});
		expect(state().pendingSteering).toEqual(['first steer', 'second steer']);
		// A later update with the first delivered leaves only the second.
		ws.last().receive({
			type: 'queue_update',
			sessionId: 'sid-1',
			steering: ['second steer'],
		});
		expect(state().pendingSteering).toEqual(['second steer']);
		// Emptied when the queue drains.
		ws.last().receive({type: 'queue_update', sessionId: 'sid-1', steering: []});
		expect(state().pendingSteering).toEqual([]);
	});

	it('cancelSteer sends cancel_steer and optimistically clears the pending set', () => {
		ws.last().receive({
			type: 'queue_update',
			sessionId: 'sid-1',
			steering: ['retract me'],
		});
		expect(state().pendingSteering).toEqual(['retract me']);

		const sock = ws.last();
		client.cancelSteer();

		const frame = sock.lastSentOfType('cancel_steer');
		expect(frame).toBeTruthy();
		expect(frame.sessionId).toBe('sid-1');
		// Optimistically cleared so the Cancel affordance disappears immediately.
		expect(state().pendingSteering).toEqual([]);
		// It does NOT abort the turn.
		expect(sock.lastSentOfType('abort')).toBeUndefined();
	});

	it('clears the pending set when the turn ends', () => {
		ws.last().receive({
			type: 'queue_update',
			sessionId: 'sid-1',
			steering: ['queued steer'],
		});
		expect(state().pendingSteering).toEqual(['queued steer']);

		ws.last().receive({type: 'agent_end', sessionId: 'sid-1'});
		// agent_end resolves on a short debounce; advance it.
		vi.advanceTimersByTime(500);
		expect(state().pendingSteering).toEqual([]);
	});

	it('an assistant stop that drops the queued steer: the pending set clears and the notice names it', () => {
		// What the server sends a web viewer of the assistant session on a stop
		// with a web steer queued (task web-sees-messages-dropped-from-the-assistant-session):
		// the turn ends, pi's cleared queue, and a session_notice naming the text.
		ws.last().receive({type: 'queue_update', sessionId: 'sid-1', steering: ['do X instead']});
		expect(state().pendingSteering).toEqual(['do X instead']);
		ws.last().receive({type: 'agent_end', sessionId: 'sid-1'});
		ws.last().receive({type: 'queue_update', sessionId: 'sid-1', steering: []});
		const message = 'Stopped before it read this message; send it again if still needed:\n• do X instead';
		ws.last().receive({type: 'session_notice', sessionId: 'sid-1', level: 'warning', message});
		vi.advanceTimersByTime(500);
		expect(state().pendingSteering).toEqual([]);
		expect(state().notice).toEqual({level: 'warning', message});
	});

	it('cancelSteer with no session is a no-op (no frame sent)', () => {
		client.leaveSession();
		const sock = ws.last();
		const before = sock.sent.length;
		client.cancelSteer();
		expect(sock.sent.length).toBe(before);
	});
});
