import {describe, it, expect} from 'vitest';
import {
	INCLUDE_CLOSED_KEY,
	readIncludeClosed,
	writeIncludeClosed,
	searchRequestParams,
} from './search-request.js';

function memoryStorage(): Pick<
	Storage,
	'getItem' | 'setItem' | 'removeItem'
> & {
	data: Map<string, string>;
} {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
	};
}

describe('searchRequestParams', () => {
	it('sends only q for a default search', () => {
		expect(searchRequestParams({query: 'flamingo'}).toString()).toBe(
			'q=flamingo',
		);
	});

	it('adds view, includeClosed and the token when set', () => {
		const params = searchRequestParams({
			query: 'a b',
			view: 'readonly',
			includeClosed: true,
			token: 't',
		});
		expect(params.get('q')).toBe('a b');
		expect(params.get('view')).toBe('readonly');
		expect(params.get('includeClosed')).toBe('1');
		expect(params.get('token')).toBe('t');
	});

	it('leaves includeClosed out when off (the server default drops closed sessions)', () => {
		expect(
			searchRequestParams({query: 'x', includeClosed: false}).has(
				'includeClosed',
			),
		).toBe(false);
	});
});

describe('Include closed setting', () => {
	it('is a wherever- prefixed localStorage key', () => {
		expect(INCLUDE_CLOSED_KEY).toBe('wherever-search-include-closed');
	});

	it('defaults to off and round-trips', () => {
		const storage = memoryStorage();
		expect(readIncludeClosed(storage)).toBe(false);
		writeIncludeClosed(storage, true);
		expect(storage.data.get(INCLUDE_CLOSED_KEY)).toBe('1');
		expect(readIncludeClosed(storage)).toBe(true);
		writeIncludeClosed(storage, false);
		expect(storage.data.has(INCLUDE_CLOSED_KEY)).toBe(false);
		expect(readIncludeClosed(storage)).toBe(false);
	});

	it('never throws when storage is unavailable', () => {
		const broken = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			},
			removeItem: () => {
				throw new Error('denied');
			},
		};
		expect(readIncludeClosed(broken)).toBe(false);
		expect(() => writeIncludeClosed(broken, true)).not.toThrow();
		expect(readIncludeClosed(undefined)).toBe(false);
	});
});
