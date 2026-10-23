// On-device cache of recently viewed conversations (docs/adr/0013).
//
// Purpose: after the OS kills the PWA in the background, a reload has nothing to
// show until the socket is up, the session is re-loaded and the history frame
// has crossed a mobile link. This cache lets boot paint the last-seen
// conversation immediately; the server's authoritative history then replaces it.
// It is ONLY a cache: anything here may be missing, stale or evicted at any time,
// and every caller must behave exactly as before when it is.
//
// Self-contained on purpose: the server identity arrives as a plain string (the
// client's STAMPED `serverKey`, never re-derived here) and nothing at runtime
// comes from `@wherever-dev/client` (the `ChatMessage` import is type-only).
// Which events trigger a write, and which key to write under, are the caller's
// decisions.
//
// Multi-tab: two tabs viewing the same session both write the same
// `(serverKey, sessionId)` record and the LAST WRITE WINS. That is accepted
// (spec story 12): a record is a hint for the first paint, overwritten by the
// authoritative history either way, so a merge would buy nothing.

import type {ChatMessage} from '@wherever-dev/client';

/** IndexedDB database name. One object store, `conversations`. */
export const CONVERSATION_CACHE_DB = 'wherever-conversation-cache';
const STORE = 'conversations';
const SAVED_AT_INDEX = 'savedAt';
const DB_VERSION = 1;

/** Total sessions kept across ALL server keys (global LRU by `savedAt`). */
export const MAX_CACHED_SESSIONS = 5;
/** Per-record budget in UTF-8 bytes of its JSON form. */
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
/** Default coalescing interval for `createWriteThrottle`. */
export const WRITE_THROTTLE_MS = 5000;

export interface CachedConversation {
	/** Server identity the conversation was delivered by (the client's stamp). */
	serverKey: string;
	sessionId: string;
	sessionFile: string;
	cwd: string | null;
	model: string | null;
	messages: ChatMessage[];
	/**
	 * Paging state as last seen. Kept as-is even when the byte cap trims messages:
	 * they only drive the "Load older messages" affordance, which the caller
	 * gates on the authoritative history anyway.
	 */
	historyTotalCount: number;
	historyOffset: number;
	/** ms epoch of the write; the LRU key. Stamped by `put`. */
	savedAt: number;
}

export type CachedConversationInput = Omit<CachedConversation, 'savedAt'>;

export interface ConversationCache {
	get(serverKey: string, sessionId: string): Promise<CachedConversation | null>;
	/** Normalize, trim to the byte cap, write, then enforce the session LRU. */
	put(record: CachedConversationInput): Promise<void>;
	/** Evict one record (e.g. a cached session the server refused to load). */
	remove(serverKey: string, sessionId: string): Promise<void>;
	/** Delete every record whose server key is not `serverKey`. */
	retainOnly(serverKey: string): Promise<void>;
	/** Delete everything (both Disconnect actions). */
	clear(): Promise<void>;
}

/**
 * What a cached message may contain. Applied at WRITE time so a record never
 * holds anything a hydrated view must not show:
 * - `delivery`-tagged user messages are dropped. Undelivered outbound messages
 *   are recovered separately from localStorage (`loadPersistedPending`) and
 *   re-tagged there; caching them too would double-surface them.
 * - `isStreaming` is forced to false: nothing is streaming in a page that just
 *   booted, and a stale `true` would render a live spinner forever.
 * - tool `images` (base64 payloads) are dropped: they dwarf the text, and the
 *   authoritative history brings them back moments later.
 * Returns new objects; the caller's (store-owned) messages are not mutated.
 */
export function normalizeMessages(
	messages: readonly ChatMessage[],
): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const m of messages) {
		if (m.delivery !== undefined) continue;
		const {images: _images, ...rest} = m;
		out.push({...rest, isStreaming: false});
	}
	return out;
}

