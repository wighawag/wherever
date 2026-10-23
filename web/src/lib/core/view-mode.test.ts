import {describe, it, expect} from 'vitest';
import {decideHashJoin, isSearchActive, isSessionPendingOpen} from './view-mode.js';

// Regression: the composer showed the search input + "Search" button while the
// message area showed "Loading session..." because searchActive only checked
// !sessionFile and ignored the loading/resyncing/hash state. isSearchActive must
// be false whenever a session is mid-open, so the two views stay consistent.

const base = {
	connected: true,
	searchConfigured: true,
	hasSession: false,
	loading: false,
	resyncing: false,
	hasSessionHash: false,
};

describe('isSearchActive', () => {
	it('is true at the genuine no-session home state', () => {
		expect(isSearchActive(base)).toBe(true);
	});

	it('is false while a session is loading (the reported bug)', () => {
		expect(isSearchActive({...base, loading: true})).toBe(false);
	});

	it('is false while a session is resyncing on reconnect', () => {
		expect(isSearchActive({...base, resyncing: true})).toBe(false);
	});

	it('is false when a hash points at a session about to open', () => {
		expect(isSearchActive({...base, hasSessionHash: true})).toBe(false);
	});

	it('is false when a session is already active', () => {
		expect(isSearchActive({...base, hasSession: true})).toBe(false);
	});

	it('is false when disconnected', () => {
		expect(isSearchActive({...base, connected: false})).toBe(false);
	});

	it('is false when no search folder is configured', () => {
		expect(isSearchActive({...base, searchConfigured: false})).toBe(false);
	});
});

describe('isSessionPendingOpen', () => {
	it('is true for loading, resyncing, or a session hash', () => {
		expect(isSessionPendingOpen({...base, loading: true})).toBe(true);
		expect(isSessionPendingOpen({...base, resyncing: true})).toBe(true);
		expect(isSessionPendingOpen({...base, hasSessionHash: true})).toBe(true);
	});

	it('is false at rest with no session opening', () => {
		expect(isSessionPendingOpen(base)).toBe(false);
	});
});

describe('isSessionPendingOpen with a failed load', () => {
	it('a hash is no longer a pending open once its load has failed', () => {
		expect(isSessionPendingOpen({...base, hasSessionHash: true, loadFailed: true})).toBe(false);
		expect(isSearchActive({...base, hasSessionHash: true, loadFailed: true})).toBe(true);
	});

	it('loading still counts as pending even if a stale error is set', () => {
		expect(isSessionPendingOpen({...base, loading: true, loadFailed: true})).toBe(true);
	});
});

// Regression: a hash naming a session whose load fails with an untagged
// session_error (e.g. the session was deleted) re-joined every ~300 ms forever.
describe('decideHashJoin', () => {
	const h = {
		connected: true,
		hashId: 'sid-1',
		currentSessionId: null,
		loading: false,
		resyncing: false,
		attemptedHashId: null,
	};

	it('joins a hash session it has not tried yet', () => {
		expect(decideHashJoin(h)).toBe('join');
	});

	it('reports failure (no retry) once the attempted load ended without the session', () => {
		expect(decideHashJoin({...h, attemptedHashId: 'sid-1'})).toBe('failed');
	});

	it('does not report failure while some session is active (hash naming it by path)', () => {
		expect(
			decideHashJoin({...h, hashId: '/x/s.jsonl', currentSessionId: 'sid-x', attemptedHashId: '/x/s.jsonl'}),
		).toBe('skip');
	});

	it('joins again when the hash changed to a different session', () => {
		expect(decideHashJoin({...h, hashId: 'sid-2', attemptedHashId: 'sid-1'})).toBe('join');
	});

	it('skips while the load is in flight, resyncing, or already active', () => {
		expect(decideHashJoin({...h, attemptedHashId: 'sid-1', loading: true})).toBe('skip');
		expect(decideHashJoin({...h, resyncing: true})).toBe('skip');
		expect(decideHashJoin({...h, currentSessionId: 'sid-1'})).toBe('skip');
	});

	it('skips with no hash or no connection', () => {
		expect(decideHashJoin({...h, hashId: ''})).toBe('skip');
		expect(decideHashJoin({...h, connected: false})).toBe('skip');
	});
});
