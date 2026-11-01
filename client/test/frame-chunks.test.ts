import {describe, it, expect, vi, afterEach} from 'vitest';
import {get} from 'sveltore';
import {FrameReassembler} from '../src/frame-chunks.js';
import {splitFrame} from '../../server/src/frame-chunks.js';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// Frame chunking (server/src/frame-chunks.ts): a large frame arrives as several
// small text frames so a slow link never looks like a dead socket.

describe('FrameReassembler', () => {
	it('passes ordinary frames straight through', () => {
		const r = new FrameReassembler();
		expect(r.push('{"type":"pong"}')).toEqual({kind: 'frame', text: '{"type":"pong"}'});
	});

	it('round-trips the server splitter, including surrogate pairs at boundaries', () => {
		// Emoji are surrogate pairs; with an odd chunk size some land on a boundary.
		const json = JSON.stringify({type: 'message_history', text: '😀a'.repeat(5000)});
		const pieces = splitFrame(json, 7, 101);
		expect(pieces.length).toBeGreaterThan(1);
		const r = new FrameReassembler();
		let out: string | null = null;
		pieces.forEach((p, i) => {
			const res = r.push(p);
			if (i < pieces.length - 1) expect(res.kind).toBe('partial');
			else if (res.kind === 'frame') out = res.text;
		});
		expect(out).toBe(json);
	});

	it('makes progress even with a 1-char budget on a surrogate pair', () => {
		const json = '"😀😀"';
		const pieces = splitFrame(json, 1, 1);
		const r = new FrameReassembler();
		let last;
		for (const p of pieces) last = r.push(p);
		expect(last).toEqual({kind: 'frame', text: json});
	});

	it('leaves a frame that fits unchunked', () => {
		expect(splitFrame('{"a":1}', 1, 100)).toEqual(['{"a":1}']);
	});

	it('drops a message whose start was never seen, then recovers', () => {
		const r = new FrameReassembler();
		const a = splitFrame(JSON.stringify({x: 'a'.repeat(300)}), 1, 100);
		expect(r.push(a[1]).kind).toBe('invalid');
		const b = splitFrame(JSON.stringify({x: 'b'.repeat(300)}), 2, 100);
		let last;
		for (const p of b) last = r.push(p);
		expect(last).toEqual({kind: 'frame', text: JSON.stringify({x: 'b'.repeat(300)})});
	});

	it('a new message replaces an unfinished one', () => {
		const r = new FrameReassembler();
		const a = splitFrame(JSON.stringify({x: 'a'.repeat(300)}), 1, 100);
		r.push(a[0]);
		const b = splitFrame(JSON.stringify({y: 'b'.repeat(300)}), 2, 100);
		let last;
		for (const p of b) last = r.push(p);
		expect(last).toEqual({kind: 'frame', text: JSON.stringify({y: 'b'.repeat(300)})});
	});
});

describe('WhereverClient with chunked frames', () => {
	afterEach(() => vi.useRealTimers());

	it('asks for chunks, reassembles a chunked history, and keeps the load alive meanwhile', () => {
		vi.useFakeTimers();
		const ws = makeWSFactory();
		const client = new WhereverClient({host: 'localhost', port: 1234, secure: false, WebSocketCtor: ws.ctor});
		client.connect();
		expect(ws.last().url).toContain('frames=chunk.v1');
		// Image refs are opt-in: a consumer must be able to render data-less images.
		expect(ws.last().url).not.toContain('imageRefs');
		ws.last().open();
		client.joinSession('/tmp/p/s.jsonl');
		ws.last().receive({type: 'session_created', sessionId: 'sid', sessionFile: '/tmp/p/s.jsonl', cwd: '/tmp/p', model: 'm'});
		const history = {
			type: 'message_history',
			sessionId: 'sid',
			messages: [{role: 'assistant', content: 'z'.repeat(5000), timestamp: 1}],
			totalCount: 1,
			offset: 0,
		};
		const pieces = splitFrame(JSON.stringify(history), 3, 500);
		// Pieces trickle in over a minute: longer than the 12 s load watchdog.
		for (const p of pieces) {
			vi.advanceTimersByTime(6_000);
			ws.last().receiveRaw(p);
		}
		const s = get(client.stateStore);
		expect(JSON.stringify(s.messages)).toContain('z'.repeat(5000));
		expect(s.resyncing).toBe(false);
		expect(s.sessionError).toBeFalsy();
		client.disconnect(true);
	});

	it('asks for image refs only when configured to', () => {
		const ws = makeWSFactory();
		const client = new WhereverClient({host: 'localhost', port: 1234, secure: false, WebSocketCtor: ws.ctor, imageRefs: true});
		client.connect();
		expect(ws.last().url).toContain('imageRefs=1');
		client.disconnect(true);
	});
});
