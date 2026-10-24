import {describe, expect, it, vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import type {ChatMessage} from '@wherever-dev/client';
import {
	createConversationCache,
	type CachedConversation,
	type ConversationCache,
} from './conversation-cache.js';
import {
	cacheSnapshot,
	canLoadOlderHistory,
	clearCacheOnDisconnect,
	decideReturn,
	handleHydrationRejected,
	readBootCache,
	retainCurrentServer,
	runBoot,
	type ResumeStoreView,
} from './instant-resume.js';

// The wiring decisions of instant resume (ADR 0013), kept out of +page.svelte
// so they run in the node test environment: which snapshot is written and
// under which key, how boot picks hydrate vs plain connect, what the
// visibility / pageshow handlers may do while booting, the wipe hooks, and
// what a rejected hydration does to the URL and the cache.

const KEY = 'host:1234#abc';

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
	return {id: 'm', role: 'assistant', content: 'hello', timestamp: 1, ...over};
}

function view(over: Partial<ResumeStoreView> = {}): ResumeStoreView {
	return {
		serverKey: KEY,
		sessionId: 's1',
		activeSessionFile: '/sessions/s1.jsonl',
		activeCwd: '/work',
		activeModel: 'm',
		messages: [msg()],
		historyTotalCount: 1,
		historyOffset: 0,
		historyAuthoritative: true,
		...over,
	};
}

function record(over: Partial<CachedConversation> = {}): CachedConversation {
	return {
		serverKey: KEY,
		sessionId: 's1',
		sessionFile: '/sessions/s1.jsonl',
		cwd: '/work',
		model: 'm',
		messages: [msg()],
		historyTotalCount: 1,
		historyOffset: 0,
		savedAt: 1,
		...over,
	};
}

function fakeCache(over: Partial<ConversationCache> = {}): ConversationCache {
	return {
		get: vi.fn(async () => null),
		put: vi.fn(async () => {}),
		remove: vi.fn(async () => {}),
		retainOnly: vi.fn(async () => {}),
		clear: vi.fn(async () => {}),
		...over,
	};
}

describe('cacheSnapshot', () => {
	it('writes under the STAMPED key, never another', () => {
		const snap = cacheSnapshot(view({serverKey: 'stamped:1#x'}));
		expect(snap?.serverKey).toBe('stamped:1#x');
		expect(snap).toMatchObject({
			sessionId: 's1',
			sessionFile: '/sessions/s1.jsonl',
			cwd: '/work',
			model: 'm',
			historyTotalCount: 1,
			historyOffset: 0,
		});
	});

	it('writes nothing without a stamp (wiped store, or another server)', () => {
		expect(cacheSnapshot(view({serverKey: null}))).toBeNull();
	});

	it('writes nothing without an active session', () => {
		expect(cacheSnapshot(view({sessionId: null}))).toBeNull();
		expect(cacheSnapshot(view({activeSessionFile: null}))).toBeNull();
	});

	it('writes nothing until the authoritative history has landed', () => {
		expect(cacheSnapshot(view({historyAuthoritative: false}))).toBeNull();
	});

	it('writes nothing for an empty conversation', () => {
		expect(cacheSnapshot(view({messages: []}))).toBeNull();
	});
});

describe('canLoadOlderHistory', () => {
	it('is unavailable until the history is authoritative', () => {
		expect(
			canLoadOlderHistory({historyOffset: 10, historyAuthoritative: false}),
		).toBe(false);
		expect(
			canLoadOlderHistory({historyOffset: 10, historyAuthoritative: true}),
		).toBe(true);
	});

	it('is unavailable when nothing older exists', () => {
		expect(
			canLoadOlderHistory({historyOffset: 0, historyAuthoritative: true}),
		).toBe(false);
	});
});

describe('decideReturn (visibilitychange: visible / pageshow)', () => {
	it('does nothing while booting, so a hydration in progress is not wiped', () => {
		expect(
			decideReturn({booting: true, connected: false, hasActiveSession: false}),
		).toBe('none');
		expect(
			decideReturn({booting: true, connected: false, hasActiveSession: true}),
		).toBe('none');
	});

	it('does nothing when connected', () => {
		expect(
			decideReturn({booting: false, connected: true, hasActiveSession: true}),
		).toBe('none');
	});

	it('resumes a held session, else connects', () => {
		expect(
			decideReturn({booting: false, connected: false, hasActiveSession: true}),
		).toBe('resume');
		expect(
			decideReturn({booting: false, connected: false, hasActiveSession: false}),
		).toBe('connect');
	});
});

