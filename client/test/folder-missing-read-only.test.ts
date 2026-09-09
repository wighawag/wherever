import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// FOLDER MISSING is the third read-only reason: the session's working folder
// does not exist on this machine, so the server built no live agent and refuses
// every send. It is HARD -- unlike a folder conflict there is no "Continue
// anyway" -- and it is cured by restoring the folder and RELOADING, never by a
// client-side dismiss. The client mirrors it so the UI can replace the composer
// with a notice naming the absolute path.

describe('missing-folder read-only state', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;

	function loadMissingFolderSession() {
		client.joinSession('/tmp/gone/session.jsonl');
		ws.last().receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/gone/session.jsonl',
			cwd: '/tmp/gone',
			model: 'fake:model',
			readOnly: true,
			folderMissing: true,
			pending: true,
		});
		ws.last().receive({
			type: 'folder_missing',
			sessionId: 'sid-1',
			cwd: '/tmp/gone',
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
		ws = makeWSFactory();
		client = new WhereverClient({
			host: 'localhost',
			port: 1234,
			secure: false,
			WebSocketCtor: ws.ctor,
		});
		client.connect();
		ws.last().open();
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	it('locks the session and records the absolute missing path', () => {
		loadMissingFolderSession();

		const s = get(client.stateStore);
		expect(s.readOnly).toBe(true);
		expect(s.folderMissing).toEqual({cwd: '/tmp/gone'});
		// No agent is coming (the server built none), so the composer stays gated.
		expect(s.agentPending).toBe(true);
	});

	it('is not lifted by "Continue anyway"', () => {
		loadMissingFolderSession();
		// A folder conflict is raised on top (or a stale UI still shows its
		// button): continuing answers the CONFLICT, never the missing folder.
		ws.last().receive({
			type: 'folder_conflict',
			cwd: '/tmp/gone',
			active: true,
			readOnly: true,
		});
		client.continueFolderConflict();

		const s = get(client.stateStore);
		expect(s.readOnly).toBe(true);
		expect(s.folderMissing).toEqual({cwd: '/tmp/gone'});
	});

	it('stays locked when a conflict update reports the server verdict', () => {
		loadMissingFolderSession();

		ws.last().receive({
			type: 'folder_conflict',
			cwd: '/tmp/gone',
			active: false,
			readOnly: true,
		});

		expect(get(client.stateStore).readOnly).toBe(true);
		expect(get(client.stateStore).folderMissing).toEqual({cwd: '/tmp/gone'});
	});

	it('clears with the session it belonged to', () => {
		loadMissingFolderSession();

		client.switchSession('/tmp/present/session.jsonl');
		expect(get(client.stateStore).folderMissing).toBeNull();

		ws.last().receive({
			type: 'session_created',
			sessionId: 'sid-2',
			sessionFile: '/tmp/present/session.jsonl',
			cwd: '/tmp/present',
			model: 'fake:model',
			pending: true,
		});

		const s = get(client.stateStore);
		expect(s.folderMissing).toBeNull();
		expect(s.readOnly).toBe(false);
	});
});
