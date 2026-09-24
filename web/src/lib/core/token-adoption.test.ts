import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

// A single link must be enough to reach a token-protected instance: opening
// `https://host/#token=SECRET` has to leave a working session behind (page,
// API calls and WebSocket all authenticated) without the user ever visiting
// Connection Settings. The assertions below therefore look at the two things
// that actually carry that outcome -- the token PERSISTED in the config entry,
// and the URL passed to replaceState -- rather than at "the page rendered",
// which is true whether or not the token was ever picked up.

const CONFIG_KEY = 'wherever-config';

let replaceStateCalls: Array<{state: unknown; url: string}>;
let pushStateCalls: number;

function stubBrowserGlobals(opts: {
	search?: string;
	hash?: string;
	pathname?: string;
	port?: string;
	stored?: Record<string, unknown> | string | null;
}): void {
	const store: Record<string, string> = {};
	if (typeof opts.stored === 'string') {
		store[CONFIG_KEY] = opts.stored;
	} else if (opts.stored) {
		store[CONFIG_KEY] = JSON.stringify(opts.stored);
	}
	(globalThis as any).localStorage = {
		getItem: (k: string) => (k in store ? store[k] : null),
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
		removeItem: (k: string) => {
			delete store[k];
		},
	};
	replaceStateCalls = [];
	pushStateCalls = 0;
	(globalThis as any).window = {
		location: {
			protocol: 'https:',
			host: 'host',
			hostname: 'host',
			port: opts.port ?? '',
			pathname: opts.pathname ?? '/',
			search: opts.search ?? '',
			hash: opts.hash ?? '',
		},
		history: {
			state: {sveltekit: 1},
			replaceState: (state: unknown, _title: string, url: string) => {
				replaceStateCalls.push({state, url});
			},
			pushState: () => {
				pushStateCalls++;
			},
		},
	};
}

function storedConfig(): Record<string, unknown> | null {
	const raw = (globalThis as any).localStorage.getItem(CONFIG_KEY);
	return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	delete (globalThis as any).window;
	delete (globalThis as any).localStorage;
});

describe('readUrlToken', () => {
	it('parses the fragment as key/value pairs and keeps the other keys', async () => {
		const {readUrlToken} = await import('$lib/core/token-adoption');
		const read = readUrlToken('', '#token=SECRET&foo=1');
		expect(read.token).toBe('SECRET');
		expect(read.present).toBe(true);
		expect(read.hash).toBe('#foo=1');
	});

	it('decodes a percent-encoded token', async () => {
		const {readUrlToken} = await import('$lib/core/token-adoption');
		expect(readUrlToken('', '#token=a%2Fb%20c%26d').token).toBe('a/b c&d');
	});

	it('reports a blank token as present but unusable', async () => {
		const {readUrlToken} = await import('$lib/core/token-adoption');
		const read = readUrlToken('', '#token=%20%20');
		expect(read.present).toBe(true);
		expect(read.token).toBeNull();
	});

	it('leaves a non key/value fragment untouched', async () => {
		const {readUrlToken} = await import('$lib/core/token-adoption');
		const read = readUrlToken('', '#/some/route');
		expect(read.present).toBe(false);
		expect(read.hash).toBe('#/some/route');
	});

	it('prefers the hash over the query when both carry a token', async () => {
		const {readUrlToken} = await import('$lib/core/token-adoption');
		expect(readUrlToken('?token=FROM_QUERY', '#token=FROM_HASH').token).toBe(
			'FROM_HASH',
		);
	});

	it('keeps a token VERBATIM, because the server compares it byte for byte', async () => {
		const {readUrlToken} = await import('$lib/core/token-adoption');
		// `--token " pad "` is a supported install, so trimming here would change
		// which string authenticates. Only blankness is decided by trimming.
		expect(readUrlToken('', '#token=%20pad%20').token).toBe(' pad ');
	});

	it('recognises the key in any case, so a near-miss never reaches the session-id reader', async () => {
		const {readUrlToken} = await import('$lib/core/token-adoption');
		// An unrecognised fragment is read as a session id by +page.svelte, sent to
		// the server and echoed back into the DOM in the error. It must be taken
		// here instead.
		const read = readUrlToken('', '#TOKEN=SECRET');
		expect(read.token).toBe('SECRET');
		expect(read.hash).toBe('');
	});

	it('finds the usable value when the key is repeated', async () => {
		const {readUrlToken} = await import('$lib/core/token-adoption');
		const read = readUrlToken('', '#token=&token=REAL');
		expect(read.token).toBe('REAL');
		// Every occurrence is removed, not just the first.
		expect(read.hash).toBe('');
	});

	it('leaves a session deep link in the fragment intact while taking a query token', async () => {
		const {readUrlToken} = await import('$lib/core/token-adoption');
		// The fragment is this app's session-id channel; a query-token link must
		// not disturb it, or the deep link stops resolving.
		const hash = '#%2Fhome%2Fu%2Fproj%2Fsession.jsonl';
		const read = readUrlToken('?token=SECRET', hash);
		expect(read.token).toBe('SECRET');
		expect(read.hash).toBe(hash);
		expect(read.search).toBe('');
	});
});

