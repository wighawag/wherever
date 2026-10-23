import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import type {ChatMessage} from '@wherever-dev/client';
import {
	createConversationCache,
	createWriteThrottle,
	normalizeMessages,
	trimToByteCap,
	type CachedConversationInput,
} from './conversation-cache.js';

// The on-device conversation cache (ADR 0013). What is pinned here: what a
// record may contain (normalization), how big the cache may get (sessions and
// bytes), that records never cross server keys, that a browser without usable
// IndexedDB degrades to "no cache" instead of an error, and that a streaming
// reply is written at most once per throttle interval. Each test gets a fresh
// in-memory IDBFactory so no state leaks between them.

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
	return {id: 'm', role: 'assistant', content: 'hello', timestamp: 1, ...over};
}

function input(
	over: Partial<CachedConversationInput> = {},
): CachedConversationInput {
	return {
		serverKey: 'host:1234#abc',
		sessionId: 's1',
		sessionFile: '/sessions/s1.jsonl',
		cwd: '/work',
		model: 'some-model',
		messages: [msg()],
		historyTotalCount: 1,
		historyOffset: 0,
		...over,
	};
}

describe('normalizeMessages', () => {
	it('drops delivery-tagged user messages (recovered from localStorage instead)', () => {
		const out = normalizeMessages([
			msg({id: 'a', role: 'user', content: 'delivered'}),
			msg({id: 'b', role: 'user', content: 'in flight', delivery: 'sending'}),
			msg({id: 'c', role: 'user', content: 'lost', delivery: 'failed'}),
			msg({id: 'd'}),
		]);
		expect(out.map((m) => m.id)).toEqual(['a', 'd']);
	});

	it('forces isStreaming false on every message', () => {
		const out = normalizeMessages([
			msg({id: 'a', isStreaming: true}),
			msg({id: 'b', role: 'tool', isStreaming: true}),
			msg({id: 'c'}),
		]);
		expect(out.map((m) => m.isStreaming)).toEqual([false, false, false]);
	});

	it('drops tool-image payloads but keeps the tool message', () => {
		const out = normalizeMessages([
			msg({
				id: 't',
				role: 'tool',
				toolName: 'read',
				toolOutput: 'read an image',
				images: [{mimeType: 'image/png', data: 'AAAA'}],
			}),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].toolOutput).toBe('read an image');
		expect('images' in out[0]).toBe(false);
	});

	it('does not mutate the caller messages', () => {
		const original = msg({
			isStreaming: true,
			images: [{mimeType: 'x', data: 'y'}],
		});
		normalizeMessages([original]);
		expect(original.isStreaming).toBe(true);
		expect(original.images).toHaveLength(1);
	});
});

describe('trimToByteCap', () => {
	it('keeps everything when the record fits', () => {
		const messages = [msg({id: 'a'}), msg({id: 'b'})];
		expect(trimToByteCap(input({messages}), 10_000).messages).toEqual(messages);
	});

	it('trims the OLDEST messages until the record fits, keeping offsets as-is', () => {
		const big = 'x'.repeat(1000);
		const messages = ['a', 'b', 'c', 'd', 'e'].map((id) =>
			msg({id, content: big}),
		);
		const record = input({messages, historyTotalCount: 40, historyOffset: 35});
		const out = trimToByteCap(record, 3500);
		expect(out.messages.map((m) => m.id)).toEqual(['c', 'd', 'e']);
		expect(out.historyTotalCount).toBe(40);
		expect(out.historyOffset).toBe(35);
		expect(
			new TextEncoder().encode(JSON.stringify(out)).length,
		).toBeLessThanOrEqual(3500);
	});

	it('measures UTF-8 bytes, not UTF-16 code units', () => {
		// 1000 euro signs: 1000 code units but 3000 UTF-8 bytes each.
		const wide = '€'.repeat(1000);
		const messages = ['a', 'b'].map((id) => msg({id, content: wide}));
		expect(
			trimToByteCap(input({messages}), 4000).messages.map((m) => m.id),
		).toEqual(['b']);
	});

	it('yields no messages when not even the newest fits', () => {
		const messages = [msg({content: 'x'.repeat(5000)})];
		expect(trimToByteCap(input({messages}), 1000).messages).toEqual([]);
	});
});

