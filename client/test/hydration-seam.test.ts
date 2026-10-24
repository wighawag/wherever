import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient, serverKey} from '../src/client.js';
import type {HydrationSnapshot, WhereverState} from '../src/types.js';
import {makeWSFactory} from './harness.js';

// The client half of instant resume (ADR 0013): a conversation read from the
// web's on-device cache is hydrated into the store BEFORE the socket exists, the
// normal rejoin replaces it with the authoritative history, a refused load
// evicts it, and the store is stamped with the server that delivered it so a
// connect to a different server never preserves or rejoins it.

function installLocalStorage() {
	const store = new Map<string, string>();
	(globalThis as any).localStorage = {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	};
	return store;
}

const FILE = '/tmp/project/session.jsonl';
const CFG = {host: 'localhost', port: 1234, token: 'secret', secure: false};

function snapshot(overrides: Partial<HydrationSnapshot> = {}): HydrationSnapshot {
	return {
		serverKey: serverKey(CFG),
		sessionId: 'sid-1',
		sessionFile: FILE,
		cwd: '/tmp/project',
		model: 'fake:model',
		messages: [
			{id: 'c1', role: 'user', content: 'cached question', timestamp: 1, isStreaming: false},
			{id: 'c2', role: 'assistant', content: 'cached answer', timestamp: 2, isStreaming: false},
		],
		historyTotalCount: 40,
		historyOffset: 38,
		...overrides,
	};
}

const created = {
	type: 'session_created',
	sessionId: 'sid-1',
	sessionFile: FILE,
	cwd: '/tmp/project',
	model: 'fake:model',
	isStreaming: false,
};

const history = {
	type: 'message_history',
	sessionId: 'sid-1',
	messages: [
		{role: 'user', content: 'fresh question', timestamp: 1},
		{role: 'assistant', content: 'fresh answer', timestamp: 2},
	],
	totalCount: 40,
	offset: 38,
};

describe('serverKey', () => {
	it('is synchronous, stable and host:port prefixed', () => {
		const a = serverKey(CFG);
		expect(typeof a).toBe('string');
		expect(a).toBe(serverKey({...CFG}));
		expect(a.startsWith('localhost:1234')).toBe(true);
		expect(a).not.toContain('secret');
	});

	it('differs by host, port and token', () => {
		const a = serverKey(CFG);
		expect(serverKey({...CFG, host: 'other'})).not.toBe(a);
		expect(serverKey({...CFG, port: 4321})).not.toBe(a);
		expect(serverKey({...CFG, token: 'other'})).not.toBe(a);
		expect(serverKey({...CFG, token: undefined})).not.toBe(a);
	});

	it('ignores an http(s):// prefix on the host, like connect()', () => {
		expect(serverKey({...CFG, host: 'http://localhost'})).toBe(serverKey(CFG));
	});
});

