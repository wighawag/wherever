/**
 * Speech settings store (spec `chat-compact-layout` story 12).
 *
 * The voice-input settings (engine and locale) used to be local state in
 * `SpeechButton.svelte`, read from localStorage once on mount, so the Speech
 * Settings panel could only live inside that button. This store is their one
 * home: `SpeechButton` and `SpeechSettingsPanel` both read it, so a change made
 * in the panel, wherever it is mounted, takes effect in the 🎤 button at once.
 *
 * Persistence is unchanged: the SAME localStorage keys as before
 * (`wherever-speech-engine`, `wherever-speech-locale`), written only when the
 * user makes a choice (a platform default is never persisted). Direct send is
 * NOT here: it is the conversation-mode `autoSendOnSpeechEnd` knob, whose one
 * home is the `autoSendOnSpeechEnd` store in `wherever.ts`.
 *
 * The last speech error also lives here (never persisted) so it can be shown
 * both next to 🎤 in the pill and inside the panel.
 *
 * Storage is injected so the store is unit-tested without a browser; the app
 * instance is `speechSettings` in `wherever.ts`.
 */
import {writable, type Readable, type Writable} from 'svelte/store';

export type SpeechEngine = 'browser' | 'cloud';

export const SPEECH_ENGINE_KEY = 'wherever-speech-engine';
export const SPEECH_LOCALE_KEY = 'wherever-speech-locale';
export const DEFAULT_SPEECH_LOCALE = 'en-US';

/** The locales offered for the on-device (browser) engine. */
export const SPEECH_LOCALES: ReadonlyArray<{code: string; label: string}> = [
	{code: 'en-US', label: 'English (US)'},
	{code: 'en-GB', label: 'English (UK)'},
	{code: 'en-IN', label: 'English (India)'},
	{code: 'en-AU', label: 'English (Australia)'},
	{code: 'en-CA', label: 'English (Canada)'},
	{code: 'en-ZA', label: 'English (South Africa)'},
];

export interface SpeechSettingsStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface SpeechSettings {
	engine: Readable<SpeechEngine>;
	locale: Readable<string>;
	/** The last speech error, or null. Shared by the 🎤 button and the panel. */
	error: Writable<string | null>;
	setEngine(engine: SpeechEngine): void;
	setLocale(locale: string): void;
}

function read(
	storage: SpeechSettingsStorage | null,
	key: string,
): string | null {
	if (!storage) return null;
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
}

function write(
	storage: SpeechSettingsStorage | null,
	key: string,
	value: string,
): void {
	if (!storage) return;
	try {
		storage.setItem(key, value);
	} catch {}
}

export function createSpeechSettings(opts: {
	storage: SpeechSettingsStorage | null;
	/** Whether this browser has the Web Speech API (on-device engine). */
	browserSupported: boolean;
}): SpeechSettings {
	const {storage, browserSupported} = opts;

	const storedEngine = read(storage, SPEECH_ENGINE_KEY);
	const initialEngine: SpeechEngine =
		storedEngine === 'browser' || storedEngine === 'cloud'
			? storedEngine
			: browserSupported
				? 'browser'
				: 'cloud';
	const initialLocale =
		read(storage, SPEECH_LOCALE_KEY) ?? DEFAULT_SPEECH_LOCALE;

	const engine = writable<SpeechEngine>(initialEngine);
	const locale = writable<string>(initialLocale);
	const error = writable<string | null>(null);

	return {
		engine: {subscribe: engine.subscribe},
		locale: {subscribe: locale.subscribe},
		error,
		setEngine(value) {
			write(storage, SPEECH_ENGINE_KEY, value);
			engine.set(value);
		},
		setLocale(value) {
			write(storage, SPEECH_LOCALE_KEY, value);
			locale.set(value);
		},
	};
}

/** Whether this browser has the Web Speech API (false outside a browser). */
export function hasBrowserSpeechRecognition(): boolean {
	if (typeof window === 'undefined') return false;
	const w = window as any;
	return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}
