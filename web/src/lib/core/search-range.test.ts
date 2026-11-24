import {describe, it, expect} from 'vitest';
import {
	SEARCH_RANGES,
	SEARCH_RANGE_KEY,
	readSearchRange,
	writeSearchRange,
	rangeToSince,
} from './search-range.js';
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

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('rangeToSince', () => {
	it('is unbounded for Any time', () => {
		expect(rangeToSince('any', NOW)).toBeUndefined();
	});

	it('is now minus 24 hours for the last 24 hours', () => {
		expect(rangeToSince('24h', NOW)).toBe('2026-03-09T12:00:00.000Z');
	});

	it('is now minus 7 days for the last 7 days', () => {
		expect(rangeToSince('7d', NOW)).toBe('2026-03-03T12:00:00.000Z');
	});

	it('is now minus 30 days for the last 30 days', () => {
		expect(rangeToSince('30d', NOW)).toBe('2026-02-08T12:00:00.000Z');
	});

	it('moves with the clock (computed per request, never cached)', () => {
		expect(rangeToSince('24h', NOW + HOUR)).toBe('2026-03-09T13:00:00.000Z');
	});

	it('offers exactly Any time, 24 hours, 7 days and 30 days, Any time first', () => {
		expect(SEARCH_RANGES.map((r) => r.value)).toEqual([
			'any',
			'24h',
			'7d',
			'30d',
		]);
	});
});

describe('Date range setting', () => {
	it('is a wherever- prefixed localStorage key', () => {
		expect(SEARCH_RANGE_KEY).toBe('wherever-search-range');
	});

	it('defaults to Any time and round-trips', () => {
		const storage = memoryStorage();
		expect(readSearchRange(storage)).toBe('any');
		writeSearchRange(storage, '7d');
		expect(storage.data.get(SEARCH_RANGE_KEY)).toBe('7d');
		expect(readSearchRange(storage)).toBe('7d');
		writeSearchRange(storage, 'any');
		expect(storage.data.has(SEARCH_RANGE_KEY)).toBe(false);
		expect(readSearchRange(storage)).toBe('any');
	});

	it('reads an unknown stored value as Any time', () => {
		const storage = memoryStorage();
		storage.data.set(SEARCH_RANGE_KEY, '1y');
		expect(readSearchRange(storage)).toBe('any');
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
		expect(readSearchRange(broken)).toBe('any');
		expect(() => writeSearchRange(broken, '24h')).not.toThrow();
		expect(readSearchRange(undefined)).toBe('any');
	});
});

describe('searchRequestParams since', () => {
	it('sends since when bounded and leaves it out for Any time', () => {
		expect(
			searchRequestParams({query: 'x', since: '2026-03-09T12:00:00.000Z'}).get(
				'since',
			),
		).toBe('2026-03-09T12:00:00.000Z');
		expect(
			searchRequestParams({query: 'x', since: undefined}).has('since'),
		).toBe(false);
	});
});
