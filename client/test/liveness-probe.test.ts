import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// ADR 0011: the client never tears a socket down on silence alone. When a
// backgrounded page thaws (most often after the file picker / camera), timers
// fire BEFORE the frames queued during the freeze are dispatched, so a raw
// "silent for 45/60 s" verdict is routinely false. Past the threshold the
// watchdog now pings and waits a short grace period; only a socket that stays
// silent through it is torn down. The page also triggers the probe on every
// return to visibility via noteVisible().

const pings = (sock: {sent: any[]}) => sock.sent.filter((m) => m.type === 'ping').length;

describe('liveness watchdog probes before tearing a socket down', () => {
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
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	// A freeze: wall-clock time passes but no timer and no frame runs.
	function freeze(ms: number) {
		vi.setSystemTime(Date.now() + ms);
	}

	it('a thaw (timers fire before queued frames) does not tear down a healthy socket', () => {
		const sock = ws.last();
		sock.open();
		freeze(120_000);
		// The first tick after the thaw sees 120 s of "silence": it probes.
		vi.advanceTimersByTime(25_000);
		expect(pings(sock)).toBeGreaterThan(0);
		expect(sock.readyState).toBe(1);
		// Then the frames queued during the freeze are dispatched.
		sock.receive({type: 'pong', timestamp: Date.now()});
		vi.advanceTimersByTime(10_000);
		expect(ws.instances).toHaveLength(1);
		expect(sock.readyState).toBe(1);
		expect(get(client.stateStore).connected).toBe(true);
	});

	it('after a thaw-like jump, noteVisible() probes at once and a reply keeps the socket', () => {
		const sock = ws.last();
		sock.open();
		freeze(120_000);
		const before = pings(sock);
		client.noteVisible();
		expect(pings(sock)).toBe(before + 1);
		sock.receive({type: 'pong', timestamp: Date.now()});
		vi.advanceTimersByTime(30_000);
		expect(ws.instances).toHaveLength(1);
		expect(sock.readyState).toBe(1);
		expect(get(client.stateStore).connected).toBe(true);
	});

	it('after a thaw-like jump, noteVisible() with NO reply tears down after the SHORT grace and reconnects at once', () => {
		const sock = ws.last();
		sock.open();
		freeze(120_000);
		client.noteVisible();
		vi.advanceTimersByTime(1_999);
		expect(sock.readyState).toBe(1);
		expect(ws.instances).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sock.readyState).toBe(3);
		// No reconnect backoff: the replacement socket is already being opened.
		expect(ws.instances).toHaveLength(2);
		expect(get(client.stateStore).connecting).toBe(true);
	});

	it('a return to the page resets a backoff grown while hidden', () => {
		ws.last().open();
		// Failed reconnects while hidden grow the delay: 2 s, then 3 s, then 4.5 s.
		ws.last().close();
		vi.advanceTimersByTime(2_000);
		expect(ws.instances).toHaveLength(2);
		ws.last().close(); // next attempt in 3 s
		client.noteVisible(); // the user is back: the growth restarts
		vi.advanceTimersByTime(3_000);
		expect(ws.instances).toHaveLength(3);
		ws.last().close();
		// Without the reset this attempt would wait 4.5 s.
		vi.advanceTimersByTime(3_000);
		expect(ws.instances).toHaveLength(4);
	});

	it('noteVisible() restarts a handshake that hung across a freeze', () => {
		const sock = ws.last();
		expect(sock.readyState).toBe(0);
		freeze(30_000);
		client.noteVisible();
		expect(ws.instances).toHaveLength(2);
		expect(sock.readyState).toBe(3);
		expect(ws.last().readyState).toBe(0);
	});

	it('noteVisible() leaves a slow but young handshake alone', () => {
		const sock = ws.last();
		vi.advanceTimersByTime(7_900);
		client.noteVisible();
		expect(ws.instances).toHaveLength(1);
		expect(sock.readyState).toBe(0);
	});

	it('the page order (noteVisible then resume) on a stalled handshake opens exactly one new socket', () => {
		freeze(30_000);
		client.noteVisible();
		client.resume();
		expect(ws.instances).toHaveLength(2);
	});

	it('a return probe whose check runs late (page froze again) re-probes instead of tearing down', () => {
		const sock = ws.last();
		sock.open();
		client.noteVisible();
		const before = pings(sock);
		freeze(30_000);
		vi.advanceTimersByTime(2_000);
		expect(sock.readyState).toBe(1);
		expect(pings(sock)).toBe(before + 1);
		// The re-probe is an ordinary one: the long grace, then the backoff.
		vi.advanceTimersByTime(4_999);
		expect(sock.readyState).toBe(1);
		vi.advanceTimersByTime(1);
		expect(sock.readyState).toBe(3);
		expect(ws.instances).toHaveLength(1);
		vi.advanceTimersByTime(2_000);
		expect(ws.instances).toHaveLength(2);
	});

	it('a return probe that condemns the socket keeps the session and rejoins it in place', () => {
		const sock = ws.last();
		sock.open();
		client.joinSession('/tmp/project/session.jsonl');
		sock.receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/project/session.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
			isStreaming: false,
		});
		sock.receive({
			type: 'message_history',
			sessionId: 'sid-1',
			messages: [
				{role: 'user', content: 'hello', timestamp: 1},
				{role: 'assistant', content: 'hi there', timestamp: 2},
			],
			totalCount: 2,
			offset: 0,
		});
		freeze(120_000);
		client.noteVisible();
		vi.advanceTimersByTime(2_000);
		expect(sock.readyState).toBe(3);
		let s = get(client.stateStore);
		expect(s.activeSessionFile).toBe('/tmp/project/session.jsonl');
		expect(s.messages.length).toBe(2);
		const next = ws.last();
		expect(next).not.toBe(sock);
		next.open();
		s = get(client.stateStore);
		expect(s.resyncing).toBe(true);
		expect(s.messages.length).toBe(2);
		expect(next.lastSentOfType('session_load')?.sessionFile).toBe(
			'/tmp/project/session.jsonl',
		);
	});

	it('noteVisible() resets the stale baseline: the frozen time alone does not count as silence', () => {
		const sock = ws.last();
		sock.open();
		freeze(120_000);
		client.noteVisible();
		sock.receive({type: 'pong', timestamp: Date.now()});
		// The next tick must not re-probe for the frozen 120 s.
		const before = pings(sock);
		vi.advanceTimersByTime(25_000);
		// Only the ordinary heartbeat ping goes out, no extra probe ping.
		expect(pings(sock) - before).toBe(1);
	});

	it('an ordinary idle stale socket is still detected and torn down (one grace later)', () => {
		const sock = ws.last();
		sock.open();
		// Ticks at 25/50/75 s: 75 s of silence crosses STALE_SOCKET_MS (60 s).
		vi.advanceTimersByTime(75_000);
		expect(sock.readyState).toBe(1);
		vi.advanceTimersByTime(4_999);
		expect(sock.readyState).toBe(1);
		vi.advanceTimersByTime(1);
		expect(sock.readyState).toBe(3);
		expect(get(client.stateStore).connected).toBe(false);
		vi.advanceTimersByTime(2_000);
		expect(ws.instances).toHaveLength(2);
	});

	it('a frame arriving during the grace period cancels the teardown', () => {
		const sock = ws.last();
		sock.open();
		vi.advanceTimersByTime(75_000); // probe sent
		vi.advanceTimersByTime(3_000);
		sock.receive({type: 'pong', timestamp: Date.now()});
		vi.advanceTimersByTime(10_000);
		expect(sock.readyState).toBe(1);
		expect(ws.instances).toHaveLength(1);
	});

	it('a real mid-turn stall is still surfaced as "Connection to relay stalled"', () => {
		const sock = ws.last();
		sock.open();
		sock.receive({type: 'agent_start'});
		expect(get(client.stateStore).isStreaming).toBe(true);
		// Ticks at 25/50 s: 50 s of silence crosses TURN_STALL_MS (45 s).
		vi.advanceTimersByTime(50_000 + 5_000);
		expect(sock.readyState).toBe(3);
		const s = get(client.stateStore);
		expect(s.sessionError).toMatch(/Connection to relay stalled/);
		expect(s.isStreaming).toBe(false);
	});

	it('a grace check delayed by a freeze re-probes instead of tearing down', () => {
		const sock = ws.last();
		sock.open();
		vi.advanceTimersByTime(75_000); // probe sent
		const before = pings(sock);
		freeze(60_000); // the page freezes during the grace period
		vi.advanceTimersByTime(5_000); // the grace check fires, very late
		expect(sock.readyState).toBe(1);
		expect(pings(sock)).toBe(before + 1);
		sock.receive({type: 'pong', timestamp: Date.now()});
		vi.advanceTimersByTime(10_000);
		expect(sock.readyState).toBe(1);
		expect(ws.instances).toHaveLength(1);
	});

	it('noteVisible() on a freshly CONNECTING socket does nothing', () => {
		const sock = ws.last();
		expect(sock.readyState).toBe(0);
		client.noteVisible();
		expect(sock.sent).toHaveLength(0);
		vi.advanceTimersByTime(10_000);
		expect(sock.readyState).toBe(0);
		expect(ws.instances).toHaveLength(1);
	});

	it('noteVisible() with no socket at all does nothing', () => {
		client.disconnect(false);
		expect(() => client.noteVisible()).not.toThrow();
		vi.advanceTimersByTime(10_000);
		expect(ws.instances).toHaveLength(1);
	});

	it('a pending probe is cancelled when the socket changes', () => {
		const first = ws.last();
		first.open();
		client.noteVisible(); // probe pending on the first socket
		first.close(); // dropped before the grace check
		vi.advanceTimersByTime(2_000); // reconnect
		const second = ws.last();
		expect(second).not.toBe(first);
		second.open();
		vi.advanceTimersByTime(10_000); // well past the first socket's grace
		expect(second.readyState).toBe(1);
		expect(ws.instances).toHaveLength(2);
	});
});
