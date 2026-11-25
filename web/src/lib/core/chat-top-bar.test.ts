import {describe, it, expect} from 'vitest';
import {folderName, openSessionTitle, waitsForYouText} from './chat-top-bar';

describe('folderName', () => {
	it('is the last path segment', () => {
		expect(folderName('/home/me/dev/wherever')).toBe('wherever');
	});
	it('falls back to the whole path when it ends with a slash', () => {
		expect(folderName('/')).toBe('/');
	});
	it('is empty without a folder', () => {
		expect(folderName(undefined)).toBe('');
		expect(folderName(null)).toBe('');
	});
});

describe('openSessionTitle', () => {
	it("is the listing's name when the session has one", () => {
		expect(
			openSessionTitle({
				listed: {name: 'drive tasks', firstMessage: 'hello'},
				cwd: '/x/wherever',
			}),
		).toBe('drive tasks');
	});
	it('falls back to the first message, as the sidebar row', () => {
		expect(
			openSessionTitle({
				listed: {firstMessage: 'Now that we shipmates can have agents'},
				cwd: '/x/wherever',
			}),
		).toBe('Now that we shipmates can have agents');
	});
	it('says "Empty session" for a listed session with neither', () => {
		expect(
			openSessionTitle({listed: {firstMessage: ''}, cwd: '/x/wherever'}),
		).toBe('Empty session');
	});
	it('is the folder name when the session is not listed yet', () => {
		expect(openSessionTitle({listed: undefined, cwd: '/x/wherever'})).toBe(
			'wherever',
		);
	});
	it('is "Session" when neither listed nor in a known folder', () => {
		expect(openSessionTitle({listed: undefined, cwd: undefined})).toBe(
			'Session',
		);
	});
});

describe('waitsForYouText', () => {
	it('is empty when nothing waits', () => {
		expect(waitsForYouText({inbox: 0, sessions: 0, waiting: false})).toBe('');
	});
	it('counts inbox questions', () => {
		expect(waitsForYouText({inbox: 1, sessions: 0, waiting: true})).toBe(
			'1 question for you',
		);
		expect(waitsForYouText({inbox: 3, sessions: 0, waiting: true})).toBe(
			'3 questions for you',
		);
	});
	it('counts sessions waiting for you', () => {
		expect(waitsForYouText({inbox: 0, sessions: 1, waiting: true})).toBe(
			'1 session waiting for you',
		);
	});
	it('joins both counts', () => {
		expect(waitsForYouText({inbox: 2, sessions: 2, waiting: true})).toBe(
			'2 questions for you, 2 sessions waiting for you',
		);
	});
});
