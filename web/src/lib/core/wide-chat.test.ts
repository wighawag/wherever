import {describe, it, expect} from 'vitest';
import {get} from 'svelte/store';
import {
	createWideChat,
	WIDE_CHAT_KEY,
	CHAT_COLUMN_NARROW,
	CHAT_COLUMN_WIDE,
	chatColumnWidth,
	type WideChatStorage,
} from './wide-chat.js';

// "Wide chat" (chat ⋯ menu, On this device, desktop): the chat column spans the
// whole chat area instead of the centered ~760px reading lane. Device-local,
// off by default.

function memoryStorage(
	initial: Record<string, string> = {},
): WideChatStorage & {data: Record<string, string>} {
	const data = {...initial};
	return {
		data,
		getItem: (key) => (key in data ? data[key] : null),
		setItem: (key, value) => {
			data[key] = value;
		},
	};
}

describe('createWideChat', () => {
	it('is off by default and writes nothing until the user chooses', () => {
		const storage = memoryStorage();
		const wide = createWideChat({storage});
		expect(get(wide)).toBe(false);
		expect(storage.data).toEqual({});
	});

	it('reads a stored choice', () => {
		expect(
			get(createWideChat({storage: memoryStorage({[WIDE_CHAT_KEY]: 'true'})})),
		).toBe(true);
		expect(
			get(createWideChat({storage: memoryStorage({[WIDE_CHAT_KEY]: 'false'})})),
		).toBe(false);
	});

	it('toggles and persists', () => {
		const storage = memoryStorage();
		const wide = createWideChat({storage});
		wide.toggle();
		expect(get(wide)).toBe(true);
		expect(storage.data[WIDE_CHAT_KEY]).toBe('true');
		wide.toggle();
		expect(get(wide)).toBe(false);
		expect(storage.data[WIDE_CHAT_KEY]).toBe('false');
	});

	it('works without storage and survives a throwing one', () => {
		const wide = createWideChat({storage: null});
		wide.set(true);
		expect(get(wide)).toBe(true);
		const throwing: WideChatStorage = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			},
		};
		const w2 = createWideChat({storage: throwing});
		expect(get(w2)).toBe(false);
		w2.toggle();
		expect(get(w2)).toBe(true);
	});
});

describe('chatColumnWidth', () => {
	it('is the reading lane when off, the full area when on', () => {
		expect(chatColumnWidth(false)).toBe(CHAT_COLUMN_NARROW);
		expect(chatColumnWidth(true)).toBe(CHAT_COLUMN_WIDE);
		expect(CHAT_COLUMN_NARROW).toBe('760px');
		expect(CHAT_COLUMN_WIDE).toBe('100%');
	});
});
