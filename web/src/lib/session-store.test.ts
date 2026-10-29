import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'svelte/store';

// Regression: fetchSessions() coalesces a stream of `sessions_updated` events
// into as few /sessions requests as possible. The in-flight branch returned a
// promise whose resolver had just been pushed onto resolveQueue, but the
// running pass had already CLAIMED that queue and nothing scheduled a further
// pass -- so `await fetchSessions()` during an in-flight fetch could hang
// forever. Every returned promise must settle, and mid-flight requests must
// collapse into exactly one trailing re-fetch.

let fetchCalls: number;
let releaseFetch: Array<() => void>;

function stubBrowserGlobals(): void {
	(globalThis as any).localStorage = {
		getItem: () => null,
		setItem: () => {},
	};
	(globalThis as any).window = {
		location: {
			protocol: 'http:',
			host: 'localhost:31415',
			hostname: 'localhost',
			port: '31415',
		},
	};
}

// A fetch that only resolves when the test says so, so we can hold a request
// "in flight" while queueing more.
function stubFetch(): void {
	fetchCalls = 0;
	releaseFetch = [];
	(globalThis as any).fetch = vi.fn(() => {
		fetchCalls++;
		return new Promise((resolve) => {
			releaseFetch.push(() =>
				resolve({
					ok: true,
					json: async () => ({folders: [], activeSessions: []}),
				}),
			);
		});
	});
}

/** Let queued microtasks/timers run. */
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
	vi.resetModules();
	stubBrowserGlobals();
	stubFetch();
});

afterEach(() => {
	delete (globalThis as any).window;
	delete (globalThis as any).localStorage;
	delete (globalThis as any).fetch;
});

describe('fetchSessions coalescing', () => {
	it('settles a promise queued while a fetch is in flight', async () => {
		const {fetchSessions} = await import('./session-store.js');

		const first = fetchSessions();
		await tick(200); // let the debounce fire; the fetch is now in flight
		expect(fetchCalls).toBe(1);

		// Arrives mid-flight: the old code returned a promise nothing would ever
		// resolve.
		const second = fetchSessions();

		let secondSettled = false;
		void second.then(() => {
			secondSettled = true;
		});

		releaseFetch.shift()!(); // finish the in-flight request
		await tick(200);
		expect(fetchCalls).toBe(2); // exactly one trailing re-fetch
		releaseFetch.shift()!();

		await expect(Promise.all([first, second])).resolves.toBeDefined();
		await tick();
		expect(secondSettled).toBe(true);
	});

	it('collapses a burst of mid-flight requests into one re-fetch', async () => {
		const {fetchSessions} = await import('./session-store.js');

		const first = fetchSessions();
		await tick(200);
		expect(fetchCalls).toBe(1);

		const queued = [fetchSessions(), fetchSessions(), fetchSessions()];

		releaseFetch.shift()!();
		await tick(200);
		expect(fetchCalls).toBe(2); // three requests -> ONE trailing re-fetch
		releaseFetch.shift()!();

		await expect(Promise.all([first, ...queued])).resolves.toBeDefined();
	});

	it('debounces rapid successive requests into a single fetch', async () => {
		const {fetchSessions} = await import('./session-store.js');

		const all = [fetchSessions(), fetchSessions(), fetchSessions()];
		await tick(200);
		expect(fetchCalls).toBe(1);

		releaseFetch.shift()!();
		await expect(Promise.all(all)).resolves.toBeDefined();
	});
});

describe('setSessionWorking', () => {
	it('flips one row in place and skips no-op writes', async () => {
		const {sessionFolders, setSessionWorking} =
			await import('./session-store.js');
		const row = (path: string) => ({
			path,
			id: path,
			created: '',
			modified: '',
			messageCount: 0,
			firstMessage: '',
			isActive: true,
			clientCount: 0,
		});
		sessionFolders.set({
			folders: [{path: '/p', name: 'p', sessions: [row('/a'), row('/b')]}],
			activeSessions: [],
			currentSession: null,
			loading: false,
		});
		let writes = 0;
		const unsub = sessionFolders.subscribe(() => writes++);
		writes = 0;

		setSessionWorking('/a', true);
		let folders = get(sessionFolders).folders;
		expect(folders[0].sessions[0].isWorking).toBe(true);
		expect(folders[0].sessions[1].isWorking).toBeUndefined();
		expect(writes).toBe(1);

		setSessionWorking('/a', true); // already working: no write
		setSessionWorking('/missing', true); // unknown row: no write
		expect(writes).toBe(1);

		setSessionWorking('/a', false);
		folders = get(sessionFolders).folders;
		expect(folders[0].sessions[0].isWorking).toBe(false);
		expect(writes).toBe(2);
		unsub();
	});
});
