import {describe, it, expect} from 'vitest';
import {get} from 'svelte/store';
import {
	createSpeechSettings,
	DEFAULT_SPEECH_LOCALE,
	SPEECH_ENGINE_KEY,
	SPEECH_LOCALE_KEY,
	type SpeechSettingsStorage,
} from './speech-settings.js';

// The speech settings used to be local state in SpeechButton.svelte, read from
// localStorage only on mount, so a panel mounted anywhere else could not change
// them. This store is the one home: SpeechButton and the extracted Speech
// Settings panel both read it, and it persists under the SAME keys as before so
// existing users keep their choices.

function memoryStorage(
	initial: Record<string, string> = {},
): SpeechSettingsStorage & {data: Record<string, string>} {
	const data = {...initial};
	return {
		data,
		getItem: (key) => (key in data ? data[key] : null),
		setItem: (key, value) => {
			data[key] = value;
		},
	};
}

describe('createSpeechSettings: defaults', () => {
	it('defaults to the on-device engine and en-US when nothing is stored', () => {
		const s = createSpeechSettings({
			storage: memoryStorage(),
			browserSupported: true,
		});
		expect(get(s.engine)).toBe('browser');
		expect(get(s.locale)).toBe(DEFAULT_SPEECH_LOCALE);
		expect(DEFAULT_SPEECH_LOCALE).toBe('en-US');
	});

	it('defaults to the cloud engine when the browser has no Web Speech API', () => {
		const s = createSpeechSettings({
			storage: memoryStorage(),
			browserSupported: false,
		});
		expect(get(s.engine)).toBe('cloud');
	});

	it('does not persist a default (only a user choice is written)', () => {
		const storage = memoryStorage();
		createSpeechSettings({storage, browserSupported: false});
		expect(storage.data).toEqual({});
	});

	it('works with no storage at all (prerender)', () => {
		const s = createSpeechSettings({storage: null, browserSupported: true});
		expect(get(s.engine)).toBe('browser');
		s.setEngine('cloud');
		expect(get(s.engine)).toBe('cloud');
	});

	it('starts with no speech error', () => {
		const s = createSpeechSettings({
			storage: memoryStorage(),
			browserSupported: true,
		});
		expect(get(s.error)).toBeNull();
	});
});

describe('createSpeechSettings: existing stored settings', () => {
	it('reads the existing keys', () => {
		expect(SPEECH_ENGINE_KEY).toBe('wherever-speech-engine');
		expect(SPEECH_LOCALE_KEY).toBe('wherever-speech-locale');
		const s = createSpeechSettings({
			storage: memoryStorage({
				'wherever-speech-engine': 'cloud',
				'wherever-speech-locale': 'en-GB',
			}),
			browserSupported: true,
		});
		expect(get(s.engine)).toBe('cloud');
		expect(get(s.locale)).toBe('en-GB');
	});

	it('keeps a stored engine even when it is not the platform default', () => {
		const s = createSpeechSettings({
			storage: memoryStorage({'wherever-speech-engine': 'browser'}),
			browserSupported: false,
		});
		expect(get(s.engine)).toBe('browser');
	});

	it('ignores an unknown stored engine and falls back to the default', () => {
		const s = createSpeechSettings({
			storage: memoryStorage({'wherever-speech-engine': 'whisper'}),
			browserSupported: false,
		});
		expect(get(s.engine)).toBe('cloud');
	});

	it('survives a storage that throws', () => {
		const s = createSpeechSettings({
			storage: {
				getItem: () => {
					throw new Error('denied');
				},
				setItem: () => {
					throw new Error('denied');
				},
			},
			browserSupported: true,
		});
		expect(get(s.engine)).toBe('browser');
		s.setLocale('en-AU');
		expect(get(s.locale)).toBe('en-AU');
	});
});

describe('createSpeechSettings: changes', () => {
	it('setEngine updates subscribers at once and persists', () => {
		const storage = memoryStorage();
		const s = createSpeechSettings({storage, browserSupported: true});
		const seen: string[] = [];
		const unsub = s.engine.subscribe((v) => seen.push(v));
		s.setEngine('cloud');
		unsub();
		expect(seen).toEqual(['browser', 'cloud']);
		expect(storage.data['wherever-speech-engine']).toBe('cloud');
	});

	it('setLocale updates subscribers at once and persists', () => {
		const storage = memoryStorage();
		const s = createSpeechSettings({storage, browserSupported: true});
		s.setLocale('en-IN');
		expect(get(s.locale)).toBe('en-IN');
		expect(storage.data['wherever-speech-locale']).toBe('en-IN');
	});

	it('a change is read back by a second instance on the same storage', () => {
		const storage = memoryStorage();
		createSpeechSettings({storage, browserSupported: true}).setEngine('cloud');
		const again = createSpeechSettings({storage, browserSupported: true});
		expect(get(again.engine)).toBe('cloud');
	});

	it('the error is shared, set and cleared, never persisted', () => {
		const storage = memoryStorage();
		const s = createSpeechSettings({storage, browserSupported: true});
		s.error.set('Microphone access denied');
		expect(get(s.error)).toBe('Microphone access denied');
		s.error.set(null);
		expect(get(s.error)).toBeNull();
		expect(storage.data).toEqual({});
	});
});
