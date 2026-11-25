/**
 * "Enter sends" (spec `chat-compact-layout` story 22): whether Enter sends the
 * message (Shift+Enter for a new line) or the other way round. It used to be
 * local state in `ChatInput.svelte`; the toggle now lives in the chat ⋯ menu
 * ("On this device", mounted from `+page.svelte`), so it is a shared store that
 * the composer reads.
 *
 * Persistence is unchanged: the SAME localStorage key (`wherever-enter-to-send`,
 * "true" / "false"), default on, written only when the user makes a choice.
 * Storage is injected so the store is unit-tested without a browser; the app
 * instance is `enterToSend` in `wherever.ts`.
 */
import {writable, type Readable} from 'svelte/store';

export const ENTER_TO_SEND_KEY = 'wherever-enter-to-send';

export interface EnterToSendStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface EnterToSend extends Readable<boolean> {
	set(value: boolean): void;
	toggle(): void;
}

export function createEnterToSend(opts: {
	storage: EnterToSendStorage | null;
}): EnterToSend {
	const {storage} = opts;
	let stored: string | null = null;
	try {
		stored = storage?.getItem(ENTER_TO_SEND_KEY) ?? null;
	} catch {}
	const store = writable(stored === null ? true : stored === 'true');
	let current = stored === null ? true : stored === 'true';

	function set(value: boolean) {
		current = value;
		try {
			storage?.setItem(ENTER_TO_SEND_KEY, String(value));
		} catch {}
		store.set(value);
	}

	return {
		subscribe: store.subscribe,
		set,
		toggle: () => set(!current),
	};
}
