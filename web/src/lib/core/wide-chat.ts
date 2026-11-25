/**
 * "Wide chat": on desktop, the chat (messages, composer, notification toasts)
 * spans the whole chat area instead of the centered reading lane of about 760px
 * (spec `chat-compact-layout`). Toggled in the chat ⋯ menu, "On this device"
 * (desktop only: on a phone the lane is already the full width).
 *
 * The width is ONE CSS custom property, `--chat-column` (default in `app.css`),
 * which every component of the lane reads; `wherever.ts` writes it on the root
 * element from this store. Device-local (localStorage `wherever-wide-chat`,
 * "true" / "false"), off by default, written only when the user chooses.
 * Storage is injected so the store is unit-tested without a browser.
 */
import {writable, type Readable} from 'svelte/store';

export const WIDE_CHAT_KEY = 'wherever-wide-chat';

/** The centered reading lane. Keep in step with `--chat-column` in app.css. */
export const CHAT_COLUMN_NARROW = '760px';
/** The whole chat area (the lane's side padding falls back to 1rem). */
export const CHAT_COLUMN_WIDE = '100%';

/** The `--chat-column` value for a wide-chat choice. */
export function chatColumnWidth(wide: boolean): string {
	return wide ? CHAT_COLUMN_WIDE : CHAT_COLUMN_NARROW;
}

export interface WideChatStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface WideChat extends Readable<boolean> {
	set(value: boolean): void;
	toggle(): void;
}

export function createWideChat(opts: {
	storage: WideChatStorage | null;
}): WideChat {
	const {storage} = opts;
	let stored: string | null = null;
	try {
		stored = storage?.getItem(WIDE_CHAT_KEY) ?? null;
	} catch {}
	let current = stored === 'true';
	const store = writable(current);

	function set(value: boolean) {
		current = value;
		try {
			storage?.setItem(WIDE_CHAT_KEY, String(value));
		} catch {}
		store.set(value);
	}

	return {
		subscribe: store.subscribe,
		set,
		toggle: () => set(!current),
	};
}