function utf8Length(s: string): number {
	let bytes = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			// A surrogate pair is one 4-byte code point.
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

/**
 * Drop the OLDEST messages until the record's JSON fits in `maxBytes` UTF-8
 * bytes. Each message is measured once, so a write while streaming costs one
 * serialization pass, not one per trimmed message. Offsets are not adjusted
 * (see `historyTotalCount`). May return zero messages; `put` treats that as
 * "do not cache this session".
 */
export function trimToByteCap<T extends {messages: ChatMessage[]}>(
	record: T,
	maxBytes: number,
): T {
	// Size of the record with an empty array, then each message plus its comma.
	let total = utf8Length(JSON.stringify({...record, messages: []}));
	const sizes = record.messages.map((m) => utf8Length(JSON.stringify(m)));
	for (let i = 0; i < sizes.length; i++) total += sizes[i] + (i > 0 ? 1 : 0);
	let start = 0;
	while (total > maxBytes && start < sizes.length) {
		total -= sizes[start] + (start < sizes.length - 1 ? 1 : 0);
		start++;
	}
	return start === 0
		? record
		: {...record, messages: record.messages.slice(start)};
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

export interface ConversationCacheOptions {
	/**
	 * The IndexedDB factory. Defaults to `globalThis.indexedDB`; `null` (or a
	 * missing global) means "no storage", i.e. a disabled cache.
	 */
	indexedDB?: IDBFactory | null;
	now?: () => number;
	maxSessions?: number;
	maxRecordBytes?: number;
}

/**
 * Open the cache. The database is opened lazily on first use. If `open` throws
 * or fails (private mode, blocked storage, an old browser), the cache disables
 * itself for the rest of the page: every call resolves to a harmless no-op
 * (`get` -> null) and the open is not retried. A later per-operation failure
 * (quota, eviction mid-transaction) is swallowed the same way but does not
 * disable the cache. Nothing here ever throws or rejects to the caller.
 */
export function createConversationCache(
	options: ConversationCacheOptions = {},
): ConversationCache {
	const factory =
		options.indexedDB !== undefined
			? options.indexedDB
			: ((globalThis as {indexedDB?: IDBFactory}).indexedDB ?? null);
	const now = options.now ?? Date.now;
	const maxSessions = options.maxSessions ?? MAX_CACHED_SESSIONS;
	const maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;

	let dbPromise: Promise<IDBDatabase | null> | null = null;

	function open(): Promise<IDBDatabase | null> {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise<IDBDatabase | null>((resolve) => {
			if (!factory) return resolve(null);
			let req: IDBOpenDBRequest;
			try {
				req = factory.open(CONVERSATION_CACHE_DB, DB_VERSION);
			} catch {
				return resolve(null);
			}
			req.onupgradeneeded = () => {
				const store = req.result.createObjectStore(STORE, {
					keyPath: ['serverKey', 'sessionId'],
				});
				store.createIndex(SAVED_AT_INDEX, 'savedAt');
			};
			req.onsuccess = () => {
				const db = req.result;
				// Another tab upgrading the schema: step aside rather than block it.
				db.onversionchange = () => db.close();
				resolve(db);
			};
			req.onerror = () => resolve(null);
			req.onblocked = () => resolve(null);
		});
		return dbPromise;
	}

	/** Run `fn` against the store; any failure (or a disabled cache) yields `fallback`. */
	async function withStore<T>(
		mode: IDBTransactionMode,
		fallback: T,
		fn: (store: IDBObjectStore) => Promise<T>,
	): Promise<T> {
		try {
			const db = await open();
			if (!db) return fallback;
			const tx = db.transaction(STORE, mode);
			const completed = done(tx);
			const result = await fn(tx.objectStore(STORE));
			await completed;
			return result;
		} catch {
			return fallback;
		}
	}

	/** Delete every primary key `drop` selects, walking keys only (no values loaded). */
	function deleteKeysWhere(
		store: IDBObjectStore,
		drop: (key: IDBValidKey) => boolean,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const req = store.openKeyCursor();
			req.onerror = () => reject(req.error);
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) return resolve();
				if (drop(cursor.primaryKey)) store.delete(cursor.primaryKey);
				cursor.continue();
			};
		});
	}

	return {
		get(serverKey, sessionId) {
			return withStore('readonly', null, async (store) => {
				const value = (await promisify(store.get([serverKey, sessionId]))) as
					| CachedConversation
					| undefined;
				return value ?? null;
			});
		},

		put(input) {
			return withStore('readwrite', undefined, async (store) => {
				const key = [input.serverKey, input.sessionId];
				const record = trimToByteCap(
					{
						...input,
						messages: normalizeMessages(input.messages),
						savedAt: now(),
					},
					maxRecordBytes,
				);
				if (record.messages.length === 0) {
					// Nothing fits (or nothing to show): an empty cached view would look
					// like an empty session, so cache nothing and drop any stale record.
					await promisify(store.delete(key));
					return;
				}
				await promisify(store.put(record));
				// Global LRU: oldest `savedAt` first, keys only.
				const keys = await promisify(store.index(SAVED_AT_INDEX).getAllKeys());
				for (const old of keys.slice(
					0,
					Math.max(0, keys.length - maxSessions),
				)) {
					store.delete(old);
				}
			});
		},

		remove(serverKey, sessionId) {
			return withStore('readwrite', undefined, async (store) => {
				await promisify(store.delete([serverKey, sessionId]));
			});
		},

		retainOnly(serverKey) {
			return withStore('readwrite', undefined, (store) =>
				deleteKeysWhere(
					store,
					(key) => (key as [string, string])[0] !== serverKey,
				),
			);
		},

		clear() {
			return withStore('readwrite', undefined, async (store) => {
				await promisify(store.clear());
			});
		},
	};
}

export interface WriteThrottle {
	/** Note that a write is due; it happens at most once per interval. */
	schedule(): void;
	/** Write now and drop any pending throttled write. */
	flush(): void;
	/** Drop any pending throttled write without writing. */
	cancel(): void;
}

/**
 * Coalesce cache writes so a streaming reply costs at most one write per
 * `intervalMs`. `write` takes no arguments: it should snapshot the CURRENT state
 * when it runs, so the trailing write always carries the latest text. The first
 * `schedule()` arms a timer and later ones inside the window are absorbed
 * (trailing-edge only: the first write of a burst lands one interval in, which
 * is fine for a cache and keeps the write off the hot path of the first token).
 * `flush()` is for the caller's "write now" moments (history arrived, agent
 * ended, page hidden). A failing `write` is swallowed: a lost cache write must
 * never surface as an error.
 */
export function createWriteThrottle(
	write: () => unknown,
	options: {intervalMs?: number} = {},
): WriteThrottle {
	const intervalMs = options.intervalMs ?? WRITE_THROTTLE_MS;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function run() {
		try {
			const result = write();
			if (result && typeof (result as Promise<unknown>).catch === 'function') {
				(result as Promise<unknown>).catch(() => {});
			}
		} catch {
			// Swallowed: see above.
		}
	}

	function cancel() {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}

	return {
		schedule() {
			if (timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				run();
			}, intervalMs);
		},
		flush() {
			cancel();
			run();
		},
		cancel,
	};
}