describe('readBootCache', () => {
	it('reads nothing without a hash session', async () => {
		const cache = fakeCache();
		expect(await readBootCache({cache, serverKey: KEY, hashId: ''})).toBeNull();
		expect(cache.get).not.toHaveBeenCalled();
	});

	it('reads the hash session under the current key', async () => {
		const cache = fakeCache({get: vi.fn(async () => record())});
		const hit = await readBootCache({cache, serverKey: KEY, hashId: 's1'});
		expect(hit?.sessionId).toBe('s1');
		expect(cache.get).toHaveBeenCalledWith(KEY, 's1');
	});

	it('gives up after the timeout and treats it as a miss', async () => {
		vi.useFakeTimers();
		try {
			const cache = fakeCache({get: vi.fn(() => new Promise<null>(() => {}))});
			const p = readBootCache({
				cache,
				serverKey: KEY,
				hashId: 's1',
				timeoutMs: 300,
			});
			await vi.advanceTimersByTimeAsync(300);
			expect(await p).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats a rejecting cache as a miss', async () => {
		const cache = fakeCache({
			get: vi.fn(async () => {
				throw new Error('boom');
			}),
		});
		expect(
			await readBootCache({cache, serverKey: KEY, hashId: 's1'}),
		).toBeNull();
	});

	it('ignores a record for another session or key', async () => {
		const cache = fakeCache({
			get: vi.fn(async () => record({sessionId: 'other'})),
		});
		expect(
			await readBootCache({cache, serverKey: KEY, hashId: 's1'}),
		).toBeNull();
	});
});

describe('runBoot', () => {
	it('on a hit: hydrates, then connects preserving the store', async () => {
		const order: string[] = [];
		const result = await runBoot({
			cached: Promise.resolve(record()),
			hydrate: (r) => {
				order.push(`hydrate:${r.sessionId}`);
				return true;
			},
			connect: (opts) => order.push(`connect:${opts.preserveState}`),
		});
		expect(result).toBe('hydrated');
		expect(order).toEqual(['hydrate:s1', 'connect:true']);
	});

	it('on a miss: connects exactly as today (no hydrate, no preserve)', async () => {
		const hydrate = vi.fn(() => true);
		const connect = vi.fn();
		const result = await runBoot({
			cached: Promise.resolve(null),
			hydrate,
			connect,
		});
		expect(result).toBe('plain');
		expect(hydrate).not.toHaveBeenCalled();
		expect(connect).toHaveBeenCalledWith({preserveState: false});
	});

	it('falls back to a plain connect when the client refused the hydration', async () => {
		const connect = vi.fn();
		const result = await runBoot({
			cached: Promise.resolve(record()),
			hydrate: () => false,
			connect,
		});
		expect(result).toBe('plain');
		expect(connect).toHaveBeenCalledWith({preserveState: false});
	});

	it('always issues its connect, even when hydrating throws', async () => {
		const connect = vi.fn();
		await runBoot({
			cached: Promise.resolve(record()),
			hydrate: () => {
				throw new Error('boom');
			},
			connect,
		});
		expect(connect).toHaveBeenCalledWith({preserveState: false});
	});
});

describe('wipe hooks', () => {
	it('every connect retains only the current server key', () => {
		const cache = fakeCache();
		retainCurrentServer(cache, KEY);
		expect(cache.retainOnly).toHaveBeenCalledWith(KEY);
		expect(cache.clear).not.toHaveBeenCalled();
	});

	it('Disconnect clears the whole cache and drops any pending write', () => {
		const cache = fakeCache();
		const throttle = {schedule: vi.fn(), flush: vi.fn(), cancel: vi.fn()};
		clearCacheOnDisconnect(cache, throttle);
		expect(throttle.cancel).toHaveBeenCalled();
		expect(throttle.flush).not.toHaveBeenCalled();
		expect(cache.clear).toHaveBeenCalled();
	});

	it('Reconnect / same-server Connect keep the record; another server drops it', async () => {
		const cache = createConversationCache({indexedDB: new IDBFactory()});
		await cache.put({...record(), messages: [msg()]});
		// Reconnect and same-server Connect go through connect() -> retainOnly(KEY).
		await retainCurrentServer(cache, KEY);
		expect(await cache.get(KEY, 's1')).not.toBeNull();
		// Connect against an edited server.
		await retainCurrentServer(cache, 'other:1#y');
		expect(await cache.get(KEY, 's1')).toBeNull();
	});
});

describe('handleHydrationRejected', () => {
	function win(hash: string) {
		const calls: string[] = [];
		const w = {
			location: {
				hash,
				pathname: '/app/',
				search: '?q=1',
			},
			history: {
				state: {s: 1},
				replaceState: vi.fn((_state: unknown, _t: string, url: string) => {
					calls.push(`replace:${url}`);
					w.location.hash = '';
				}),
			},
		};
		return {w, calls};
	}

	it('clears the hash synchronously, without a history entry, then evicts', () => {
		const {w, calls} = win('#s1');
		const cache = fakeCache({
			remove: vi.fn(async () => {
				calls.push('remove');
			}),
		});
		handleHydrationRejected({sessionId: 's1', serverKey: KEY, win: w, cache});
		// Both happened before any await: the page's hash effect (which would use
		// `location.hash = ''`, a history entry) must find the hash already gone.
		expect(calls).toEqual(['replace:/app/?q=1', 'remove']);
		expect(w.history.replaceState).toHaveBeenCalledWith(
			{s: 1},
			'',
			'/app/?q=1',
		);
		expect(cache.remove).toHaveBeenCalledWith(KEY, 's1');
		expect(w.location.hash).toBe('');
	});

	it('decodes an encoded hash before comparing', () => {
		const {w} = win(`#${encodeURIComponent('a b')}`);
		handleHydrationRejected({
			sessionId: 'a b',
			serverKey: KEY,
			win: w,
			cache: fakeCache(),
		});
		expect(w.history.replaceState).toHaveBeenCalled();
	});

	it('leaves a hash naming another session alone, but still evicts', () => {
		const {w} = win('#other');
		const cache = fakeCache();
		handleHydrationRejected({sessionId: 's1', serverKey: KEY, win: w, cache});
		expect(w.history.replaceState).not.toHaveBeenCalled();
		expect(cache.remove).toHaveBeenCalledWith(KEY, 's1');
	});

	it('evicts nothing without a key', () => {
		const {w} = win('#s1');
		const cache = fakeCache();
		handleHydrationRejected({sessionId: 's1', serverKey: null, win: w, cache});
		expect(w.history.replaceState).toHaveBeenCalled();
		expect(cache.remove).not.toHaveBeenCalled();
	});
});
