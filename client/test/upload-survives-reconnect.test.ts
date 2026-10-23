import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// Bug: on mobile, picking a file backgrounds the page and the socket is often
// lost within seconds. uploadFileViaWebSocket fired its frame and forgot it:
//  - started while the socket was (re)connecting, send() returned false and the
//    frame was silently dropped, so the promise never settled;
//  - a frame sent on a socket that then died never got its reply, and nothing
//    rejected or retried it.
// Either way the composer's "uploading" chip spun forever and Send stayed
// disabled. An upload must survive a reconnect and must always settle.

describe('WebSocket upload is independent of the socket it started on', () => {
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

	function joinSession() {
		client.joinSession('/tmp/project/session.jsonl');
		ws.last().receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/project/session.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		ws.last().receive({
			type: 'message_history',
			sessionId: 'sid-1',
			messages: [],
			totalCount: 0,
			offset: 0,
		});
	}

	function dropAndReconnect() {
		const first = ws.last();
		first.close();
		vi.advanceTimersByTime(5000);
		const second = ws.last();
		expect(second).not.toBe(first);
		second.open();
		return second;
	}

	it('an upload started while the socket is down is sent once reconnected and rejoined', async () => {
		ws.last().open();
		joinSession();
		ws.last().close(); // dropped; the reconnect is pending
		const p = client.uploadFileViaWebSocket('sid-1', 'a.png', 'AAAA');
		vi.advanceTimersByTime(5000);
		const next = ws.last();
		// Still CONNECTING: nothing could be sent.
		expect(next.lastSentOfType('file_upload')).toBeUndefined();

		next.open();
		next.receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/project/session.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		const frame = next.lastSentOfType('file_upload');
		expect(frame).toMatchObject({sessionId: 'sid-1', filename: 'a.png', data: 'AAAA'});

		next.receive({
			type: 'file_uploaded',
			uploadId: frame.uploadId,
			sessionId: 'sid-1',
			filename: 'a.png',
			savedPath: '/up/1_a.png',
		});
		await expect(p).resolves.toEqual({savedPath: '/up/1_a.png', filename: 'a.png'});
		expect(client.pendingUploadCount()).toBe(0);
	});

	it('an upload whose socket dies is re-sent only AFTER the rejoin is answered', async () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 'b.pdf', 'BBBB');
		const sent = ws.last().lastSentOfType('file_upload');
		expect(sent).toBeTruthy();

		// The socket drops (app switch / file picker) before the server replied.
		const second = dropAndReconnect();

		// session_load goes first; the upload is held: a fresh server socket has
		// no write verdict (readOnly) until it answers the rejoin.
		expect(second.lastSentOfType('session_load')).toBeTruthy();
		expect(second.lastSentOfType('file_upload')).toBeUndefined();

		second.receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/project/session.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		const resent = second.lastSentOfType('file_upload');
		expect(resent).toMatchObject({uploadId: sent.uploadId, data: 'BBBB'});

		second.receive({
			type: 'file_uploaded',
			uploadId: sent.uploadId,
			sessionId: 'sid-1',
			filename: 'b.pdf',
			savedPath: '/up/2_b.pdf',
		});
		await expect(p).resolves.toMatchObject({savedPath: '/up/2_b.pdf'});
	});

	it('an upload started mid-rejoin waits for session_created', () => {
		ws.last().open();
		joinSession();
		const second = dropAndReconnect();
		void client.uploadFileViaWebSocket('sid-1', 'f.png', 'FFFF').catch(() => {});
		expect(second.lastSentOfType('file_upload')).toBeUndefined();
		second.receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/project/session.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		expect(second.lastSentOfType('file_upload')).toMatchObject({data: 'FFFF'});
	});

	it('a reconnect with no session to rejoin fails parked uploads', async () => {
		ws.last().open();
		const p = client.uploadFileViaWebSocket('sid-1', 'g.png', 'GGGG');
		const settled = expect(p).rejects.toThrow(/session was closed/);
		dropAndReconnect();
		await settled;
	});

	it('a sent upload is not timed out while in transmission', () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 'h.mp4', 'HHHH');
		let settled = false;
		p.then(
			() => (settled = true),
			() => (settled = true),
		);
		// A healthy (if slow) socket keeps receiving frames, so the liveness
		// watchdog leaves it alone; only the upload timeout is under test.
		for (let t = 0; t < 30 * 60_000; t += 20_000) {
			ws.last().receive({type: 'pong', timestamp: t});
			vi.advanceTimersByTime(20_000);
		}
		return Promise.resolve().then(() => {
			expect(settled).toBe(false);
			expect(client.pendingUploadCount()).toBe(1);
		});
	});

	it('aborting drops a parked upload so it is never sent', async () => {
		const controller = new AbortController();
		const p = client.uploadFileViaWebSocket('sid-1', 'i.png', 'IIII', {
			signal: controller.signal,
		});
		const settled = expect(p).rejects.toThrow(/cancelled/);
		controller.abort();
		await settled;
		expect(client.pendingUploadCount()).toBe(0);
		ws.last().open();
		expect(ws.last().lastSentOfType('file_upload')).toBeUndefined();
	});

	it('a server error rejects the upload', async () => {
		ws.last().open();
		const p = client.uploadFileViaWebSocket('sid-1', 'c.txt', 'CCCC');
		const sent = ws.last().lastSentOfType('file_upload');
		ws.last().receive({
			type: 'file_upload_error',
			uploadId: sent.uploadId,
			sessionId: 'sid-1',
			error: 'nope',
		});
		await expect(p).rejects.toThrow('nope');
		expect(client.pendingUploadCount()).toBe(0);
	});

	it('an upload that never gets a connection eventually rejects (never hangs)', async () => {
		const p = client.uploadFileViaWebSocket('sid-1', 'd.png', 'DDDD');
		const settled = expect(p).rejects.toThrow(/timed out/);
		vi.advanceTimersByTime(10 * 60_000 + 1);
		await settled;
		expect(client.pendingUploadCount()).toBe(0);
	});

	it('an explicit full disconnect rejects pending uploads', async () => {
		const p = client.uploadFileViaWebSocket('sid-1', 'e.png', 'EEEE');
		const settled = expect(p).rejects.toThrow(/Disconnected/);
		client.disconnect(true);
		await settled;
		expect(client.pendingUploadCount()).toBe(0);
	});

	it('a failed rejoin (session_error) fails held uploads and stops holding', async () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 'j.png', 'JJJJ');
		const second = dropAndReconnect();
		const settled = expect(p).rejects.toThrow(/Could not rejoin/);
		second.receive({type: 'session_error', error: 'Session not found'});
		await settled;
		expect(client.pendingUploadCount()).toBe(0);
		// No longer holding: a new upload goes straight out.
		void client.uploadFileViaWebSocket('sid-1', 'k.png', 'KKKK').catch(() => {});
		expect(second.lastSentOfType('file_upload')).toMatchObject({data: 'KKKK'});
	});

	it('a rejoin that times out (load watchdog) fails held uploads', async () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 'l.png', 'LLLL');
		dropAndReconnect();
		const settled = expect(p).rejects.toThrow(/Could not rejoin/);
		vi.advanceTimersByTime(13_000); // past LOAD_WATCHDOG_MS
		await settled;
	});

	it('switching session mid-hold fails the parked upload instead of releasing it to the new session', async () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 'm.png', 'MMMM');
		const second = dropAndReconnect();
		const settled = expect(p).rejects.toThrow(/session changed/);
		client.switchSession('/tmp/other/session.jsonl');
		await settled;
		second.receive({
			type: 'session_created',
			sessionId: 'sid-2',
			sessionFile: '/tmp/other/session.jsonl',
			cwd: '/tmp/other',
			model: 'fake:model',
		});
		expect(second.lastSentOfType('file_upload')).toBeUndefined();
	});

	it('a rejoin answered for a DIFFERENT session releases only matching uploads', async () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 'n.png', 'NNNN');
		const second = dropAndReconnect();
		const settled = expect(p).rejects.toThrow(/session changed/);
		second.receive({
			type: 'session_created',
			sessionId: 'sid-1-other-id',
			sessionFile: '/tmp/project/session.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		await settled;
		expect(second.lastSentOfType('file_upload')).toBeUndefined();
	});

	it('suspend with an upload on the wire re-arms its timer and re-sends after resume', async () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 'o.png', 'OOOO');
		const first = ws.last();
		const sent = first.lastSentOfType('file_upload');
		client.suspend();
		client.resume();
		const second = ws.last();
		expect(second).not.toBe(first);
		second.open();
		second.receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/project/session.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		const resent = second.lastSentOfType('file_upload');
		expect(resent).toMatchObject({uploadId: sent.uploadId});
		second.receive({
			type: 'file_uploaded',
			uploadId: sent.uploadId,
			sessionId: 'sid-1',
			filename: 'o.png',
			savedPath: '/up/o.png',
		});
		await expect(p).resolves.toMatchObject({savedPath: '/up/o.png'});
	});

	it('suspend while an upload is on the wire, never resumed: it eventually times out', async () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 'q.png', 'QQQQ');
		const settled = expect(p).rejects.toThrow(/timed out/);
		client.suspend();
		vi.advanceTimersByTime(10 * 60_000 + 1);
		await settled;
	});

	it('the waiting deadline is NOT restarted by repeated failed reconnect attempts', async () => {
		ws.last().open();
		joinSession();
		ws.last().close(); // server goes away
		const p = client.uploadFileViaWebSocket('sid-1', 'r.png', 'RRRR');
		const settled = expect(p).rejects.toThrow(/timed out/);
		// Every reconnect attempt opens a socket that immediately fails.
		for (let t = 0; t < 11 * 60_000; t += 5_000) {
			vi.advanceTimersByTime(5_000);
			const sock = ws.last();
			if (sock.readyState === 0) sock.close();
		}
		await settled;
	});

	it('an upload that loses its socket on every send gives up after MAX_UPLOAD_SENDS', async () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 's.png', 'SSSS');
		const settled = expect(p).rejects.toThrow(/dropped during the transfer/);
		for (let i = 0; i < 3; i++) {
			const sock = dropAndReconnect();
			sock.receive({
				type: 'session_created',
				sessionId: 'sid-1',
				sessionFile: '/tmp/project/session.jsonl',
				cwd: '/tmp/project',
				model: 'fake:model',
			});
		}
		await settled;
		expect(client.pendingUploadCount()).toBe(0);
	});

	it('refuses a payload too large for the server frame limit up front', async () => {
		ws.last().open();
		const huge = 'A'.repeat(96 * 1024 * 1024 + 1);
		await expect(client.uploadFileViaWebSocket('sid-1', 'big.mp4', huge)).rejects.toThrow(
			/too large/,
		);
		expect(ws.last().lastSentOfType('file_upload')).toBeUndefined();
	});

	it('a session_error tagged with a session id does not fail held uploads', () => {
		ws.last().open();
		joinSession();
		void client.uploadFileViaWebSocket('sid-1', 't.png', 'TTTT').catch(() => {});
		const second = dropAndReconnect();
		second.receive({type: 'session_error', sessionId: 'some-other', error: 'fork failed'});
		expect(client.pendingUploadCount()).toBe(1);
		second.receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/project/session.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
		});
		expect(second.lastSentOfType('file_upload')).toMatchObject({data: 'TTTT'});
	});

	it('an upload lost twice and answered on the third send resolves (cap boundary)', async () => {
		ws.last().open();
		joinSession();
		const p = client.uploadFileViaWebSocket('sid-1', 'u.png', 'UUUU');
		let sock = ws.last();
		for (let i = 0; i < 2; i++) {
			sock = dropAndReconnect();
			sock.receive({
				type: 'session_created',
				sessionId: 'sid-1',
				sessionFile: '/tmp/project/session.jsonl',
				cwd: '/tmp/project',
				model: 'fake:model',
			});
		}
		const sent = sock.lastSentOfType('file_upload');
		expect(sent).toBeTruthy();
		sock.receive({
			type: 'file_uploaded',
			uploadId: sent.uploadId,
			sessionId: 'sid-1',
			filename: 'u.png',
			savedPath: '/up/u.png',
		});
		await expect(p).resolves.toMatchObject({savedPath: '/up/u.png'});
	});
});
