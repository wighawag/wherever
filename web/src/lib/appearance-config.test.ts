import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

// The instance appearance (accent, label, frame, pattern) is what lets two
// dashboards mirroring the same pi sessions be told apart at a glance, so the
// mapping from /config to the store is load-bearing rather than cosmetic.
//
// It is tested HERE, in the node suite, because that is the property worth
// keeping: session-store PUBLISHES the appearance and nothing more. Painting it
// onto the document element belongs to +layout.svelte, which re-themes off this
// store.
//
// That seam needs a TRIPWIRE rather than merely the absence of a document:
// fetchConfig wraps its body in try/catch, so a DOM write that migrates back in
// would throw, get swallowed as a fetch failure, and leave these assertions
// passing after the store had already been set. The tripwire below records any
// access instead, so the test fails loudly rather than silently going green.
//
// It is armed AFTER the imports and disarmed straight after the call, so it
// measures the fetch path and nothing else: Svelte's own client runtime reads
// document.contentType once at import time, which is not what this is policing.
function installDocumentTripwire(): string[] {
	const touched: string[] = [];
	(globalThis as any).document = new Proxy(
		{},
		{
			get(_target, prop) {
				touched.push(String(prop));
				return undefined;
			},
		},
	);
	return touched;
}

function stubBrowserGlobals(): void {
	(globalThis as any).localStorage = {
		getItem: () => JSON.stringify({token: 'tok en'}),
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

beforeEach(() => {
	vi.resetModules();
	stubBrowserGlobals();
});

afterEach(() => {
	delete (globalThis as any).window;
	delete (globalThis as any).localStorage;
	delete (globalThis as any).fetch;
	delete (globalThis as any).document;
});

describe('fetchConfig appearance', () => {
	it('publishes the instance appearance to the store without touching the document', async () => {
		(globalThis as any).fetch = vi.fn(() =>
			Promise.resolve({
				ok: true,
				json: async () => ({
					appearance: {
						label: 'telemaque',
						accent: '#ff8800',
						colors: {brandDark: '#101014'},
						frame: true,
						pattern: 'stripes',
					},
				}),
			}),
		);

		const {fetchConfig, appearanceStore} = await import('./session-store');
		const {get} = await import('svelte/store');

		const touched = installDocumentTripwire();
		await fetchConfig();
		delete (globalThis as any).document;

		expect(get(appearanceStore)).toEqual({
			label: 'telemaque',
			accent: '#ff8800',
			colors: {brandDark: '#101014'},
			frame: true,
			pattern: 'stripes',
		});
		// The seam: publishing the appearance is all this module may do with it.
		expect(touched).toEqual([]);
	});

	it('falls back to the compiled defaults for a server that configures no appearance', async () => {
		// An unconfigured server is the common case, and it must land on the
		// compiled palette rather than on undefineds the theming code would then
		// have to defend against.
		(globalThis as any).fetch = vi.fn(() =>
			Promise.resolve({ok: true, json: async () => ({})}),
		);

		const {fetchConfig, appearanceStore} = await import('./session-store');
		const {defaultAppearance} = await import('./theme');
		const {get} = await import('svelte/store');
		await fetchConfig();

		expect(get(appearanceStore)).toEqual(defaultAppearance);
	});

	it('leaves the current appearance alone when /config cannot be reached', async () => {
		// Losing the server must not strip the palette back to grey: the dashboard
		// keeps showing the instance you last talked to.
		(globalThis as any).fetch = vi.fn(() =>
			Promise.resolve({
				ok: true,
				json: async () => ({appearance: {label: 'telemaque'}}),
			}),
		);
		const {fetchConfig, appearanceStore} = await import('./session-store');
		const {get} = await import('svelte/store');
		await fetchConfig();
		expect(get(appearanceStore).label).toBe('telemaque');

		(globalThis as any).fetch = vi.fn(() => Promise.reject(new Error('down')));
		await expect(fetchConfig()).resolves.toBeUndefined();
		expect(get(appearanceStore).label).toBe('telemaque');
	});
});