describe('createConversationCache', () => {
	let factory: IDBFactory;
	let clock: number;
	beforeEach(() => {
		factory = new IDBFactory();
		clock = 1000;
	});
	function cache(opts: {maxSessions?: number; maxRecordBytes?: number} = {}) {
		return createConversationCache({
			indexedDB: factory,
			now: () => clock++,
			...opts,
		});
	}

	it('round-trips a record, normalized and stamped with savedAt', async () => {
		const c = cache();
		await c.put(
			input({
				messages: [
					msg({id: 'a', isStreaming: true}),
					msg({id: 'b', role: 'user', delivery: 'failed'}),
				],
			}),
		);
		const got = await c.get('host:1234#abc', 's1');
		expect(got).not.toBeNull();
		expect(got!.savedAt).toBe(1000);
		expect(got!.sessionFile).toBe('/sessions/s1.jsonl');
		expect(got!.messages).toEqual([msg({id: 'a', isStreaming: false})]);
	});

	it('returns null for a miss', async () => {
		expect(await cache().get('host:1234#abc', 'nope')).toBeNull();
	});

	it('last write wins on the same (serverKey, sessionId)', async () => {
		const c = cache();
		await c.put(input({messages: [msg({id: 'first'})]}));
		await c.put(input({messages: [msg({id: 'second'})]}));
		expect(
			(await c.get('host:1234#abc', 's1'))!.messages.map((m) => m.id),
		).toEqual(['second']);
	});

	it('scopes records by server key', async () => {
		const c = cache();
		await c.put(input({serverKey: 'A', messages: [msg({id: 'from-a'})]}));
		await c.put(input({serverKey: 'B', messages: [msg({id: 'from-b'})]}));
		expect((await c.get('A', 's1'))!.messages[0].id).toBe('from-a');
		expect((await c.get('B', 's1'))!.messages[0].id).toBe('from-b');
	});

	it('retainOnly(key) deletes every other key', async () => {
		const c = cache();
		await c.put(input({serverKey: 'A', sessionId: 's1'}));
		await c.put(input({serverKey: 'A', sessionId: 's2'}));
		await c.put(input({serverKey: 'B', sessionId: 's1'}));
		await c.put(input({serverKey: 'C', sessionId: 's3'}));
		await c.retainOnly('A');
		expect(await c.get('A', 's1')).not.toBeNull();
		expect(await c.get('A', 's2')).not.toBeNull();
		expect(await c.get('B', 's1')).toBeNull();
		expect(await c.get('C', 's3')).toBeNull();
	});

	it('remove evicts one record and clear evicts everything', async () => {
		const c = cache();
		await c.put(input({sessionId: 's1'}));
		await c.put(input({sessionId: 's2'}));
		await c.put(input({serverKey: 'B', sessionId: 's3'}));
		await c.remove('host:1234#abc', 's1');
		expect(await c.get('host:1234#abc', 's1')).toBeNull();
		expect(await c.get('host:1234#abc', 's2')).not.toBeNull();
		await c.clear();
		expect(await c.get('host:1234#abc', 's2')).toBeNull();
		expect(await c.get('B', 's3')).toBeNull();
	});

	it('keeps at most 5 sessions in total across all keys, evicting the least recently saved', async () => {
		const c = cache();
		for (let i = 1; i <= 5; i++) {
			await c.put(input({serverKey: i % 2 ? 'A' : 'B', sessionId: `s${i}`}));
		}
		// Re-saving s1 makes it the most recent, so s2 is now the oldest.
		await c.put(input({serverKey: 'A', sessionId: 's1'}));
		await c.put(input({serverKey: 'A', sessionId: 's6'}));
		expect(await c.get('B', 's2')).toBeNull();
		for (const [key, id] of [
			['A', 's1'],
			['A', 's3'],
			['B', 's4'],
			['A', 's5'],
			['A', 's6'],
		]) {
			expect(await c.get(key, id), `${key}/${id}`).not.toBeNull();
		}
	});

	it('applies the byte cap on write, trimming the oldest messages', async () => {
		const c = cache({maxRecordBytes: 3500});
		const big = 'x'.repeat(1000);
		await c.put(
			input({
				messages: ['a', 'b', 'c', 'd', 'e'].map((id) =>
					msg({id, content: big}),
				),
			}),
		);
		const got = await c.get('host:1234#abc', 's1');
		expect(got!.messages.map((m) => m.id)).toEqual(['c', 'd', 'e']);
	});

	it('does not store a record none of whose messages fit, and evicts the stale one', async () => {
		const c = cache({maxRecordBytes: 2000});
		await c.put(input({messages: [msg({id: 'small'})]}));
		await c.put(
			input({messages: [msg({id: 'huge', content: 'x'.repeat(5000)})]}),
		);
		expect(await c.get('host:1234#abc', 's1')).toBeNull();
	});

	it('persists across instances on the same database', async () => {
		await cache().put(input());
		expect(await cache().get('host:1234#abc', 's1')).not.toBeNull();
	});
});

