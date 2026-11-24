/**
 * The conversation search request (`GET /search`) and the panel's remembered
 * "Include closed" setting. Pure (storage is handed in), so it is unit-tested;
 * `searchConversations` in `session-store.ts` sends the request and
 * `ConversationSearch.svelte` owns the toggle.
 */

import type {SearchSort} from './search-sort.js';

/**
 * Where "Include closed" is remembered on this device (on when `'1'`). One
 * value for both the main and the read-only search views, like the panel's
 * other settings; distinct from the sidebar's "Show closed"
 * (`wherever-show-closed`), which governs the folder list, not search.
 */
export const INCLUDE_CLOSED_KEY = 'wherever-search-include-closed';

type SettingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Whether closed sessions are included in search (off by default; never throws). */
export function readIncludeClosed(
	storage: SettingStorage | undefined,
): boolean {
	try {
		return storage?.getItem(INCLUDE_CLOSED_KEY) === '1';
	} catch {
		return false;
	}
}

/** Remember the setting. No storage (private mode): simply not remembered. */
export function writeIncludeClosed(
	storage: SettingStorage | undefined,
	on: boolean,
): void {
	try {
		if (on) storage?.setItem(INCLUDE_CLOSED_KEY, '1');
		else storage?.removeItem(INCLUDE_CLOSED_KEY);
	} catch {
		// Not remembered; the toggle still applies to this panel.
	}
}

export interface SearchRequest {
	query: string;
	view?: 'default' | 'readonly';
	/** Keep closed sessions (the server returns them flagged `closed: true`). */
	includeClosed?: boolean;
	/**
	 * Lower bound (ISO) on when the matched message was said; absent = Any time.
	 * Built by `rangeToSince` (search-range.ts) at request time.
	 */
	since?: string;
	/**
	 * Result order (search-sort.ts); only `recent` (Newest) is sent, Relevance
	 * is the server default.
	 */
	sort?: SearchSort;
	token?: string | null;
}

/** The query string of one `GET /search`; defaults are left out. */
export function searchRequestParams(req: SearchRequest): URLSearchParams {
	const params = new URLSearchParams({q: req.query});
	if (req.view === 'readonly') params.set('view', 'readonly');
	if (req.includeClosed) params.set('includeClosed', '1');
	if (req.since) params.set('since', req.since);
	if (req.sort === 'recent') params.set('sort', 'recent');
	if (req.token) params.set('token', req.token);
	return params;
}
