import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

// The assistant status (spec assistant-session-and-channels) reaches the web the
// way searchFolder does: /config carries it, fetchConfig publishes it to a store.
// An older server (or an unconfigured one) must land on "not configured", never
// on undefineds the UI then has to defend against.

function stubBrowserGlobals(): void {
	(globalThis as any).localStorage = {
		getItem: () => JSON.stringify({token: ''}),
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

function stubConfig(body: unknown): void {
	(globalThis as any).fetch = vi.fn(() =>
		Promise.resolve({ok: true, json: async () => body}),
	);
}

beforeEach(() => {
	vi.resetModules();
	stubBrowserGlobals();
});

afterEach(() => {
	delete (globalThis as any).window;
	delete (globalThis as any).localStorage;
	delete (globalThis as any).fetch;
});

describe('fetchConfig assistant status', () => {
	it('publishes the server status alongside searchFolder', async () => {
		const assistant = {
			configured: true,
			folder: '/home/me/assistant',
			active: false,
			lock: {
				state: 'refused',
				reason: 'live-lock',
				holder: {pid: 42, host: 'telemaque'},
				message: 'in use by another wherever server',
			},
		};
		stubConfig({searchFolder: '/home/me/searches', assistant});
		const {fetchConfig, assistantStatusStore, searchFolderStore} =
			await import('./session-store');
		const {get} = await import('svelte/store');
		await fetchConfig();
		expect(get(searchFolderStore)).toBe('/home/me/searches');
		expect(get(assistantStatusStore)).toEqual(assistant);
	});

	it('defaults to "not configured" for a server that sends no assistant status', async () => {
		stubConfig({});
		const {fetchConfig, assistantStatusStore} = await import('./session-store');
		const {get} = await import('svelte/store');
		await fetchConfig();
		expect(get(assistantStatusStore)).toEqual({
			configured: false,
			folder: null,
			active: false,
			lock: null,
		});
	});
});

// The current assistant session (assistant-pointer-and-reset): /config carries
// it while active, and an `assistant_status` frame moves it live.
describe('assistant current-session pointer', () => {
	const active = {
		configured: true,
		folder: '/home/me/assistant',
		active: true,
		lock: {state: 'held'},
		currentSessionId: 'id-1',
		currentSessionFile: '/s/1.jsonl',
	};

	it('publishes the pointer from /config', async () => {
		stubConfig({assistant: active});
		const {fetchConfig, assistantStatusStore} = await import('./session-store');
		const {get} = await import('svelte/store');
		await fetchConfig();
		expect(get(assistantStatusStore).currentSessionFile).toBe('/s/1.jsonl');
	});

	it('applyAssistantPointer moves it without touching the rest', async () => {
		stubConfig({assistant: active});
		const {fetchConfig, assistantStatusStore, applyAssistantPointer} =
			await import('./session-store');
		const {get} = await import('svelte/store');
		await fetchConfig();
		applyAssistantPointer({
			currentSessionId: 'id-2',
			currentSessionFile: '/s/2.jsonl',
		});
		expect(get(assistantStatusStore)).toEqual({
			...active,
			currentSessionId: 'id-2',
			currentSessionFile: '/s/2.jsonl',
		});
	});

	it('applyAssistantPointer is ignored while the assistant is not active', async () => {
		stubConfig({});
		const {fetchConfig, assistantStatusStore, applyAssistantPointer} =
			await import('./session-store');
		const {get} = await import('svelte/store');
		await fetchConfig();
		applyAssistantPointer({currentSessionId: 'x', currentSessionFile: '/x'});
		expect(get(assistantStatusStore).currentSessionFile).toBeUndefined();
	});

	it('isAssistantSession matches only the current pointer', async () => {
		const {isAssistantSession} = await import('./session-store');
		expect(isAssistantSession(active as any, '/s/1.jsonl')).toBe(true);
		expect(isAssistantSession(active as any, '/s/2.jsonl')).toBe(false);
		expect(isAssistantSession(active as any, null)).toBe(false);
		expect(
			isAssistantSession({...active, active: false} as any, '/s/1.jsonl'),
		).toBe(false);
	});
});