describe('hydrateCachedSession', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;
	const state = () => get<WhereverState>(client.stateStore);

	beforeEach(() => {
		vi.useFakeTimers();
		installLocalStorage();
		ws = makeWSFactory();
		client = new WhereverClient({...CFG, WebSocketCtor: ws.ctor});
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	it('paints the cached session as resyncing, stamped, non-authoritative', () => {
		client.hydrateCachedSession(snapshot());
		const s = state();
		expect(s.session).toBe(FILE);
		expect(s.sessionId).toBe('sid-1');
		expect(s.activeSessionFile).toBe(FILE);
		expect(s.activeCwd).toBe('/tmp/project');
		expect(s.activeModel).toBe('fake:model');
		expect(s.messages.map((m) => m.content)).toEqual(['cached question', 'cached answer']);
		expect(s.resyncing).toBe(true);
		expect(s.isStreaming).toBe(false);
		expect(s.serverKey).toBe(serverKey(CFG));
		expect(s.historyAuthoritative).toBe(false);
		expect(s.agentPending).toBe(false);
		expect(s.folderConflict).toBe(null);
		expect(s.sudoPrompt).toBe(null);
		expect(s.readOnly).toBe(false);
		expect(s.loadingSession).toBe(false);
	});

	it('then connect(cfg, true): keeps the messages, rejoins, and the history replaces them', () => {
		client.hydrateCachedSession(snapshot());
		client.connect(undefined, true);
		expect(state().messages.length).toBe(2);
		ws.last().open();
		expect(state().messages.length).toBe(2);
		expect(ws.last().lastSentOfType('session_load')?.sessionFile).toBe(FILE);
		ws.last().receive(created);
		expect(state().serverKey).toBe(serverKey(CFG));
		ws.last().receive(history);
		const s = state();
		expect(s.messages.map((m) => m.content)).toEqual(['fresh question', 'fresh answer']);
		expect(s.resyncing).toBe(false);
		expect(s.historyAuthoritative).toBe(true);
	});

	it('is a no-op after session_created', () => {
		client.connect();
		ws.last().open();
		client.joinSession(FILE);
		ws.last().receive(created);
		const before = state();
		client.hydrateCachedSession(snapshot({sessionId: 'other', sessionFile: '/x.jsonl'}));
		expect(state()).toEqual(before);
	});

	it('is a no-op while connected', () => {
		client.connect();
		ws.last().open();
		client.hydrateCachedSession(snapshot());
		expect(state().activeSessionFile).toBe(null);
		expect(state().messages).toEqual([]);
	});

	it('is a no-op while a load is pending', () => {
		client.joinSession(FILE);
		client.hydrateCachedSession(snapshot());
		expect(state().activeSessionFile).toBe(null);
	});

	it('leaves undelivered-message recovery unchanged', () => {
		// A previous tab persisted one send that never reached the server.
		localStorage.setItem(
			'wherever-pending:sid-1',
			JSON.stringify([{id: 'p1', content: 'lost send', timestamp: 3, delivery: 'failed'}]),
		);
		client.hydrateCachedSession(snapshot());
		// The cached view never shows it: recovery belongs to the history reply.
		expect(state().messages.some((m) => m.delivery !== undefined)).toBe(false);
		client.connect(undefined, true);
		ws.last().open();
		ws.last().receive(created);
		ws.last().receive(history);
		const failed = state().messages.filter((m) => m.delivery === 'failed');
		expect(failed.map((m) => m.content)).toEqual(['lost send']);
	});

	it('drops delivery-tagged messages from the snapshot itself', () => {
		client.hydrateCachedSession(
			snapshot({
				messages: [
					{id: 'c1', role: 'user', content: 'cached', timestamp: 1, isStreaming: false},
					{id: 'p1', role: 'user', content: 'lost send', timestamp: 3, isStreaming: false, delivery: 'failed'},
				],
			}),
		);
		expect(state().messages.map((m) => m.content)).toEqual(['cached']);
	});
});

describe('hydration_rejected', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;
	let seen: any[];
	const state = () => get<WhereverState>(client.stateStore);

	beforeEach(() => {
		vi.useFakeTimers();
		installLocalStorage();
		ws = makeWSFactory();
		client = new WhereverClient({...CFG, WebSocketCtor: ws.ctor});
		seen = [];
		client.onMessage((m) => seen.push(m));
		client.hydrateCachedSession(snapshot());
		client.connect(undefined, true);
		ws.last().open();
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	const rejected = () => seen.filter((m) => m.type === 'hydration_rejected');

	it('an untagged session_error answering the hydrated load emits it and clears the session', () => {
		ws.last().receive({type: 'session_error', error: 'Session not found'});
		expect(rejected()).toEqual([{type: 'hydration_rejected', sessionId: 'sid-1'}]);
		const s = state();
		expect(s.activeSessionFile).toBe(null);
		expect(s.sessionId).toBe(null);
		expect(s.session).toBe(null);
		expect(s.messages).toEqual([]);
		expect(s.resyncing).toBe(false);
		expect(s.serverKey).toBe(null);
		expect(s.sessionError).toBe('Session not found');
	});

	it('a tagged session_error does not', () => {
		ws.last().receive({type: 'session_error', sessionId: 'sid-1', error: 'boom'});
		expect(rejected()).toEqual([]);
		expect(state().activeSessionFile).toBe(FILE);
	});

	it('folder_missing after session_created does not', () => {
		ws.last().receive({...created, folderMissing: true});
		ws.last().receive({type: 'folder_missing', sessionId: 'sid-1', cwd: '/tmp/project'});
		ws.last().receive(history);
		expect(rejected()).toEqual([]);
		expect(state().activeSessionFile).toBe(FILE);
	});

	it('a cold-build session_error after session_created does not', () => {
		ws.last().receive({...created, pending: true});
		ws.last().receive(history);
		ws.last().receive({type: 'session_error', error: 'agent build failed'});
		expect(rejected()).toEqual([]);
		const s = state();
		expect(s.activeSessionFile).toBe(FILE);
		expect(s.messages.length).toBe(2);
	});

	it('an untagged session_error for a later, different load does not', () => {
		ws.last().receive(created);
		ws.last().receive(history);
		client.switchSession('/tmp/other.jsonl');
		ws.last().receive({type: 'session_error', error: 'Session not found'});
		expect(rejected()).toEqual([]);
	});
});

describe('stamped server key on reconnect', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;
	const state = () => get<WhereverState>(client.stateStore);

	beforeEach(() => {
		vi.useFakeTimers();
		installLocalStorage();
		ws = makeWSFactory();
		client = new WhereverClient({...CFG, WebSocketCtor: ws.ctor});
		client.connect();
		ws.last().open();
		client.joinSession(FILE);
		ws.last().receive(created);
		ws.last().receive(history);
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	it('session_created stamps the key of the socket that delivered it', () => {
		expect(state().serverKey).toBe(serverKey(CFG));
	});

	it('an automatic reconnect to the same server preserves and rejoins', () => {
		ws.last().close();
		vi.advanceTimersByTime(30_000);
		expect(state().activeSessionFile).toBe(FILE);
		ws.last().open();
		expect(ws.last().lastSentOfType('session_load')?.sessionFile).toBe(FILE);
		expect(state().historyAuthoritative).toBe(false);
	});

	it('an automatic reconnect after host/port were edited wipes, clears the stamp, and does not rejoin', () => {
		client.setConfig({host: 'elsewhere', port: 9999});
		ws.last().close();
		vi.advanceTimersByTime(30_000);
		const s = state();
		expect(s.activeSessionFile).toBe(null);
		expect(s.messages).toEqual([]);
		expect(s.serverKey).toBe(null);
		ws.last().open();
		expect(ws.last().lastSentOfType('session_load')).toBeUndefined();
	});

	it('suspend -> resume against a dead socket -> edit host -> automatic reconnect sends no session_load', () => {
		client.suspend();
		expect(client.hasSuspendedSession()).toBe(true);
		client.resume();
		// The resumed socket never opens: it dies.
		ws.last().close();
		client.setConfig({host: 'elsewhere'});
		vi.advanceTimersByTime(30_000);
		expect(client.hasSuspendedSession()).toBe(false);
		expect(state().serverKey).toBe(null);
		ws.last().open();
		expect(ws.last().lastSentOfType('session_load')).toBeUndefined();
	});

	it('an explicit connect with a new config also refuses to preserve', () => {
		client.connect({token: 'rotated'}, true);
		expect(state().activeSessionFile).toBe(null);
		ws.last().open();
		expect(ws.last().lastSentOfType('session_load')).toBeUndefined();
	});
});

describe('historyAuthoritative gates loadMoreHistory', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;
	const state = () => get<WhereverState>(client.stateStore);

	beforeEach(() => {
		vi.useFakeTimers();
		installLocalStorage();
		ws = makeWSFactory();
		client = new WhereverClient({...CFG, WebSocketCtor: ws.ctor});
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	it('starts false', () => {
		expect(state().historyAuthoritative).toBe(false);
	});

	it('loadMoreHistory is a no-op while false and works once the history lands', () => {
		client.hydrateCachedSession(snapshot());
		client.connect(undefined, true);
		ws.last().open();
		ws.last().receive(created);
		client.loadMoreHistory();
		expect(ws.last().lastSentOfType('history_load_more')).toBeUndefined();
		expect(state().loadingMoreHistory).toBe(false);
		ws.last().receive(history);
		client.loadMoreHistory();
		expect(ws.last().lastSentOfType('history_load_more')).toMatchObject({
			sessionId: 'sid-1',
			beforeOffset: 38,
		});
	});

	it('a stale history for another session does not make it authoritative', () => {
		client.hydrateCachedSession(snapshot());
		client.connect(undefined, true);
		ws.last().open();
		ws.last().receive(created);
		ws.last().receive({...history, sessionId: 'other'});
		expect(state().historyAuthoritative).toBe(false);
	});
});

describe('resume() with hydrated data', () => {
	it('raises no timeout error while the socket is stuck CONNECTING', () => {
		vi.useFakeTimers();
		installLocalStorage();
		const ws = makeWSFactory();
		const client = new WhereverClient({...CFG, WebSocketCtor: ws.ctor});
		try {
			client.hydrateCachedSession(snapshot());
			client.resume();
			expect(ws.instances.length).toBe(1);
			vi.advanceTimersByTime(60_000);
			const s = get<WhereverState>(client.stateStore);
			expect(s.sessionError).toBe(null);
			expect(s.messages.length).toBe(2);
			expect(s.activeSessionFile).toBe(FILE);
		} finally {
			client.disconnect(true);
			vi.useRealTimers();
		}
	});
});
