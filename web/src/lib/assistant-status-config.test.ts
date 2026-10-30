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