describe('createConversationCache with IndexedDB unavailable', () => {
	async function exerciseEverything(
		c: ReturnType<typeof createConversationCache>,
	) {
		await expect(c.put(input())).resolves.toBeUndefined();
		await expect(c.get('host:1234#abc', 's1')).resolves.toBeNull();
		await expect(c.retainOnly('host:1234#abc')).resolves.toBeUndefined();
		await expect(c.remove('host:1234#abc', 's1')).resolves.toBeUndefined();
		await expect(c.clear()).resolves.toBeUndefined();
	}

	it('is a no-op when there is no indexedDB at all', async () => {
		await exerciseEverything(createConversationCache({indexedDB: null}));
	});

	it('is a no-op when indexedDB.open throws', async () => {
		const open = vi.fn(() => {
			throw new DOMException('denied', 'SecurityError');
		});
		const c = createConversationCache({
			indexedDB: {open} as unknown as IDBFactory,
		});
		await exerciseEverything(c);
		// Disabled for the page: the failed open is not retried on every call.
		expect(open).toHaveBeenCalledTimes(1);
	});

	it('is a no-op when the open request errors', async () => {
		const open = vi.fn(() => {
			const req = {
				error: new DOMException('nope', 'UnknownError'),
			} as unknown as IDBOpenDBRequest;
			queueMicrotask(() => req.onerror?.(new Event('error')));
			return req;
		});
		const c = createConversationCache({
			indexedDB: {open} as unknown as IDBFactory,
		});
		await exerciseEverything(c);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it('defaults to the global indexedDB, which node does not have', async () => {
		expect((globalThis as {indexedDB?: unknown}).indexedDB).toBeUndefined();
		await exerciseEverything(createConversationCache());
	});
});

describe('createWriteThrottle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('coalesces a burst of schedules into one write per interval', () => {
		const write = vi.fn();
		const t = createWriteThrottle(write, {intervalMs: 5000});
		for (let i = 0; i < 50; i++) {
			t.schedule();
			vi.advanceTimersByTime(100);
		}
		// 5 s of streaming in 100 ms ticks: exactly one write so far.
		expect(write).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 50; i++) {
			t.schedule();
			vi.advanceTimersByTime(100);
		}
		expect(write).toHaveBeenCalledTimes(2);
		// Nothing scheduled since: no further writes.
		vi.advanceTimersByTime(20_000);
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('flush writes immediately and cancels the pending throttled write', () => {
		const write = vi.fn();
		const t = createWriteThrottle(write, {intervalMs: 5000});
		t.schedule();
		t.flush();
		expect(write).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10_000);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it('flush writes even when nothing was scheduled (the caller decides the triggers)', () => {
		const write = vi.fn();
		createWriteThrottle(write).flush();
		expect(write).toHaveBeenCalledTimes(1);
	});

	it('cancel drops a pending write', () => {
		const write = vi.fn();
		const t = createWriteThrottle(write, {intervalMs: 5000});
		t.schedule();
		t.cancel();
		vi.advanceTimersByTime(10_000);
		expect(write).not.toHaveBeenCalled();
	});

	it('swallows a throwing or rejecting write', async () => {
		const t = createWriteThrottle(() => Promise.reject(new Error('quota')));
		expect(() => t.flush()).not.toThrow();
		const t2 = createWriteThrottle(() => {
			throw new Error('boom');
		});
		expect(() => t2.flush()).not.toThrow();
		await Promise.resolve();
	});
});
