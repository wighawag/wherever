import {describe, it, expect} from 'vitest';
import {get} from 'svelte/store';
import {
	closeReader,
	isLongQuestion,
	LONG_QUESTION_CHARS,
	openReader,
	optionForKey,
	readerItemId,
	readerPosition,
} from './shipmates-reader';
import type {ShipmatesInboxItem} from './shipmates';

function item(
	id: string,
	over: Partial<ShipmatesInboxItem> = {},
): ShipmatesInboxItem {
	return {
		id,
		question: 'Merge PR #43 now?',
		options: null,
		blocking: false,
		createdAt: 0,
		sessionFile: `/s/${id}.jsonl`,
		sessionId: id,
		from: 'a/b',
		onBehalfOf: 0,
		...over,
	};
}

describe('isLongQuestion', () => {
	it('keeps a short question with short options in the list', () => {
		expect(
			isLongQuestion({question: 'Merge now?', options: ['Yes', 'No']}),
		).toBe(false);
		expect(isLongQuestion({question: 'Merge now?', options: null})).toBe(false);
	});

	it('sends a long question to the reader', () => {
		expect(
			isLongQuestion({
				question: 'x'.repeat(LONG_QUESTION_CHARS + 1),
				options: null,
			}),
		).toBe(true);
	});

	it('counts lines, so a short but multi-line question is long', () => {
		expect(isLongQuestion({question: 'a\nb\nc\nd', options: null})).toBe(true);
		expect(isLongQuestion({question: 'a\nb\nc', options: null})).toBe(false);
	});

	it('sends long options to the reader even under a short question', () => {
		expect(
			isLongQuestion({
				question: 'Which?',
				options: [
					'Commit+push both',
					'Commit+push both, then switch telemaque too',
					"Leave uncommitted, I'll review",
				],
			}),
		).toBe(true);
	});
});

describe('readerPosition', () => {
	const inbox = [item('a'), item('b'), item('c')];

	it('places the open question with its neighbours', () => {
		expect(readerPosition(inbox, 'b')).toMatchObject({
			index: 2,
			total: 3,
			prevId: 'a',
			nextId: 'c',
		});
		expect(readerPosition(inbox, 'b').item?.id).toBe('b');
	});

	it('has no step past either end', () => {
		expect(readerPosition(inbox, 'a').prevId).toBeNull();
		expect(readerPosition(inbox, 'c').nextId).toBeNull();
	});

	it('finds nothing once the question left the inbox (answered elsewhere)', () => {
		expect(readerPosition(inbox, 'gone')).toEqual({
			item: null,
			index: 0,
			total: 3,
			prevId: null,
			nextId: null,
		});
		expect(readerPosition(inbox, null).item).toBeNull();
	});
});

describe('optionForKey', () => {
	it('maps 1 to 9 onto the options', () => {
		expect(optionForKey(['Yes', 'No'], '1')).toBe('Yes');
		expect(optionForKey(['Yes', 'No'], '2')).toBe('No');
	});

	it('ignores other keys, missing options and no options', () => {
		expect(optionForKey(['Yes', 'No'], '3')).toBeNull();
		expect(optionForKey(['Yes', 'No'], '0')).toBeNull();
		expect(optionForKey(['Yes', 'No'], 'a')).toBeNull();
		expect(optionForKey(null, '1')).toBeNull();
		expect(optionForKey([], '1')).toBeNull();
	});
});

describe('readerItemId', () => {
	it('opens and closes one question at a time', () => {
		openReader('a');
		expect(get(readerItemId)).toBe('a');
		openReader('b');
		expect(get(readerItemId)).toBe('b');
		closeReader();
		expect(get(readerItemId)).toBeNull();
	});
});
