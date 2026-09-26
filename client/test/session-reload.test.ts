import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// The web `/reload` reducer contract: reloadResources() only ASKS (one
// session_reload frame for the active session); the server drives the state.
// session_reloading blocks the composer (agentPending) like a cold load, and the
// session_ready that ends the reload unblocks it and re-requests the skill list
// (a reload can change which skills exist). A frame for another session is ignored.

describe('session reload', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;

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
		client.joinSession('/tmp/p/session.jsonl');
		ws.last().receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/p/session.jsonl',
			cwd: '/tmp/p',
			model: 'fake:a',
			isStreaming: false,
		});
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	function sentOfType(type: string): any[] {
		return ws.last().sent.filter((m: any) => m.type === type);
	}

	it('reloadResources() sends one session_reload for the active session and changes nothing locally', () => {
		const before = get(client.stateStore);
		client.reloadResources();
		expect(sentOfType('session_reload')).toEqual([{type: 'session_reload', sessionId: 'sid-1'}]);
		expect(get(client.stateStore).agentPending).toBe(before.agentPending);
	});

	it('session_reloading blocks the composer until session_ready, which re-requests skills', () => {
		ws.last().receive({type: 'session_reloading', sessionId: 'sid-1'});
		expect(get(client.stateStore).agentPending).toBe(true);

		const skillRequestsBefore = sentOfType('skills_request').length;
		ws.last().receive({
			type: 'session_ready',
			sessionId: 'sid-1',
			sessionFile: '/tmp/p/session.jsonl',
			model: 'fake:a',
			isStreaming: false,
		});
		expect(get(client.stateStore).agentPending).toBe(false);
		expect(sentOfType('skills_request').length).toBe(skillRequestsBefore + 1);
	});

	it('a failed reload (session_error) unblocks the composer and surfaces the error', () => {
		ws.last().receive({type: 'session_reloading', sessionId: 'sid-1'});
		ws.last().receive({type: 'session_error', sessionId: 'sid-1', error: 'Reload failed: boom'});
		const s = get(client.stateStore);
		expect(s.agentPending).toBe(false);
		expect(s.sessionError).toBe('Reload failed: boom');
	});

	it('ignores session_reloading for a session we are not viewing', () => {
		ws.last().receive({type: 'session_reloading', sessionId: 'other'});
		expect(get(client.stateStore).agentPending).toBe(false);
	});
});
