import {describe, it, expect} from 'vitest';
import {
	extractHumanAskArgs,
	findHumanAskItem,
	humanAskCardState,
	parseHumanAskResult,
} from './human-ask-card';
import type {ShipmatesInboxItem} from './shipmates';

function item(
	id: string,
	over: Partial<ShipmatesInboxItem> = {},
): ShipmatesInboxItem {
	return {
		id,
		question: 'Publish 0.3.0?',
		options: ['yes', 'no'],
		blocking: true,
		createdAt: 0,
		sessionFile: '/s/me.jsonl',
		sessionId: 'me',
		from: 'a/b',
		onBehalfOf: 0,
		...over,
	};
}

const args = {
	question: 'Publish 0.3.0?',
	options: ['yes', 'no'],
	blocking: true,
};
const base = {
	args,
	isStreaming: false,
	isError: false,
	output: '',
	inbox: [] as ShipmatesInboxItem[],
	sessionId: 'me',
	sessionFile: '/s/me.jsonl',
};

describe('extractHumanAskArgs', () => {
	it('reads question, options and blocking (default true)', () => {
		expect(extractHumanAskArgs({question: 'Q?', options: ['a', 'b']})).toEqual({
			question: 'Q?',
			options: ['a', 'b'],
			blocking: true,
		});
		expect(extractHumanAskArgs({question: 'Q?', blocking: false})).toEqual({
			question: 'Q?',
			options: [],
			blocking: false,
		});
	});
	it('accepts options as JSON text and rejects a missing question', () => {
		expect(
			extractHumanAskArgs({question: 'Q', options: '["x"]'})?.options,
		).toEqual(['x']);
		expect(extractHumanAskArgs({options: ['x']})).toBeNull();
		expect(extractHumanAskArgs(null)).toBeNull();
	});
});

describe('parseHumanAskResult', () => {
	it('reads an answer, multi-line included', () => {
		expect(
			parseHumanAskResult(
				'the human answered h_ab1 (origin human, on web):\nyes\nand tag it',
			),
		).toEqual({
			kind: 'answered',
			itemId: 'h_ab1',
			where: 'on web',
			answer: 'yes\nand tag it',
		});
	});
	it('reads withdrawn and the still-open shapes', () => {
		expect(parseHumanAskResult('h_x was withdrawn')).toEqual({
			kind: 'withdrawn',
			itemId: 'h_x',
		});
		expect(
			parseHumanAskResult("raised h_y in the human's inbox (not blocking)."),
		).toEqual({
			kind: 'pending',
			itemId: 'h_y',
		});
		expect(
			parseHumanAskResult(
				"no answer after 30 s; h_z stays in the human's inbox.",
			),
		).toEqual({
			kind: 'pending',
			itemId: 'h_z',
		});
		expect(
			parseHumanAskResult(
				'aborted; h_a stays in the inbox and the answer will arrive as a message',
			),
		).toEqual({kind: 'pending', itemId: 'h_a'});
		expect(
			parseHumanAskResult(
				'the human dismissed the dialog; h_d stays in their inbox and the answer will arrive as a message',
			),
		).toEqual({kind: 'pending', itemId: 'h_d'});
		expect(parseHumanAskResult('something else')).toEqual({kind: 'unknown'});
	});
});

describe('findHumanAskItem', () => {
	it('matches by id when known, else by question within this session, newest first', () => {
		const inbox = [
			item('h_1', {createdAt: 1}),
			item('h_2', {createdAt: 2}),
			item('h_3', {
				createdAt: 3,
				sessionId: 'other',
				sessionFile: '/s/o.jsonl',
			}),
		];
		expect(
			findHumanAskItem(inbox, {
				itemId: 'h_1',
				question: '',
				sessionId: null,
				sessionFile: null,
			})?.id,
		).toBe('h_1');
		expect(
			findHumanAskItem(inbox, {
				itemId: null,
				question: 'Publish 0.3.0?',
				sessionId: 'me',
				sessionFile: null,
			})?.id,
		).toBe('h_2');
		expect(
			findHumanAskItem(inbox, {
				itemId: null,
				question: 'Other?',
				sessionId: 'me',
				sessionFile: null,
			}),
		).toBeNull();
	});
});

describe('humanAskCardState', () => {
	it('a waiting call is open when its item is in the inbox, else waiting', () => {
		expect(
			humanAskCardState({...base, isStreaming: true, inbox: [item('h_1')]}),
		).toEqual({
			kind: 'open',
			item: item('h_1'),
		});
		expect(humanAskCardState({...base, isStreaming: true})).toEqual({
			kind: 'waiting',
		});
	});
	it('a finished call shows its answer', () => {
		expect(
			humanAskCardState({
				...base,
				output: 'the human answered h_1 (origin human, on web):\nno',
				inbox: [item('h_1')],
			}),
		).toEqual({kind: 'answered', answer: 'no', where: 'on web'});
	});
	it('a non-blocking call stays answerable while its item is open, then closes', () => {
		const output = "raised h_1 in the human's inbox (not blocking).";
		expect(
			humanAskCardState({...base, output, inbox: [item('h_1')]}).kind,
		).toBe('open');
		expect(humanAskCardState({...base, output}).kind).toBe('closed');
	});
	it('a finished call that names no item never grabs a newer same-question item', () => {
		expect(
			humanAskCardState({...base, output: 'aborted', inbox: [item('h_9')]})
				.kind,
		).toBe('closed');
	});
	it('a withdrawn call is withdrawn', () => {
		expect(
			humanAskCardState({
				...base,
				output: 'h_1 was withdrawn',
				inbox: [item('h_1')],
			}),
		).toEqual({kind: 'withdrawn'});
	});
	it('a waiting call matches by sessionFile when the sessionId is unknown', () => {
		expect(
			humanAskCardState({
				...base,
				isStreaming: true,
				sessionId: null,
				inbox: [item('h_1', {sessionId: null})],
			}).kind,
		).toBe('open');
	});
	it('an error is an error', () => {
		expect(humanAskCardState({...base, isError: true}).kind).toBe('error');
	});
});
