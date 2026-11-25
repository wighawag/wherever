import {describe, it, expect} from 'vitest';
import {get} from 'svelte/store';
import {
	createEnterToSend,
	ENTER_TO_SEND_KEY,
	type EnterToSendStorage,
} from './enter-to-send.js';

// "Enter sends" used to be local state in ChatInput.svelte, read from
// localStorage on mount, so only the composer could change it. The chat ⋯ menu
// (in +page.svelte) now holds the toggle, so it is a shared store, persisted
// under the SAME key as before so existing users keep their choice.

function memoryStorage(
	initial: Record<string, string> = {},
): EnterToSendStorage & {data: Record<string, string>} {
	const data = {...initial};
	return {
		data,
		getItem: (key) => (key in data ? data[key] : null),
		setItem: (key, value) => {
			data[key] = value;
		},
	};
}

describe('createEnterToSend', () => {
	it('keeps the old localStorage key', () => {
		expect(ENTER_TO_SEND_KEY).toBe('wherever-enter-to-send');
	});

	it('defaults to on and writes nothing until the user chooses', () => {
		const storage = memoryStorage();
		const s = createEnterToSend({storage});
		expect(get(s)).toBe(true);
		expect(storage.data).toEqual({});
	});

	it('reads a stored choice', () => {
		expect(
			get(
				createEnterToSend({
					storage: memoryStorage({[ENTER_TO_SEND_KEY]: 'false'}),
				}),
			),
		).toBe(false);
		expect(
			get(
				createEnterToSend({
					storage: memoryStorage({[ENTER_TO_SEND_KEY]: 'true'}),
				}),
			),
		).toBe(true);
	});

	it('set and toggle persist and notify', () => {
		const storage = memoryStorage();
		const s = createEnterToSend({storage});
		const seen: boolean[] = [];
		const stop = s.subscribe((v) => seen.push(v));
		s.toggle();
		expect(get(s)).toBe(false);
		expect(storage.data[ENTER_TO_SEND_KEY]).toBe('false');
		s.set(true);
		expect(storage.data[ENTER_TO_SEND_KEY]).toBe('true');
		stop();
		expect(seen).toEqual([true, false, true]);
	});

	it('works without storage, and survives a throwing one', () => {
		const s = createEnterToSend({storage: null});
		s.toggle();
		expect(get(s)).toBe(false);
		const broken = createEnterToSend({
			storage: {
				getItem: () => {
					throw new Error('denied');
				},
				setItem: () => {
					throw new Error('denied');
				},
			},
		});
		expect(get(broken)).toBe(true);
		broken.toggle();
		expect(get(broken)).toBe(false);
	});
});