describe('adoptTokenFromUrl', () => {
	it('adopts and persists a token from the hash', async () => {
		stubBrowserGlobals({hash: '#token=SECRET'});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(true);
		expect(storedConfig()?.token).toBe('SECRET');
	});

	it('removes the token from the address bar with replaceState, not pushState', async () => {
		stubBrowserGlobals({hash: '#token=SECRET', pathname: '/'});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		adoptTokenFromUrl();
		expect(replaceStateCalls).toHaveLength(1);
		expect(replaceStateCalls[0].url).toBe('/');
		expect(replaceStateCalls[0].url).not.toContain('SECRET');
		expect(replaceStateCalls[0].url).not.toContain('token');
		// A pushed entry would keep the secret in the back-button history.
		expect(pushStateCalls).toBe(0);
		// The router's own history state survives the scrub.
		expect(replaceStateCalls[0].state).toEqual({sveltekit: 1});
	});

	it('keeps the rest of the fragment and the path when scrubbing', async () => {
		stubBrowserGlobals({
			hash: '#token=SECRET&view=chat',
			search: '?q=hello',
			pathname: '/sessions',
		});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		adoptTokenFromUrl();
		expect(replaceStateCalls[0].url).toBe('/sessions?q=hello#view=chat');
	});

	it('MERGES into the stored config, so other settings survive', async () => {
		stubBrowserGlobals({
			hash: '#token=SECRET',
			stored: {
				host: 'box.example',
				port: 8443,
				token: 'OLD',
				hideThinking: true,
				beepDefault: true,
				beepSoundUrl: 'ding.wav',
			},
		});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		adoptTokenFromUrl();
		expect(storedConfig()).toEqual({
			host: 'box.example',
			port: 8443,
			token: 'SECRET',
			hideThinking: true,
			beepDefault: true,
			beepSoundUrl: 'ding.wav',
		});
	});

	it('does NOT clear an existing token when the hash token is empty', async () => {
		stubBrowserGlobals({
			hash: '#token=',
			stored: {host: 'box.example', port: 8443, token: 'WORKING'},
		});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(false);
		expect(storedConfig()?.token).toBe('WORKING');
		// Still scrubbed: the malformed link does not linger in the address bar.
		expect(replaceStateCalls).toHaveLength(1);
		expect(replaceStateCalls[0].url).toBe('/');
	});

	it('does NOT clear an existing token when the hash token is whitespace only', async () => {
		stubBrowserGlobals({
			hash: '#token=%20',
			stored: {token: 'WORKING'},
		});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(false);
		expect(storedConfig()?.token).toBe('WORKING');
	});

	it('stores a whitespace-padded token verbatim, end to end', async () => {
		// Asserted through the STORE, not just the parse: a `.trim()` added at the
		// setItem call would sail past the readUrlToken test.
		stubBrowserGlobals({hash: '#token=%20pad%20'});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(true);
		expect(storedConfig()?.token).toBe(' pad ');
	});

	it('recognises the key in any case in the QUERY too', async () => {
		stubBrowserGlobals({search: '?TOKEN=SECRET'});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(true);
		expect(storedConfig()?.token).toBe('SECRET');
		expect(replaceStateCalls[0].url).toBe('/');
	});

	it('still accepts a legacy query token, and scrubs that too', async () => {
		stubBrowserGlobals({search: '?token=SECRET&debug=1'});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(true);
		expect(storedConfig()?.token).toBe('SECRET');
		expect(replaceStateCalls[0].url).toBe('/?debug=1');
		expect(replaceStateCalls[0].url).not.toContain('SECRET');
	});

	it('does nothing at all when there is no fragment and no query', async () => {
		stubBrowserGlobals({stored: {host: 'box.example', port: 8443, token: 'X'}});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(false);
		expect(replaceStateCalls).toHaveLength(0);
		expect(storedConfig()).toEqual({
			host: 'box.example',
			port: 8443,
			token: 'X',
		});
	});

	it('leaves an unrelated fragment alone', async () => {
		stubBrowserGlobals({hash: '#/deep/link'});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(false);
		expect(replaceStateCalls).toHaveLength(0);
	});

	it('survives a corrupt stored config by writing a fresh one', async () => {
		stubBrowserGlobals({hash: '#token=SECRET', stored: 'not json'});
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(true);
		expect(storedConfig()).toEqual({token: 'SECRET'});
	});

	it('is a no-op under SSR, where there is no window', async () => {
		delete (globalThis as any).window;
		delete (globalThis as any).localStorage;
		const {adoptTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrl()).toBe(false);
	});

	it('is idempotent through adoptTokenFromUrlOnce', async () => {
		stubBrowserGlobals({hash: '#token=SECRET'});
		const {adoptTokenFromUrlOnce} = await import('$lib/core/token-adoption');
		expect(adoptTokenFromUrlOnce()).toBe(true);
		expect(adoptTokenFromUrlOnce()).toBe(false);
		expect(replaceStateCalls).toHaveLength(1);
		expect(storedConfig()?.token).toBe('SECRET');
	});
});

