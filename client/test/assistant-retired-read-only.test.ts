import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// A RETIRED assistant session (ADR 0020) is the fourth read-only reason: a
// session in the assistant folder that is not the current pointer session. It
// is HARD (no "Continue anyway") and the client mirrors it, both at load
// (`assistantRetired` on session_created) and live when the pointer moves
// (`assistant_retired`), so the UI can explain the reset and offer to open the
// current assistant session.

describe('retired assistant session read-only state', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;

	function load(opts: {retired: boolean; sessionId?: string; file?: string}) {
		const file = opts.file ?? '/tmp/assistant/old.jsonl';
		client.joinSession(file);
		ws.last().receive({
			type: 'session_created',
			sessionId: opts.sessionId ?? 'sid-old',
			sessionFile: file,
			cwd: '/tmp/assistant',
			model: 'fake:model',
			readOnly: opts.retired,
			folderConflict: false,
			folderMissing: false,
			...(opts.retired ? {assistantRetired: true} : {}),
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

	it('a load of a retired session is read-only and marked retired', () => {
		load({retired: true});
		const s = get(client.stateStore);
		expect(s.readOnly).toBe(true);
		expect(s.assistantRetired).toBe(true);
	});

	it('the live frame retires the session on screen and drops its conflict banner', () => {
		load({retired: false});
		ws.last().receive({type: 'folder_conflict', cwd: '/tmp/assistant', active: true, readOnly: false});
		expect(get(client.stateStore).folderConflict).not.toBeNull();

		ws.last().receive({type: 'assistant_retired', sessionId: 'sid-old', retired: true, readOnly: true});
		const s = get(client.stateStore);
		expect(s.assistantRetired).toBe(true);
		expect(s.readOnly).toBe(true);
		expect(s.folderConflict).toBeNull();
	});

	it('ignores a frame for another session', () => {
		load({retired: false});
		ws.last().receive({type: 'assistant_retired', sessionId: 'sid-other', retired: true, readOnly: true});
		const s = get(client.stateStore);
		expect(s.assistantRetired).toBe(false);
		expect(s.readOnly).toBe(false);
	});

	it('"Continue anyway" does not lift it', () => {
		load({retired: true});
		ws.last().receive({type: 'folder_conflict', cwd: '/tmp/assistant', active: true, readOnly: true});
		const sent = ws.last().sent.length;
		client.continueFolderConflict();
		const s = get(client.stateStore);
		expect(s.readOnly).toBe(true);
		expect(s.assistantRetired).toBe(true);
		expect(ws.last().sent.length).toBe(sent);
	});

	it('opening another session clears the retired mark', () => {
		load({retired: true});
		load({retired: false, sessionId: 'sid-new', file: '/tmp/assistant/new.jsonl'});
		const s = get(client.stateStore);
		expect(s.assistantRetired).toBe(false);
		expect(s.readOnly).toBe(false);
	});
});
