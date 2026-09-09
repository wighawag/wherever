import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

// The restore panel PRE-FILLS its editable URL field from the server's remote
// candidates, so this fetch is the data path behind "one tap restores the repo"
// on a phone. Two properties matter and neither is about the UI:
//
//  - it asks the on-demand endpoint for the exact missing path (the probe shells
//    out to a provider CLI on the server, so it must be one call per folder, not
//    per keystroke);
//  - a candidate is a CONVENIENCE, never a gate: an unreachable or unhappy
//    endpoint degrades to an empty list, leaving the field empty for the user to
//    paste into rather than breaking the panel that is the only remedy on offer.

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
});

describe('fetchRemoteCandidates', () => {
	it('asks the on-demand endpoint for the missing path and returns the ordered list', async () => {
		const calls: string[] = [];
		(globalThis as any).fetch = vi.fn((url: string) => {
			calls.push(url);
			return Promise.resolve({
				ok: true,
				json: async () => ({
					resolvedPath: '/home/u/dev/github/owner/repo',
					candidates: [
						{url: 'git@github.com:owner/repo.git', source: 'probe'},
						{url: 'git@github.com:other/repo.git', source: 'path-convention'},
					],
				}),
			});
		});

		const {fetchRemoteCandidates} = await import('./session-store');
		const candidates = await fetchRemoteCandidates(
			'/home/u/dev/github/owner/repo',
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('/remote-candidates?path=');
		expect(calls[0]).toContain(
			encodeURIComponent('/home/u/dev/github/owner/repo'),
		);
		// The token rides along like every other API call, encoded.
		expect(calls[0]).toContain(`token=${encodeURIComponent('tok en')}`);
		// Order is the server's (probe first), and the panel pre-fills with [0].
		expect(candidates.map((c) => c.url)).toEqual([
			'git@github.com:owner/repo.git',
			'git@github.com:other/repo.git',
		]);
	});

	it('degrades to an empty list rather than throwing at the panel', async () => {
		(globalThis as any).fetch = vi.fn(() =>
			Promise.reject(new Error('offline')),
		);
		const {fetchRemoteCandidates} = await import('./session-store');
		await expect(
			fetchRemoteCandidates('/home/u/dev/github/owner/repo'),
		).resolves.toEqual([]);

		(globalThis as any).fetch = vi.fn(() =>
			Promise.resolve({ok: false, status: 403}),
		);
		vi.resetModules();
		const reloaded = await import('./session-store');
		await expect(
			reloaded.fetchRemoteCandidates('/home/u/dev/github/owner/repo'),
		).resolves.toEqual([]);
	});

	it('never calls the endpoint for an empty path', async () => {
		const fetchMock = vi.fn();
		(globalThis as any).fetch = fetchMock;
		const {fetchRemoteCandidates} = await import('./session-store');
		await expect(fetchRemoteCandidates('   ')).resolves.toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