describe('scrubTokenFromUrl (the second pass the router forces)', () => {
	// The bug this exists for: SvelteKit boots in client-side-routing mode, and
	// its initial `enter` navigation commits AFTER the route modules are
	// imported, re-stamping the history entry with the href captured at boot. So
	// the scrub done during adoption is undone ~12ms later and the token comes
	// BACK into the address bar. Measured in a real browser; invisible here,
	// because this suite has no router.
	it('removes the token when called again later, and is idempotent', async () => {
		stubBrowserGlobals({hash: '#token=SECRET'});
		const {scrubTokenFromUrl} = await import('$lib/core/token-adoption');
		expect(scrubTokenFromUrl()).toBe(true);
		expect(replaceStateCalls[0].url).toBe('/');

		// Simulate the router putting it back, then scrub again.
		(globalThis as any).window.location.hash = '#token=SECRET';
		expect(scrubTokenFromUrl()).toBe(true);
		expect(replaceStateCalls).toHaveLength(2);

		// With a clean URL it is a no-op rather than a spurious history write.
		(globalThis as any).window.location.hash = '';
		expect(scrubTokenFromUrl()).toBe(false);
		expect(replaceStateCalls).toHaveLength(2);
	});

	it('keeps the rest of the URL when scrubbing late', async () => {
		stubBrowserGlobals({
			hash: '#token=SECRET&view=chat',
			search: '?q=x',
			pathname: '/p',
		});
		const {scrubTokenFromUrl} = await import('$lib/core/token-adoption');
		scrubTokenFromUrl();
		expect(replaceStateCalls[0].url).toBe('/p?q=x#view=chat');
	});

	it('is wired into +layout.svelte AFTER navigation', () => {
		// A source-level tripwire, which is the only kind available: this suite is
		// node-only with no Svelte component support (web/vitest.config.ts), so the
		// wiring cannot be executed here. Without the afterNavigate call the token
		// stays in the address bar in every real browser while every test here
		// still passes, which is exactly how this shipped broken the first time.
		const layout = readFileSync(
			fileURLToPath(new URL('../../routes/+layout.svelte', import.meta.url)),
			'utf8',
		);
		expect(layout).toContain('scrubTokenFromUrl');
		expect(layout).toContain('afterNavigate');
		// The call must be INSIDE afterNavigate, not merely present in the file.
		const after = layout.slice(layout.indexOf('afterNavigate('));
		expect(after.slice(0, after.indexOf('});'))).toContain(
			'scrubTokenFromUrl()',
		);
	});
});

