import {describe, it, expect} from 'vitest';
import {
	SEARCH_SORTS,
	SEARCH_SORT_KEY,
	readSearchSort,
	writeSearchSort,
} from './search-sort.js';
import {searchRequestParams} from './search-request.js';

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

describe('Sort setting', () => {
	it('offers exactly Relevance and Newest, Relevance first', () => {
		expect(SEARCH_SORTS.map((s) => [s.value, s.label])).toEqual([
			['relevance', 'Relevance'],
			['recent', 'Newest'],
		]);
	});

	it('is a wherever- prefixed localStorage key', () => {
		expect(SEARCH_SORT_KEY).toBe('wherever-search-sort');
	});

	it('defaults to Relevance and round-trips', () => {
		const storage = memoryStorage();
		expect(readSearchSort(storage)).toBe('relevance');
		writeSearchSort(storage, 'recent');
		expect(storage.data.get(SEARCH_SORT_KEY)).toBe('recent');
		expect(readSearchSort(storage)).toBe('recent');
		writeSearchSort(storage, 'relevance');
		expect(storage.data.has(SEARCH_SORT_KEY)).toBe(false);
		expect(readSearchSort(storage)).toBe('relevance');
	});

	it('reads an unknown stored value as Relevance', () => {
		const storage = memoryStorage();
		storage.data.set(SEARCH_SORT_KEY, 'oldest');
		expect(readSearchSort(storage)).toBe('relevance');
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
		expect(readSearchSort(broken)).toBe('relevance');
		expect(() => writeSearchSort(broken, 'recent')).not.toThrow();
		expect(readSearchSort(undefined)).toBe('relevance');
	});
});

describe('searchRequestParams sort', () => {
	it('sends sort=recent for Newest and leaves it out for Relevance', () => {
		expect(searchRequestParams({query: 'x', sort: 'recent'}).get('sort')).toBe(
			'recent',
		);
		expect(
			searchRequestParams({query: 'x', sort: 'relevance'}).has('sort'),
		).toBe(false);
		expect(searchRequestParams({query: 'x'}).has('sort')).toBe(false);
	});
});
