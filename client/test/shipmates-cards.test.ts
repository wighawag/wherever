import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import type {WhereverState} from '../src/types.js';
import {makeWSFactory} from './harness.js';

// shipmates' deliveries into a session (server shipmates-delivery.ts): asked for
// with `shipmatesCards` (socket `shipmates=1`), mapped to ChatMessage role
// 'shipmates' from history and from the live `shipmates_delivery` frame, never as a
// user message.

const details = {ids: ['m1'], from: ['lead'], origins: ['human-relayed']};

describe('shipmates cards', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;
	const state = () => get<WhereverState>(client.stateStore);

	function start(shipmatesCards: boolean) {
		client = new WhereverClient({host: 'localhost', port: 1234, secure: false, WebSocketCtor: ws.ctor, shipmatesCards});
		client.connect();
		ws.last().open();
		client.joinSession('/tmp/project/session.jsonl');
		ws.last().receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: '/tmp/project/session.jsonl',
			cwd: '/tmp/project',
			model: 'fake:model',
			isStreaming: false,
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
		ws = makeWSFactory();
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	it('asks for them only when configured', () => {
		start(true);
		expect(ws.last().url).toContain('shipmates=1');
		client.disconnect(true);
		ws = makeWSFactory();
		start(false);
		expect(ws.last().url).not.toContain('shipmates=');
	});

	it('maps a history shipmates message to a card carrying its details, with no fork point', () => {
		start(true);
		ws.last().receive({
			type: 'message_history',
			sessionId: 'sid-1',
			messages: [
				{role: 'shipmates', content: '[shipmates] 1 message for you:', timestamp: 1_000, shipmates: details},
				{role: 'assistant', content: 'on it', timestamp: 2_000},
			],
		});
		const [card, reply] = state().messages;
		expect(card).toMatchObject({role: 'shipmates', content: '[shipmates] 1 message for you:', shipmates: details, isStreaming: false});
		expect(card.entryId).toBeUndefined();
		expect(reply.role).toBe('assistant');
	});

	it('appends a live delivery once, even when history already showed it, and never as a user message', () => {
		start(true);
		ws.last().receive({type: 'message_history', sessionId: 'sid-1', messages: []});
		const frame = {type: 'shipmates_delivery', sessionId: 'sid-1', content: 'text', timestamp: 5_000, shipmates: details};
		ws.last().receive(frame);
		ws.last().receive(frame);
		const cards = state().messages.filter((m) => m.role === 'shipmates');
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({content: 'text', timestamp: 5_000, shipmates: details});
		expect(state().messages.some((m) => m.role === 'user')).toBe(false);

		// The woken turn's reply streams after it, as its own assistant message.
		ws.last().receive({type: 'agent_start', sessionId: 'sid-1'});
		ws.last().receive({type: 'message_update', sessionId: 'sid-1', delta: 'shipping'});
		ws.last().receive({type: 'message_end', sessionId: 'sid-1', content: 'shipping', role: 'assistant'});
		expect(state().messages.map((m) => m.role)).toEqual(['shipmates', 'assistant']);
	});

	it('ignores a malformed frame', () => {
		start(true);
		ws.last().receive({type: 'shipmates_delivery', sessionId: 'sid-1', content: 'text'});
		expect(state().messages).toEqual([]);
	});
});