describe('getConfig() adoption wiring', () => {
	// The ordering hazard: wherever.ts calls getConfig() at MODULE scope, so a
	// hook in +layout.svelte would run too late. Importing the real module is
	// what proves adoption already happened by then.
	it('exposes a hash token through getConfig on first import', async () => {
		stubBrowserGlobals({hash: '#token=SECRET'});
		const {getConfig} = await import('$lib/wherever');
		expect(getConfig().token).toBe('SECRET');
		expect(storedConfig()?.token).toBe('SECRET');
		expect(replaceStateCalls[0].url).toBe('/');
	});

	it('keeps the stored host/port while adopting the token', async () => {
		stubBrowserGlobals({
			hash: '#token=SECRET',
			stored: {host: 'box.example', port: 8443, token: '', hideThinking: true},
		});
		const {getConfig} = await import('$lib/wherever');
		const config = getConfig();
		expect(config.token).toBe('SECRET');
		expect(config.host).toBe('box.example');
		expect(config.port).toBe(8443);
		expect(config.hideThinking).toBe(true);
	});

	it('gives a fresh browser a usable port alongside the adopted token', async () => {
		stubBrowserGlobals({hash: '#token=SECRET'});
		const {getConfig} = await import('$lib/wherever');
		const config = getConfig();
		expect(config.token).toBe('SECRET');
		// https with no explicit port in the URL => 443, not undefined.
		expect(config.port).toBe(443);
		expect(config.host).toBe('host');
	});

	it('gives a usable port on the default port too, where the legacy healing does not fire', async () => {
		// The case the README's own link documents (https://host:31415/#token=...).
		// The pre-existing legacy healing only assigns a port when the page port
		// DIFFERS from 31415, so without the explicit fill a config written by
		// adoption alone would reach the client as port undefined and dial
		// wss://host:undefined/ws.
		stubBrowserGlobals({hash: '#token=SECRET', port: '31415'});
		const {getConfig} = await import('$lib/wherever');
		const config = getConfig();
		expect(config.token).toBe('SECRET');
		expect(config.port).toBe(31415);
	});

	it('keeps working on the next load, when the URL is already clean', async () => {
		// The reload half of the promise: the link is consumed once, the session
		// survives because the token was persisted, not merely held in memory.
		stubBrowserGlobals({hash: '#token=SECRET'});
		const first = await import('$lib/wherever');
		expect(first.getConfig().token).toBe('SECRET');
		const persisted = (globalThis as any).localStorage.getItem(CONFIG_KEY);

		// Second boot: fresh modules, no fragment, same storage.
		vi.resetModules();
		stubBrowserGlobals({stored: JSON.parse(persisted)});
		const second = await import('$lib/wherever');
		expect(second.getConfig().token).toBe('SECRET');
		expect(replaceStateCalls).toHaveLength(0);
	});

	it('adopts before session-store reads the token straight from storage', async () => {
		stubBrowserGlobals({hash: '#token=SECRET'});
		const {getToken} = await import('$lib/session-store');
		expect(getToken()).toBe('SECRET');
	});
});
