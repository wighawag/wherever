// Instant resume: the web-side decisions that wire the on-device conversation
// cache (./conversation-cache.ts) to the client's hydration seam (docs/adr/0013).
//
// Pure on purpose, like `decideHashJoin` (./view-mode.ts): the web tests run in
// a node environment with no DOM, so the cache, the client calls and the
// window's location/history are all injected. `+page.svelte`,
// `ConnectionSettings.svelte` and `wherever.ts` only call these.
//
// Decisions recorded here (see also CONTEXT.md "Instant resume wiring"):
// - A snapshot is written ONLY under the client's stamped `serverKey` and ONLY
//   once the active session's history is authoritative. Before that the store
//   holds the cached copy itself (nothing new to save) or a rejoin in flight, so
//   skipping loses nothing and guarantees a record is never derived from a
//   view the server has not confirmed since the last write.
// - The boot cache read is raced against a timeout and every failure is a
//   miss, so a slow or broken IndexedDB can delay boot by at most `timeoutMs`
//   and never stops it from connecting.
// - While booting, a `pageshow` / `visibilitychange: visible` does NOT
//   connect: on a fresh load `pageshow` always fires, and its plain `connect()`
//   would reset the store under a hydration in progress. The flag clears as
//   soon as boot has ISSUED its own connect (not when the socket opens), so an
//   offline boot cannot hold the handlers off forever.

import type {ChatMessage} from '@wherever-dev/client';
import type {
	CachedConversation,
	CachedConversationInput,
	ConversationCache,
	WriteThrottle,
} from './conversation-cache';

/** Default cap on how long boot waits for the cache read. */
export const BOOT_CACHE_TIMEOUT_MS = 300;

/** The slice of the client's `WhereverState` the cache writes read. */
export interface ResumeStoreView {
	serverKey: string | null;
	sessionId: string | null;
	activeSessionFile: string | null;
	activeCwd: string | null;
	activeModel: string | null;
	messages: ChatMessage[];
	historyTotalCount: number;
	historyOffset: number;
	historyAuthoritative: boolean;
}

/**
 * What to write to the cache for the current store, or null to write nothing.
 * The key is the STAMPED `serverKey`, never one derived from the current
 * settings (they can be edited without a reconnect, ADR 0013).
 */
export function cacheSnapshot(
	s: ResumeStoreView,
): CachedConversationInput | null {
	if (!s.serverKey || !s.sessionId || !s.activeSessionFile) return null;
	if (!s.historyAuthoritative) return null;
	if (s.messages.length === 0) return null;
	return {
		serverKey: s.serverKey,
		sessionId: s.sessionId,
		sessionFile: s.activeSessionFile,
		cwd: s.activeCwd,
		model: s.activeModel,
		messages: s.messages,
		historyTotalCount: s.historyTotalCount,
		historyOffset: s.historyOffset,
	};
}

/**
 * "Load older messages" is offered only once the history is authoritative: a
 * hydrated (or rejoining) store's paging offset may be stale, and the client's
 * `loadMoreHistory()` is a no-op until then anyway.
 */
export function canLoadOlderHistory(s: {
	historyOffset: number;
	historyAuthoritative: boolean;
}): boolean {
	return s.historyAuthoritative && s.historyOffset > 0;
}

/**
 * What a return to the page (`visibilitychange: visible`, `pageshow`) should do
 * after its `noteVisible()` probe. `none` while booting (see the module note),
 * and when already connected.
 */
export function decideReturn(i: {
	booting: boolean;
	connected: boolean;
	hasActiveSession: boolean;
}): 'none' | 'resume' | 'connect' {
	if (i.booting || i.connected) return 'none';
	return i.hasActiveSession ? 'resume' : 'connect';
}

/**
 * Read the cached record for the session the URL hash names, for boot. Resolves
 * null on no hash, a miss, a record that does not match, a failure, or after
 * `timeoutMs`. Never rejects.
 */
export function readBootCache(i: {
	cache: ConversationCache;
	serverKey: string;
	hashId: string;
	timeoutMs?: number;
}): Promise<CachedConversation | null> {
	if (!i.hashId) return Promise.resolve(null);
	const timeoutMs = i.timeoutMs ?? BOOT_CACHE_TIMEOUT_MS;
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), timeoutMs);
		const settle = (r: CachedConversation | null) => {
			clearTimeout(timer);
			resolve(r);
		};
		let read: Promise<CachedConversation | null>;
		try {
			read = i.cache.get(i.serverKey, i.hashId);
		} catch {
			return settle(null);
		}
		read.then(
			(r) =>
				settle(
					r && r.sessionId === i.hashId && r.serverKey === i.serverKey
						? r
						: null,
				),
			() => settle(null),
		);
	});
}

/**
 * Boot: on a cache hit hydrate the client and connect PRESERVING the store, so
 * the conversation is on screen before the socket opens and the rejoin
 * replaces it. On a miss (or if the client refused / failed to hydrate),
 * connect exactly as before. `connect` is called exactly once, always.
 * `hydrate` returns whether the record is now in the store.
 */
export async function runBoot(deps: {
	cached: Promise<CachedConversation | null>;
	hydrate: (record: CachedConversation) => boolean;
	connect: (opts: {preserveState: boolean}) => void;
}): Promise<'hydrated' | 'plain'> {
	let hydrated = false;
	try {
		const record = await deps.cached;
		if (record) hydrated = deps.hydrate(record);
	} catch {
		hydrated = false;
	}
	deps.connect({preserveState: hydrated});
	return hydrated ? 'hydrated' : 'plain';
}

/**
 * Every connect keeps only the server it connects to. Reconnect and a
 * same-server Connect therefore keep everything; connecting to another server
 * drops the previous one's conversations (ADR 0013, story 7).
 */
export function retainCurrentServer(
	cache: ConversationCache,
	serverKey: string,
): Promise<void> {
	return cache.retainOnly(serverKey);
}

/**
 * Both Disconnect actions wipe the cache. ONLY those two handlers call this,
 * never the shared `disconnect()`: Connect and Reconnect call `disconnect()`
 * before `connect()`, and wiping there would lose the cache they must keep.
 * A pending throttled write is dropped first so it cannot re-create a record.
 */
export function clearCacheOnDisconnect(
	cache: ConversationCache,
	throttle: WriteThrottle | null,
): Promise<void> {
	throttle?.cancel();
	return cache.clear();
}

export interface HashWindow {
	location: {hash: string; pathname: string; search: string};
	history: {
		state: unknown;
		replaceState(data: unknown, unused: string, url?: string | null): void;
	};
}

/**
 * The server refused the hydrated session's load (`hydration_rejected`). Clear
 * the hash FIRST and SYNCHRONOUSLY with `replaceState`: the page's hash effect
 * would otherwise clear it with `location.hash = ''` (a history entry, so Back
 * returns to the dead session), and a lingering hash would drive the auto-join
 * into re-joining it. Only a hash naming the rejected session is cleared. Then
 * evict the record under the key it was hydrated from.
 */
export function handleHydrationRejected(i: {
	sessionId: string;
	serverKey: string | null;
	win: HashWindow | null;
	cache: ConversationCache;
}): void {
	const w = i.win;
	if (w && w.location.hash) {
		let hashId = '';
		try {
			hashId = decodeURIComponent(w.location.hash.slice(1));
		} catch {
			hashId = w.location.hash.slice(1);
		}
		if (hashId === i.sessionId) {
			w.history.replaceState(
				w.history.state,
				'',
				w.location.pathname + w.location.search,
			);
		}
	}
	if (i.serverKey) void i.cache.remove(i.serverKey, i.sessionId);
}
