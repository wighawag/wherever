/**
 * The conversation search panel's sort (Relevance / Newest) and its remembered
 * setting. Pure (storage is handed in), so it is unit-tested;
 * `ConversationSearch.svelte` owns the toggle.
 *
 * Newest is sent as `sort=recent`: the server forwards it to memonaut's
 * `order: 'recent'`, which orders by when the MATCHED MESSAGE was said (its
 * entry `ts`) BEFORE the result limit, so it returns the newest matches overall,
 * not a re-sort of the most relevant few.
 */

/** The wire values of `GET /search`'s `sort` (the server's `SearchSort`). */
export type SearchSort = 'relevance' | 'recent';

/** The offered sorts, in display order; `relevance` (the default) first. */
export const SEARCH_SORTS: ReadonlyArray<{value: SearchSort; label: string}> = [
	{value: 'relevance', label: 'Relevance'},
	{value: 'recent', label: 'Newest'},
];

/**
 * Where the sort is remembered on this device. One value for both the main and
 * the read-only search views, like the date range (`wherever-search-range`)
 * and "Include closed". Absent means Relevance.
 */
export const SEARCH_SORT_KEY = 'wherever-search-sort';

type SettingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isSearchSort(value: unknown): value is SearchSort {
	return SEARCH_SORTS.some((s) => s.value === value);
}

/** The remembered sort (Relevance by default or on an unknown value; never throws). */
export function readSearchSort(
	storage: SettingStorage | undefined,
): SearchSort {
	try {
		const stored = storage?.getItem(SEARCH_SORT_KEY);
		return isSearchSort(stored) ? stored : 'relevance';
	} catch {
		return 'relevance';
	}
}

/** Remember the sort. No storage (private mode): simply not remembered. */
export function writeSearchSort(
	storage: SettingStorage | undefined,
	sort: SearchSort,
): void {
	try {
		if (sort === 'relevance') storage?.removeItem(SEARCH_SORT_KEY);
		else storage?.setItem(SEARCH_SORT_KEY, sort);
	} catch {
		// Not remembered; the sort still applies to this panel.
	}
}
