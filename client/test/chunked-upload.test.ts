import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import type {UploadProgress} from '../src/types.js';
import {makeWSFactory, type FakeWebSocket} from './harness.js';

// Resumable chunked uploads (upload.v1, docs/adr/0012): the file goes out as
// binary chunks, progress comes from the server's acks, a dropped socket pauses
// the upload, and the rejoin resumes it from the server's offset.

const KiB = 1024;
const MiB = 1024 * KiB;

function makeSource(size: number) {
	const data = new Uint8Array(size);
	for (let i = 0; i < size; i++) data[i] = i % 251;
	const reads: Array<[number, number]> = [];
	return {
		data,
		reads,
		source: {
			size,
			read: async (offset: number, length: number) => {
				reads.push([offset, length]);
				return data.slice(offset, offset + length);
			},
		},
	};
}

// Byte-for-byte equality without vitest's slow per-element deep diff.
function sameBytes(a: Uint8Array, b: Uint8Array) {
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

// Let the async byte-source reads (and the sends after them) run.
async function flush() {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

const SESSION = {
	type: 'session_created',
	sessionId: 'sid-1',
	sessionFile: '/tmp/project/session.jsonl',
	cwd: '/tmp/project',
	model: 'fake:model',
};

describe('chunked uploads (upload.v1)', () => {
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

	function connected(sock: FakeWebSocket, capabilities?: string[]) {
		sock.receive({type: 'connected', clientId: 'c1', serverVersion: 'x', capabilities});
	}

	function openAndJoin() {
		const sock = ws.last();
		sock.open();
		connected(sock, ['upload.v1']);
		client.joinSession('/tmp/project/session.jsonl');
		sock.receive(SESSION);
		sock.receive({type: 'message_history', sessionId: 'sid-1', messages: [], totalCount: 0, offset: 0});
		return sock;
	}

	// `null`: an older server, whose `connected` carries no capabilities.
	function dropAndReconnect(capabilities: string[] | null = ['upload.v1']) {
		const first = ws.last();
		first.close();
		vi.advanceTimersByTime(5000);
		const second = ws.last();
		expect(second).not.toBe(first);
		second.open();
		connected(second, capabilities ?? undefined);
		return second;
	}

	// Ack every chunk this socket has sent beyond `fromIndex`, as a server would.
	async function ackChunks(sock: FakeWebSocket, fromIndex: number) {
		let i = fromIndex;
		while (i < sock.binary.length) {
			const c = sock.binary[i++];
			sock.receive({type: 'upload_offset', uploadId: c.uploadId, offset: c.offset + c.payload.length});
			await flush();
		}
		return i;
	}

	async function ackUntilFinish(sock: FakeWebSocket, fromIndex = 0) {
		let i = fromIndex;
		for (let guard = 0; guard < 1000 && !sock.lastSentOfType('upload_finish'); guard++) {
			i = await ackChunks(sock, i);
			if (i >= sock.binary.length && !sock.lastSentOfType('upload_finish')) await flush();
		}
		return i;
	}

	function bytesOf(sock: FakeWebSocket) {
		return sock.binary.map((c) => [c.offset, c.payload.length]);
	}

	it('uploads in binary chunks; progress reflects acked bytes only', async () => {
		const sock = openAndJoin();
		const {data, source} = makeSource(600 * KiB);
		const progress: UploadProgress[] = [];
		const p = client.uploadFileViaWebSocket('sid-1', 'clip.mp4', source, {
			mime: 'video/mp4',
			onProgress: (pr) => progress.push(pr),
		});
		const begin = sock.lastSentOfType('upload_begin');
		expect(begin).toMatchObject({sessionId: 'sid-1', filename: 'clip.mp4', size: 600 * KiB, mime: 'video/mp4'});
		expect(begin.uploadId).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
		expect(sock.lastSentOfType('file_upload')).toBeUndefined();
		expect(progress.at(-1)).toMatchObject({state: 'sending', acked: 0, size: 600 * KiB});
		// Nothing goes out before the server says where to start.
		await flush();
		expect(sock.binary).toHaveLength(0);

		sock.receive({type: 'upload_offset', uploadId: begin.uploadId, offset: 0});
		await flush();
		expect(sock.binary.length).toBeGreaterThan(0);
		const first = sock.binary[0];
		expect(first).toMatchObject({kind: 1, version: 1, uploadId: begin.uploadId, offset: 0});
		// Sent but not acked: progress has not moved.
		expect(progress.at(-1)).toMatchObject({acked: 0});
		expect(get(client.uploadsStore)[begin.uploadId]).toMatchObject({acked: 0, state: 'sending'});

		sock.receive({type: 'upload_offset', uploadId: begin.uploadId, offset: first.payload.length});
		await flush();
		expect(progress.at(-1)).toMatchObject({acked: first.payload.length, state: 'sending'});

		await ackUntilFinish(sock, 1);
		const finish = sock.lastSentOfType('upload_finish');
		expect(finish).toMatchObject({uploadId: begin.uploadId, sessionId: 'sid-1'});
		expect(progress.at(-1)).toMatchObject({acked: 600 * KiB, state: 'finishing'});

		// The bytes on the wire are exactly the file, in order, each byte once.
		const joined = new Uint8Array(600 * KiB);
		let at = 0;
		for (const c of sock.binary) {
			expect(c.offset).toBe(at);
			joined.set(c.payload, c.offset);
			at += c.payload.length;
		}
		expect(at).toBe(600 * KiB);
		expect(sameBytes(joined, data)).toBe(true);
		// Every acked value reported was one the server sent (monotonic).
		const acks = progress.map((pr) => pr.acked);
		expect([...acks].sort((a, b) => a - b)).toEqual(acks);

		sock.receive({type: 'file_uploaded', uploadId: begin.uploadId, sessionId: 'sid-1', filename: 'clip.mp4', savedPath: '/up/1_clip.mp4'});
		await expect(p).resolves.toEqual({savedPath: '/up/1_clip.mp4', filename: 'clip.mp4'});
		expect(progress.at(-1)).toMatchObject({acked: 600 * KiB, state: 'done'});
		expect(get(client.uploadsStore)[begin.uploadId]).toMatchObject({state: 'done'});
		expect(client.pendingUploadCount()).toBe(0);
	});

	it('paces by bytes in flight: 64 KiB at first, at most 256 KiB chunks and 1 MiB in flight', async () => {
		const sock = openAndJoin();
		const {source} = makeSource(4 * MiB);
		void client.uploadFileViaWebSocket('sid-1', 'big.bin', source).catch(() => {});
		const {uploadId} = sock.lastSentOfType('upload_begin');
		sock.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		// No throughput measured yet: the minimum window, one 64 KiB chunk.
		expect(bytesOf(sock)).toEqual([[0, 64 * KiB]]);

		// A fast ack (no time elapsed): the window opens to its 1 MiB maximum,
		// filled with 256 KiB chunks.
		sock.receive({type: 'upload_offset', uploadId, offset: 64 * KiB});
		await flush();
		const after = sock.binary.slice(1);
		expect(after.length).toBeGreaterThan(1);
		for (const c of after) expect(c.payload.length).toBeLessThanOrEqual(256 * KiB);
		const inFlight = after.reduce((n, c) => n + c.payload.length, 0);
		expect(inFlight).toBeLessThanOrEqual(1 * MiB);
		expect(inFlight).toBeGreaterThan(512 * KiB);
	});

	it('a slow link keeps the window at its 64 KiB floor', async () => {
		const sock = openAndJoin();
		const {source} = makeSource(1 * MiB);
		void client.uploadFileViaWebSocket('sid-1', 'slow.bin', source).catch(() => {});
		const {uploadId} = sock.lastSentOfType('upload_begin');
		sock.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		for (let i = 0; i < 4; i++) {
			// 64 KiB every 4 s: 16 KiB/s, so 2 s worth is far below the floor.
			// Pongs keep the liveness watchdog satisfied meanwhile.
			sock.receive({type: 'pong', timestamp: i});
			vi.advanceTimersByTime(4000);
			const c = sock.binary.at(-1)!;
			sock.receive({type: 'upload_offset', uploadId, offset: c.offset + c.payload.length});
			await flush();
		}
		for (const c of sock.binary) expect(c.payload.length).toBe(64 * KiB);
		expect(sock.binary).toHaveLength(5);
	});

	it('a drop mid-upload pauses it; the rejoin resumes from the server offset without re-sending acked bytes', async () => {
		openAndJoin();
		const {data, source} = makeSource(1 * MiB);
		const progress: UploadProgress[] = [];
		const p = client.uploadFileViaWebSocket('sid-1', 'r.bin', source, {onProgress: (pr) => progress.push(pr)});
		const first = ws.last();
		const {uploadId} = first.lastSentOfType('upload_begin');
		first.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		// Ack the first chunk only, then lose the socket with more in flight.
		const c0 = first.binary[0];
		first.receive({type: 'upload_offset', uploadId, offset: c0.payload.length});
		await flush();
		const acked = c0.payload.length;

		const second = dropAndReconnect();
		expect(progress.at(-1)).toMatchObject({state: 'paused', acked});
		// Held until the rejoin is answered: session_load first, no begin yet.
		expect(second.lastSentOfType('session_load')).toBeTruthy();
		expect(second.lastSentOfType('upload_begin')).toBeUndefined();

		second.receive(SESSION);
		const begin = second.lastSentOfType('upload_begin');
		expect(begin).toMatchObject({uploadId, sessionId: 'sid-1', size: 1 * MiB, filename: 'r.bin'});
		expect(second.binary).toHaveLength(0);

		// The server kept exactly the acked bytes.
		second.receive({type: 'upload_offset', uploadId, offset: acked});
		await flush();
		expect(second.binary[0].offset).toBe(acked);
		await ackUntilFinish(second);
		for (const c of second.binary) expect(c.offset).toBeGreaterThanOrEqual(acked);
		const joined = new Uint8Array(1 * MiB);
		joined.set(data.subarray(0, acked));
		for (const c of second.binary) joined.set(c.payload, c.offset);
		expect(sameBytes(joined, data)).toBe(true);

		second.receive({type: 'file_uploaded', uploadId, sessionId: 'sid-1', filename: 'r.bin', savedPath: '/up/r.bin'});
		await expect(p).resolves.toMatchObject({savedPath: '/up/r.bin'});
	});

	it('an offset mismatch realigns: in-flight acks drain, then it continues from the true offset', async () => {
		const sock = openAndJoin();
		const {source} = makeSource(2 * MiB);
		void client.uploadFileViaWebSocket('sid-1', 'm.bin', source).catch(() => {});
		const {uploadId} = sock.lastSentOfType('upload_begin');
		sock.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		sock.receive({type: 'upload_offset', uploadId, offset: 64 * KiB});
		await flush();
		const inFlight = sock.binary.slice(1);
		expect(inFlight.length).toBeGreaterThan(1);
		const sentBefore = sock.binary.length;

		// The server's true offset is NOT where the first in-flight chunk began
		// (e.g. it lost a write): it answers with its offset, 32 KiB.
		sock.receive({type: 'upload_offset', uploadId, offset: 32 * KiB});
		await flush();
		// Nothing new until the other in-flight chunks are answered too.
		expect(sock.binary).toHaveLength(sentBefore);
		for (let i = 1; i < inFlight.length; i++) {
			sock.receive({type: 'upload_offset', uploadId, offset: 32 * KiB});
			await flush();
			if (i < inFlight.length - 1) expect(sock.binary).toHaveLength(sentBefore);
		}
		expect(sock.binary.length).toBeGreaterThan(sentBefore);
		expect(sock.binary[sentBefore].offset).toBe(32 * KiB);
		expect(get(client.uploadsStore)[uploadId]).toMatchObject({acked: 32 * KiB});
	});

	it('done: true on the resume begin resolves without re-sending anything', async () => {
		openAndJoin();
		const {source} = makeSource(100 * KiB);
		const p = client.uploadFileViaWebSocket('sid-1', 'd.png', source);
		const first = ws.last();
		const {uploadId} = first.lastSentOfType('upload_begin');
		first.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		await ackUntilFinish(first);
		expect(first.lastSentOfType('upload_finish')).toBeTruthy();
		// file_uploaded is lost with the socket.
		const second = dropAndReconnect();
		second.receive(SESSION);
		expect(second.lastSentOfType('upload_begin')).toMatchObject({uploadId});
		second.receive({type: 'upload_offset', uploadId, offset: 100 * KiB, done: true, savedPath: '/up/d.png'});
		await expect(p).resolves.toEqual({savedPath: '/up/d.png', filename: 'd.png'});
		await flush();
		expect(second.binary).toHaveLength(0);
		expect(second.lastSentOfType('upload_finish')).toBeUndefined();
		expect(get(client.uploadsStore)[uploadId]).toMatchObject({state: 'done', acked: 100 * KiB});
	});

	it('an empty file finishes right after the begin', async () => {
		const sock = openAndJoin();
		const {source} = makeSource(0);
		const p = client.uploadFileViaWebSocket('sid-1', 'empty.txt', source);
		const {uploadId} = sock.lastSentOfType('upload_begin');
		sock.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		expect(sock.binary).toHaveLength(0);
		expect(sock.lastSentOfType('upload_finish')).toMatchObject({uploadId});
		sock.receive({type: 'file_uploaded', uploadId, sessionId: 'sid-1', filename: 'empty.txt', savedPath: '/up/e'});
		await expect(p).resolves.toMatchObject({savedPath: '/up/e'});
	});

	it('cancel sends upload_abort for an in-flight chunked upload and stops sending', async () => {
		const sock = openAndJoin();
		const {source} = makeSource(1 * MiB);
		const controller = new AbortController();
		const progress: UploadProgress[] = [];
		const p = client.uploadFileViaWebSocket('sid-1', 'c.bin', source, {
			signal: controller.signal,
			onProgress: (pr) => progress.push(pr),
		});
		const settled = expect(p).rejects.toThrow(/cancelled/);
		const {uploadId} = sock.lastSentOfType('upload_begin');
		sock.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		controller.abort();
		await settled;
		expect(sock.lastSentOfType('upload_abort')).toEqual({type: 'upload_abort', uploadId, sessionId: 'sid-1'});
		expect(progress.at(-1)).toMatchObject({state: 'aborted'});
		const sent = sock.binary.length;
		sock.receive({type: 'upload_offset', uploadId, offset: 64 * KiB});
		await flush();
		expect(sock.binary).toHaveLength(sent);
		expect(client.pendingUploadCount()).toBe(0);
	});

	it('a NotReadableError fails the upload with the "pick it again" message and code', async () => {
		const sock = openAndJoin();
		const progress: UploadProgress[] = [];
		const source = {
			size: 10 * KiB,
			read: async () => {
				const err = new Error('The requested file could not be read');
				err.name = 'NotReadableError';
				throw err;
			},
		};
		const p = client.uploadFileViaWebSocket('sid-1', 'gone.jpg', source, {onProgress: (pr) => progress.push(pr)});
		const settled = p.catch((e) => e);
		const {uploadId} = sock.lastSentOfType('upload_begin');
		sock.receive({type: 'upload_offset', uploadId, offset: 0});
		const err = await settled;
		expect(err.message).toMatch(/no longer readable, pick it again/);
		expect(err.code).toBe('not_readable');
		expect(progress.at(-1)).toMatchObject({
			state: 'failed',
			error: {message: expect.stringMatching(/pick it again/), code: 'not_readable'},
		});
		expect(get(client.uploadsStore)[uploadId].error?.code).toBe('not_readable');
	});

	it('a server error fails the chunked upload with its reason', async () => {
		const sock = openAndJoin();
		const {source} = makeSource(10 * KiB);
		const p = client.uploadFileViaWebSocket('sid-1', 'x.bin', source);
		const {uploadId} = sock.lastSentOfType('upload_begin');
		sock.receive({type: 'file_upload_error', uploadId, sessionId: 'sid-1', error: 'read-only'});
		await expect(p).rejects.toThrow('read-only');
		expect(get(client.uploadsStore)[uploadId]).toMatchObject({state: 'failed', error: {message: 'read-only'}});
	});

	it('an upload is held while the socket capabilities are unknown, never sent as legacy', async () => {
		const sock = ws.last();
		sock.open();
		const {source} = makeSource(10 * KiB);
		void client.uploadFileViaWebSocket('sid-1', 'h.bin', source).catch(() => {});
		await flush();
		expect(sock.lastSentOfType('file_upload')).toBeUndefined();
		expect(sock.lastSentOfType('upload_begin')).toBeUndefined();
		connected(sock, ['upload.v1']);
		expect(sock.lastSentOfType('upload_begin')).toMatchObject({filename: 'h.bin'});
	});

	it('a server without upload.v1 gets the legacy base64 frame', async () => {
		const sock = ws.last();
		sock.open();
		connected(sock);
		const {data, source} = makeSource(5 * KiB);
		void client.uploadFileViaWebSocket('sid-1', 'l.bin', source).catch(() => {});
		await flush();
		expect(sock.lastSentOfType('upload_begin')).toBeUndefined();
		const frame = sock.lastSentOfType('file_upload');
		expect(frame).toMatchObject({sessionId: 'sid-1', filename: 'l.bin'});
		expect(sameBytes(Buffer.from(frame.data, 'base64'), data)).toBe(true);
	});

	it('legacy base64 is encoded across reads with no padding mid-stream', async () => {
		const sock = ws.last();
		sock.open();
		connected(sock);
		// Larger than one encode chunk, and not a multiple of 3.
		const {data, source, reads} = makeSource(2 * MiB + 1);
		void client.uploadFileViaWebSocket('sid-1', 'l2.bin', source).catch(() => {});
		await flush();
		expect(reads.length).toBeGreaterThan(1);
		for (const [, len] of reads.slice(0, -1)) expect(len % 3).toBe(0);
		const frame = sock.lastSentOfType('file_upload');
		expect(frame.data.slice(0, -4).includes('=')).toBe(false);
		expect(sameBytes(Buffer.from(frame.data, 'base64'), data)).toBe(true);
	});

	it('a paused chunked upload that reconnects to a server without upload.v1 fails with the retry message', async () => {
		openAndJoin();
		const {source} = makeSource(1 * MiB);
		const p = client.uploadFileViaWebSocket('sid-1', 'g.bin', source);
		const first = ws.last();
		const {uploadId} = first.lastSentOfType('upload_begin');
		first.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		const settled = p.catch((e) => e);
		const second = dropAndReconnect(null);
		second.receive(SESSION);
		const err = await settled;
		expect(err.message).toMatch(/server no longer supports resumable uploads, retry/);
		expect(second.lastSentOfType('file_upload')).toBeUndefined();
		expect(second.lastSentOfType('upload_begin')).toBeUndefined();
		expect(get(client.uploadsStore)[uploadId]).toMatchObject({state: 'failed'});
	});

	it('a paused chunked upload fails with "session changed" when the rejoin lands on another session', async () => {
		openAndJoin();
		const {source} = makeSource(1 * MiB);
		const p = client.uploadFileViaWebSocket('sid-1', 's.bin', source);
		const first = ws.last();
		const {uploadId} = first.lastSentOfType('upload_begin');
		first.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		const settled = expect(p).rejects.toThrow(/session changed/);
		const second = dropAndReconnect();
		second.receive({...SESSION, sessionId: 'sid-other'});
		await settled;
		expect(second.lastSentOfType('upload_begin')).toBeUndefined();
	});

	it('a paused chunked upload keeps the 10 min waiting clock', async () => {
		openAndJoin();
		const {source} = makeSource(1 * MiB);
		const p = client.uploadFileViaWebSocket('sid-1', 't.bin', source);
		const first = ws.last();
		const {uploadId} = first.lastSentOfType('upload_begin');
		first.receive({type: 'upload_offset', uploadId, offset: 0});
		await flush();
		const settled = expect(p).rejects.toThrow(/timed out/);
		client.suspend();
		vi.advanceTimersByTime(10 * 60_000 + 1);
		await settled;
	});

	it('a chunked upload is not capped by the legacy send count', async () => {
		openAndJoin();
		const {source} = makeSource(1 * MiB);
		const p = client.uploadFileViaWebSocket('sid-1', 'n.bin', source);
		const {uploadId} = ws.last().lastSentOfType('upload_begin');
		let sock = ws.last();
		for (let i = 0; i < 4; i++) {
			sock = dropAndReconnect();
			sock.receive(SESSION);
			expect(sock.lastSentOfType('upload_begin')).toMatchObject({uploadId});
		}
		sock.receive({type: 'upload_offset', uploadId, offset: 1 * MiB, done: true, savedPath: '/up/n'});
		await expect(p).resolves.toMatchObject({savedPath: '/up/n'});
	});
});
