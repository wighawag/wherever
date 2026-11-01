import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// Bug: returning to the PWA reconnects and rejoins the session that was open
// (A). If, while that reconnect is still going, the user switches to another
// session (B) or creates a new one (N), the rejoin of A used to land afterwards
// and switch the view BACK to A. A switch is a newer intent than the automatic
// rejoin, so it must cancel it:
//  - socket still opening: onOpen must issue the user's load/create, not A's;
//  - rejoin already sent: A's late session_created / message_history must be
//    dropped, including when the user created a new session (whose own reply
//    cannot be matched by file, which is what let A's reply through).

const A = '/tmp/project/A.jsonl';
const B = '/tmp/project/B.jsonl';

function loadA(ws: ReturnType<typeof makeWSFactory>, client: WhereverClient) {
	client.joinSession(A);
	ws.last().receive({
		type: 'session_created',
		sessionId: 'sid-A',
		sessionFile: A,
		cwd: '/tmp/project',
		model: 'fake:model',
	});
	ws.last().receive({
		type: 'message_history',
		sessionId: 'sid-A',
		messages: [{role: 'user', content: 'work on A', timestamp: 1}],
		totalCount: 1,
		offset: 0,
	});
}

function replyA(sock: ReturnType<ReturnType<typeof makeWSFactory>['last']>) {
	sock.receive({
		type: 'session_created',
		sessionId: 'sid-A',
		sessionFile: A,
		cwd: '/tmp/project',
		model: 'fake:model',
	});
	sock.receive({
		type: 'message_history',
		sessionId: 'sid-A',
		messages: [{role: 'user', content: 'work on A', timestamp: 1}],
		totalCount: 1,
		offset: 0,
	});
}

describe('switching session while the previous one is still reconnecting', () => {
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
		loadA(ws, client);
		// Tab backgrounded, then returned to: resume opens a new socket.
		client.suspend();
		client.resume();
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	it('socket still opening: a switch to B loads B on open, not A', () => {
		client.switchSession(B);
		const sock = ws.last();
		sock.open();

		const loads = sock.sent.filter((m) => m.type === 'session_load');
		expect(loads.map((m) => m.sessionFile)).toEqual([B]);
		expect(get(client.stateStore).loadingSession).toBe(true);

		sock.receive({
			type: 'session_created',
			sessionId: 'sid-B',
			sessionFile: B,
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		expect(get(client.stateStore).activeSessionFile).toBe(B);
	});

	it('socket still opening: leave + create sends session_new on open, not a rejoin of A', () => {
		client.leaveSession();
		client.createSession('/tmp/project');
		const sock = ws.last();
		sock.open();

		expect(sock.sent.filter((m) => m.type === 'session_load')).toEqual([]);
		expect(sock.lastSentOfType('session_new')).toBeTruthy();
		expect(get(client.stateStore).creatingSession).toBe(true);
	});

	it('socket still opening: leaving only rejoins nothing', () => {
		client.leaveSession();
		const sock = ws.last();
		sock.open();
		expect(sock.sent.filter((m) => m.type === 'session_load')).toEqual([]);
		expect(get(client.stateStore).activeSessionFile).toBeNull();
	});

	it("rejoin in flight: creating a new session drops A's late reply", () => {
		const sock = ws.last();
		sock.open();
		expect(sock.lastSentOfType('session_load')?.sessionFile).toBe(A);

		client.leaveSession();
		client.createSession('/tmp/project');

		// A's rejoin answer lands first. It must not take over.
		replyA(sock);
		let s = get(client.stateStore);
		expect(s.activeSessionFile).toBeNull();
		expect(s.creatingSession).toBe(true);
		expect(s.messages.map((m) => m.content)).not.toContain('work on A');

		// The new session's reply is accepted.
		sock.receive({
			type: 'session_created',
			sessionId: 'sid-N',
			sessionFile: '/tmp/project/new.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		s = get(client.stateStore);
		expect(s.activeSessionFile).toBe('/tmp/project/new.jsonl');
		expect(s.creatingSession).toBe(false);
	});

	it("rejoin in flight: a switch to B never paints A's late history", () => {
		const sock = ws.last();
		sock.open();
		client.switchSession(B);

		replyA(sock);
		const s = get(client.stateStore);
		expect(s.activeSessionFile).toBeNull();
		expect(s.messages.map((m) => m.content)).not.toContain('work on A');
		expect(s.loadingSession).toBe(true);
	});

	for (const how of ['switch', 'leave + create'] as const) {
		it(`rejoin half-answered (created, history still arriving): ${how} drops A's history`, () => {
			const sock = ws.last();
			sock.open();
			sock.receive({
				type: 'session_created',
				sessionId: 'sid-A',
				sessionFile: A,
				cwd: '/tmp/project',
				model: 'fake:model',
			});
			if (how === 'switch') {
				client.switchSession(B);
			} else {
				client.leaveSession();
				client.createSession('/tmp/project');
			}
			sock.receive({
				type: 'message_history',
				sessionId: 'sid-A',
				messages: [{role: 'user', content: 'work on A', timestamp: 1}],
				totalCount: 1,
				offset: 0,
			});
			const s = get(client.stateStore);
			expect(s.messages.map((m) => m.content)).not.toContain('work on A');
			if (how === 'switch') expect(s.loadingSession).toBe(true);
			else expect(s.creatingSession).toBe(true);
		});
	}

	it('socket still opening: reloading the same session goes through the normal rejoin', () => {
		client.reloadSession();
		const sock = ws.last();
		sock.open();
		const loads = sock.sent.filter((m) => m.type === 'session_load');
		expect(loads.map((m) => m.sessionFile)).toEqual([A]);
		expect(get(client.stateStore).resyncing).toBe(true);
	});

	it('switching back to A after abandoning it still accepts A', () => {
		const sock = ws.last();
		sock.open();
		client.switchSession(B);
		client.switchSession(A);
		replyA(sock);
		const s = get(client.stateStore);
		expect(s.activeSessionFile).toBe(A);
		expect(s.messages.map((m) => m.content)).toContain('work on A');
	});
});
