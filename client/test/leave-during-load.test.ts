import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// Leaving a session that is still LOADING (the web's 🔍 Search the web, or the
// logo, tapped before session_created): the client has no sessionId yet, but it
// must still tell the server, or the server finishes the load and attaches this
// socket as a hidden viewer of the session the user left (its agent events then
// flip isStreaming on the search screen). The server stops such a load on any
// session_leave (WSClient.loadGeneration), whatever its sessionId.

const A = '/tmp/project/A.jsonl';

describe('leaving while a session is still loading', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;

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
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	it('sends one session_leave with an empty id before session_created, and ends the loading state', () => {
		client.joinSession(A);
		const sock = ws.last();
		expect(sock.lastSentOfType('session_load')?.sessionFile).toBe(A);
		expect(get(client.stateStore).loadingSession).toBe(true);

		client.leaveSession();
		const leaves = sock.sent.filter((m) => m.type === 'session_leave');
		expect(leaves).toEqual([{type: 'session_leave', sessionId: ''}]);
		expect(get(client.stateStore).loadingSession).toBe(false);

		// A late reply of the abandoned load still does not take over.
		sock.receive({
			type: 'session_created',
			sessionId: 'sid-A',
			sessionFile: A,
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		expect(get(client.stateStore).activeSessionFile).toBeNull();
	});

	it('an attached session leaves once, with its real id (no extra empty leave)', () => {
		client.joinSession(A);
		const sock = ws.last();
		sock.receive({
			type: 'session_created',
			sessionId: 'sid-A',
			sessionFile: A,
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		client.leaveSession();
		const leaves = sock.sent.filter((m) => m.type === 'session_leave');
		expect(leaves).toEqual([{type: 'session_leave', sessionId: 'sid-A'}]);
	});

	it('sends nothing when there is nothing to leave', () => {
		const sock = ws.last();
		client.leaveSession();
		expect(sock.sent.filter((m) => m.type === 'session_leave')).toEqual([]);
	});
});
