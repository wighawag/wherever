/**
 * The conversation search panel's date range (Any time, last 24 hours, last 7
 * days, last 30 days) and its remembered setting. Pure (storage and the clock
 * are handed in), so it is unit-tested; `ConversationSearch.svelte` owns the
 * selector and calls `rangeToSince` at REQUEST time, so re-running a query
 * moves the window with the clock.
 *
 * The bound is on when the MATCHED MESSAGE was said (memonaut's entry `ts`),
 * not on the session's last activity; the server forwards it as `since`.
 */

export type SearchRange = 'any' | '24h' | '7d' | '30d';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The offered ranges, in display order; `any` (the default) first. */
export const SEARCH_RANGES: ReadonlyArray<{
	value: SearchRange;
	label: string;
	/** Window length, or null for unbounded. */
	ms: number | null;
}> = [
	{value: 'any', label: 'Any time', ms: null},
	{value: '24h', label: 'Last 24 hours', ms: DAY_MS},
	{value: '7d', label: 'Last 7 days', ms: 7 * DAY_MS},
	{value: '30d', label: 'Last 30 days', ms: 30 * DAY_MS},
];

/**
 * Where the range is remembered on this device. One value for both the main
 * and the read-only search views, like "Include closed"
 * (`wherever-search-include-closed`). Absent means Any time.
 */
export const SEARCH_RANGE_KEY = 'wherever-search-range';

type SettingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isSearchRange(value: unknown): value is SearchRange {
	return SEARCH_RANGES.some((r) => r.value === value);
}

/** The `since` to send: undefined for Any time, else `now - range` as ISO (`Z`). */
export function rangeToSince(
	range: SearchRange,
	now: number,
): string | undefined {
	const ms = SEARCH_RANGES.find((r) => r.value === range)?.ms;
	if (ms == null) return undefined;
	return new Date(now - ms).toISOString();
}

/** The remembered range (Any time by default or on an unknown value; never throws). */
export function readSearchRange(
	storage: SettingStorage | undefined,
): SearchRange {
	try {
		const stored = storage?.getItem(SEARCH_RANGE_KEY);
		return isSearchRange(stored) ? stored : 'any';
	} catch {
		return 'any';
	}
}

/** Remember the range. No storage (private mode): simply not remembered. */
export function writeSearchRange(
	storage: SettingStorage | undefined,
	range: SearchRange,
): void {
	try {
		if (range === 'any') storage?.removeItem(SEARCH_RANGE_KEY);
		else storage?.setItem(SEARCH_RANGE_KEY, range);
	} catch {
		// Not remembered; the range still applies to this panel.
	}
}
