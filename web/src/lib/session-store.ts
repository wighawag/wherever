import {writable, get} from 'svelte/store';
import {defaultAppearance, type AppearanceInfo} from '$lib/theme';
import {adoptTokenFromUrlOnce} from '$lib/core/token-adoption';
import {searchRequestParams} from '$lib/core/search-request';
import type {SearchSort} from '$lib/core/search-sort';
import type {TelegramStatus} from '$lib/core/telegram-settings';
import {
	emptyShipmatesState,
	parseShipmatesUpdate,
	type ShipmatesState,
} from '$lib/core/shipmates';
import {
	CLOSE_BANNER_MS,
	closeFolder,
	closeWithCascade,
	undoClose,
	type CloseApi,
	type CloseBanner,
	type CloseResult,
} from '$lib/core/close-flow';

// getToken()/getBaseUrl() below read the stored config STRAIGHT out of
// localStorage, and a route can import this module without importing
// wherever.ts, so adoption is kicked off here at module scope too. It is
// idempotent and shares its state with the call in getConfig().
adoptTokenFromUrlOnce();

export interface SessionInfo {
	path: string;
	id: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	// Short, capped preview of the first user message (not the full text).
	firstMessage: string;
	isActive: boolean;
	// True while the agent is mid-turn. Seeded by /sessions, then kept live by
	// `session_working` frames via setSessionWorking().
	isWorking?: boolean;
	clientCount: number;
	// Absolute path of the parent session this one was forked from, or undefined
	// for a root session. Used to build the fork-hierarchy tree in the browser.
	parentSessionPath?: string;
	// True when the user starred it ("come back to this"). Server-side, so a
	// star set on one device shows on every other.
	starred?: boolean;
	// True when the user closed it (done with it, not deleted). Server-side;
	// `/sessions` always returns closed sessions and the client hides them.
	closed?: boolean;
	// The session that spawned this one through shipmates (`session_spawn`), when
	// the server has shipmates. Owner and child may be in different folders.
	ownerSessionPath?: string;
}

export interface FolderWithSessions {
	path: string;
	name: string;
	sessions: SessionInfo[];
	readOnly?: boolean;
	// True when this folder does not exist on this machine (the listing view of
	// the folder-missing state). ORTHOGONAL to readOnly, which is a configured
	// policy: a folder can be either, both or neither, so the browser renders the
	// two differently and never as one thing.
	missing?: boolean;
}

export interface ModelInfo {
	provider: string;
	modelId: string;
	label: string;
	isDefault?: boolean;
}

export interface SessionStoreData {
	folders: FolderWithSessions[];
	activeSessions: string[];
	currentSession: string | null;
	loading: boolean;
}

export interface ModelsStoreData {
	models: ModelInfo[];
	loading: boolean;
}

export const sessionFolders = writable<SessionStoreData>({
	folders: [],
	activeSessions: [],
	currentSession: null,
	loading: false,
});

export const availableModels = writable<ModelsStoreData>({
	models: [],
	loading: false,
});

// Separate store for the read-only sessions page (sessions.readOnly folders),
// fetched on demand via /sessions?view=readonly. Kept distinct from the main
// list so the default dashboard payload stays small.
export const readOnlySessionFolders = writable<SessionStoreData>({
	folders: [],
	activeSessions: [],
	currentSession: null,
	loading: false,
});

// Default port when none is explicitly configured: prefer the page's own
// origin port so reverse-proxy deployments (e.g. https://host behind Caddy on
// 443, no port in the URL) work without the user configuring a port. Falls
// back to the dev default 31415 only when no usable location port exists.
function defaultPort(): number {
	if (typeof window !== 'undefined' && window.location) {
		const loc = window.location;
		if (loc.port) return Number(loc.port);
		if (loc.protocol === 'https:') return 443;
		if (loc.protocol === 'http:') return 80;
	}
	return 31415;
}

export function getBaseUrl(): string {
	const config = localStorage.getItem('wherever-config');
	const defaultHost =
		typeof window !== 'undefined' && window.location && window.location.hostname
			? window.location.hostname
			: 'localhost';

	if (config) {
		const parsed = JSON.parse(config);
		const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
		let host = parsed.host || defaultHost;
		if (host === 'localhost' || host === '127.0.0.1') {
			if (
				defaultHost &&
				defaultHost !== 'localhost' &&
				defaultHost !== '127.0.0.1'
			) {
				host = defaultHost;
			}
		}
		host = host.startsWith('http') ? host.replace(/^wss?:\/\//, '') : host;
		// Heal a legacy stored 31415 when actually served from another origin
		// port (matches getConfig() in wherever.ts), so proxied setups don't
		// dial a closed 31415.
		let port = parsed.port;
		if ((port === 31415 || port === undefined) && defaultPort() !== 31415) {
			port = defaultPort();
		}
		return `${protocol}//${host}:${port || defaultPort()}`;
	}
	return `${window.location.protocol}//${window.location.host}`;
}

let fetchTimeout: ReturnType<typeof setTimeout> | null = null;
let resolveQueue: (() => void)[] = [];
// In-flight + coalescing guards: a stream of `sessions_updated` events (one per
// agent turn) used to pull the whole list repeatedly. We now (a) never run two
// fetches at once, (b) collapse any requests that arrive during a fetch into a
// single trailing re-fetch, and (c) cap the debounce reset so a continuous
// stream still resolves promptly instead of being pushed back forever.
let fetchInFlight = false;
let refetchRequested = false;
let firstQueuedAt = 0;
const FETCH_DEBOUNCE_MS = 150;
const FETCH_MAX_WAIT_MS = 1000;

async function doFetchSessions(): Promise<void> {
	fetchInFlight = true;
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/sessions${token ? `?token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		sessionFolders.set({
			folders: data.folders || [],
			activeSessions: (data.activeSessions || []).map(
				(s: any) => s.sessionFile,
			),
			currentSession: get(sessionFolders).currentSession,
			loading: false,
		});
	} catch (err) {
		sessionFolders.update((s) => ({...s, loading: false}));
		console.error('Failed to fetch sessions:', err);
	} finally {
		fetchInFlight = false;
	}
}

export function fetchSessions(): Promise<void> {
	sessionFolders.update((s) => ({...s, loading: true}));

	const promise = new Promise<void>((resolve) => {
		resolveQueue.push(resolve);
	});

	// If a fetch is already running, just mark that we need one more pass when it
	// finishes (collapsing any number of mid-flight requests into a single one).
	// The resolver we just queued is drained by that trailing pass, so the
	// returned promise still settles even though we schedule nothing here.
	if (fetchInFlight) {
		refetchRequested = true;
		return promise;
	}

	const now = Date.now();
	if (!fetchTimeout) {
		firstQueuedAt = now;
	} else {
		clearTimeout(fetchTimeout);
		// Cap the debounce: if we have already been waiting MAX_WAIT, fire now
		// rather than letting a continuous event stream postpone the fetch forever.
		if (now - firstQueuedAt >= FETCH_MAX_WAIT_MS) {
			fetchTimeout = null;
			void runQueuedFetch();
			return promise;
		}
	}

	fetchTimeout = setTimeout(() => {
		fetchTimeout = null;
		void runQueuedFetch();
	}, FETCH_DEBOUNCE_MS);

	return promise;
}

async function runQueuedFetch(): Promise<void> {
	try {
		// Each pass claims the resolvers queued so far and settles them with THAT
		// pass's data. Requests that arrive mid-flight queue their resolver and set
		// refetchRequested, so the loop runs one more pass and settles them against
		// fresher data. Claiming the queue up-front instead (the previous shape)
		// stranded any resolver added during the fetch: nothing scheduled a further
		// pass for it, so `await fetchSessions()` could hang forever.
		do {
			refetchRequested = false;
			const resolves = resolveQueue;
			resolveQueue = [];
			try {
				await doFetchSessions();
			} finally {
				for (const r of resolves) r();
			}
		} while (refetchRequested);
	} finally {
		// Safety net: never strand a resolver, whatever happens above.
		const rest = resolveQueue;
		resolveQueue = [];
		for (const r of rest) r();
	}
}

// Patch one session's `starred` flag in a folders store, in place. Returns the
// value it had before (undefined when the session is not in this store), so a
// failed request can restore exactly that.
function patchStarred(
	store: typeof sessionFolders,
	sessionFile: string,
	starred: boolean | undefined,
): boolean | undefined {
	let previous: boolean | undefined;
	store.update((s) => ({
		...s,
		folders: s.folders.map((f) =>
			f.sessions.some((x) => x.path === sessionFile)
				? {
						...f,
						sessions: f.sessions.map((x) => {
							if (x.path !== sessionFile) return x;
							previous = !!x.starred;
							return {...x, starred};
						}),
					}
				: f,
		),
	}));
	return previous;
}

/**
 * Star or unstar a session (POST /sessions/star). OPTIMISTIC: the list flips at
 * once so the tap feels instant, and if the server refuses, each store is put
 * back to the value it had before THIS call (not `!starred`, which would be
 * wrong after a quick star-then-unstar). The server then broadcasts
 * `sessions_updated`, so every other open dashboard re-lists and picks it up.
 */
export async function setSessionStarred(
	sessionFile: string,
	starred: boolean,
): Promise<void> {
	const prevMain = patchStarred(sessionFolders, sessionFile, starred);
	const prevReadOnly = patchStarred(
		readOnlySessionFolders,
		sessionFile,
		starred,
	);
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/sessions/star${token ? `?token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({sessionFile, starred}),
		});
		if (!res.ok) {
			const errData = await res.json().catch(() => ({}));
			throw new Error(errData.error || `Star failed with status ${res.status}`);
		}
	} catch (err) {
		if (prevMain !== undefined)
			patchStarred(sessionFolders, sessionFile, prevMain);
		if (prevReadOnly !== undefined) {
			patchStarred(readOnlySessionFolders, sessionFile, prevReadOnly);
		}
		console.error('Failed to update star:', err);
		throw err;
	}
}

/**
 * Rename a session (POST /sessions/name, ADR 0027). NOT optimistic: the name is
 * written by whichever process owns the file (the server's agent, the terminal
 * pi through the bridge, or an append on disk), and the server broadcasts
 * `sessions_updated` on success, so the new name arrives through the normal
 * relist on every dashboard. A refusal (an old terminal extension, a session
 * with no message yet, a load or reload in progress) REJECTS with the server's
 * error text, for the rename prompt to show in place. Resolves to the name as
 * stored (trimmed, whitespace collapsed).
 */
export async function renameSession(
	sessionFile: string,
	name: string,
): Promise<{sessionFile: string; name: string}> {
	const res = await fetch(apiUrl('/sessions/name'), {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({sessionFile, name}),
	});
	if (!res.ok) {
		const errData = await res.json().catch(() => ({}));
		throw new Error(errData.error || `Rename failed with status ${res.status}`);
	}
	return (await res.json()) as {sessionFile: string; name: string};
}

// Patch one session's `closed` and `starred` flags in a folders store, in place.
// `next` gets the current flags and returns the new ones. Returns the values
// they had before (undefined when the session is not in this store), so a
// failed request can restore exactly those.
type ClosedFlags = {closed: boolean; starred: boolean};
function patchClosed(
	store: typeof sessionFolders,
	sessionFile: string,
	next: (prev: ClosedFlags) => ClosedFlags,
): ClosedFlags | undefined {
	return patchClosedMany(store, [sessionFile], (_, prev) => next(prev)).get(
		sessionFile,
	);
}

// The same for many sessions in ONE store write (a folder close). Returns the
// previous flags of every patched session, by path.
function patchClosedMany(
	store: typeof sessionFolders,
	sessionFiles: readonly string[],
	next: (sessionFile: string, prev: ClosedFlags) => ClosedFlags,
): Map<string, ClosedFlags> {
	const wanted = new Set(sessionFiles);
	const previous = new Map<string, ClosedFlags>();
	store.update((s) => ({
		...s,
		folders: s.folders.map((f) =>
			f.sessions.some((x) => wanted.has(x.path))
				? {
						...f,
						sessions: f.sessions.map((x) => {
							if (!wanted.has(x.path)) return x;
							const prev = {closed: !!x.closed, starred: !!x.starred};
							previous.set(x.path, prev);
							const flags = next(x.path, prev);
							return {
								...x,
								closed: flags.closed || undefined,
								starred: flags.starred || undefined,
							};
						}),
					}
				: f,
		),
	}));
	return previous;
}

/**
 * Close many sessions as ONE batch (POST /sessions/close `{sessionFiles}`, the
 * folder's "Close all"), never cascading. OPTIMISTIC with rollback like
 * `setSessionClosed`: every file is marked closed and unstarred locally at once,
 * and a refusal restores each one's flags. Resolves to `{batch, sessions}`.
 */
export async function setSessionsClosed(
	sessionFiles: string[],
): Promise<{batch: string | null; sessions: string[]}> {
	const optimistic = (): ClosedFlags => ({closed: true, starred: false});
	const prevMain = patchClosedMany(sessionFolders, sessionFiles, optimistic);
	const prevReadOnly = patchClosedMany(
		readOnlySessionFolders,
		sessionFiles,
		optimistic,
	);
	try {
		const res = await fetch(apiUrl('/sessions/close'), {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({sessionFiles, closed: true}),
		});
		if (!res.ok) {
			const errData = await res.json().catch(() => ({}));
			throw new Error(
				errData.error || `Close failed with status ${res.status}`,
			);
		}
		return (await res.json()) as {batch: string | null; sessions: string[]};
	} catch (err) {
		const restore =
			(prev: Map<string, ClosedFlags>) =>
			(file: string, current: ClosedFlags): ClosedFlags =>
				prev.get(file) ?? current;
		patchClosedMany(sessionFolders, [...prevMain.keys()], restore(prevMain));
		patchClosedMany(
			readOnlySessionFolders,
			[...prevReadOnly.keys()],
			restore(prevReadOnly),
		);
		console.error('Failed to close the sessions:', err);
		throw err;
	}
}

/**
 * Close or reopen a session (POST /sessions/close). OPTIMISTIC with rollback,
 * like `setSessionStarred`. Close and star are exclusive, so an optimistic
 * close also clears `starred` locally (the server does the same), and a
 * refusal restores both flags. Resolves to the server's answer: every close
 * carries a fresh `batch` id (for undo), a reopen `batch: null`, and
 * `sessions` lists the sessions it changed.
 */
export async function setSessionClosed(
	sessionFile: string,
	closed: boolean,
	cascade = false,
): Promise<{batch: string | null; sessions: string[]}> {
	const optimistic = (prev: ClosedFlags): ClosedFlags => ({
		closed,
		starred: closed ? false : prev.starred,
	});
	const prevMain = patchClosed(sessionFolders, sessionFile, optimistic);
	const prevReadOnly = patchClosed(
		readOnlySessionFolders,
		sessionFile,
		optimistic,
	);
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/sessions/close${token ? `?token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(
				cascade ? {sessionFile, closed, cascade} : {sessionFile, closed},
			),
		});
		if (!res.ok) {
			const errData = await res.json().catch(() => ({}));
			throw new Error(
				errData.error || `Close failed with status ${res.status}`,
			);
		}
		const answer = (await res.json()) as {
			batch: string | null;
			sessions: string[];
		};
		// The owned sessions a cascade took are not patched optimistically: list again.
		if (cascade) void fetchSessions();
		return answer;
	} catch (err) {
		if (prevMain !== undefined)
			patchClosed(sessionFolders, sessionFile, () => prevMain);
		if (prevReadOnly !== undefined)
			patchClosed(readOnlySessionFolders, sessionFile, () => prevReadOnly);
		console.error('Failed to update closed state:', err);
		throw err;
	}
}

// --- Close with cascade and undo (core/close-flow.ts) ------------------------

function apiUrl(pathname: string, query: Record<string, string> = {}): string {
	const token = getToken();
	const params = new URLSearchParams(query);
	if (token) params.set('token', token);
	const qs = params.toString();
	return `${getBaseUrl()}${pathname}${qs ? `?${qs}` : ''}`;
}

const closeApi: CloseApi = {
	async owned(sessionFile) {
		const res = await fetch(apiUrl('/sessions/owned', {sessionFile}));
		if (!res.ok)
			throw new Error(`Owned lookup failed with status ${res.status}`);
		const body = (await res.json()) as {sessions?: unknown};
		return Array.isArray(body.sessions) ? (body.sessions as string[]) : [];
	},
	close: (sessionFile, cascade) => setSessionClosed(sessionFile, true, cascade),
	closeMany: (sessionFiles) => setSessionsClosed(sessionFiles),
	async reopenBatch(batch): Promise<CloseResult> {
		const res = await fetch(apiUrl('/sessions/close'), {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({batch, closed: false}),
		});
		if (!res.ok) {
			const errData = await res.json().catch(() => ({}));
			throw new Error(errData.error || `Undo failed with status ${res.status}`);
		}
		const answer = (await res.json()) as CloseResult;
		void fetchSessions();
		return answer;
	},
};

/**
 * How many open sessions closing `sessionFile` would cascade to (`GET
 * /sessions/owned`, the same count the close flow asks about): the row ⋯
 * menu's "and N owned" hint. Rejects on a failed lookup.
 */
export async function fetchOwnedCount(sessionFile: string): Promise<number> {
	return (await closeApi.owned(sessionFile)).length;
}

/** The open "Also close the N sessions it owns?" question, or null. */
export const closePromptStore = writable<{
	sessionFile: string;
	n: number;
} | null>(null);
let answerPrompt: ((answer: boolean | null) => void) | null = null;

/** Answer the open question: true closes the subtree too, false only the session, null cancels. */
export function answerClosePrompt(answer: boolean | null): void {
	const resolve = answerPrompt;
	answerPrompt = null;
	closePromptStore.set(null);
	resolve?.(answer);
}

/** The undo banner of the latest close, or null (cleared after CLOSE_BANNER_MS). */
export const closeBannerStore = writable<CloseBanner | null>(null);
let bannerTimer: ReturnType<typeof setTimeout> | null = null;

function showBanner(banner: CloseBanner | null): void {
	if (bannerTimer) clearTimeout(bannerTimer);
	bannerTimer = null;
	closeBannerStore.set(banner);
	if (banner) {
		bannerTimer = setTimeout(() => {
			bannerTimer = null;
			if (get(closeBannerStore)?.batch === banner.batch)
				closeBannerStore.set(null);
		}, CLOSE_BANNER_MS);
	}
}

/** Hide the undo banner without undoing. */
export function dismissCloseBanner(): void {
	showBanner(null);
}

/**
 * Close a session the way the UI does: ask about its owned sessions (N from the
 * server), close, then show the undo banner. Failures are logged (the store
 * already rolled the optimistic flag back).
 */
export async function closeSession(sessionFile: string): Promise<void> {
	answerClosePrompt(null); // a question still open for another session is cancelled
	try {
		const banner = await closeWithCascade(
			sessionFile,
			closeApi,
			(n) =>
				new Promise((resolve) => {
					answerPrompt = resolve;
					closePromptStore.set({sessionFile, n});
				}),
		);
		if (banner) showBanner(banner);
	} catch (err) {
		console.error('Failed to close session:', err);
	}
}

/**
 * "Close all in folder": close the given open sessions of `folder` (its shown
 * rows, see `folderCloseTargets`) as one batch, then show the folder banner.
 * No owned-session question: a folder close never cascades.
 */
export async function closeFolderSessions(
	sessionFiles: string[],
	folder: string,
): Promise<void> {
	answerClosePrompt(null);
	try {
		const banner = await closeFolder(sessionFiles, folder, closeApi);
		if (banner) showBanner(banner);
	} catch (err) {
		console.error('Failed to close the folder:', err);
	}
}

/** Undo the banner's close: reopen its whole batch (stars come back server-side). */
export async function undoLastClose(): Promise<void> {
	const banner = get(closeBannerStore);
	if (!banner) return;
	try {
		await undoClose(banner, closeApi);
		if (get(closeBannerStore)?.batch === banner.batch) showBanner(null);
	} catch (err) {
		console.error('Failed to undo close:', err);
	}
}

// Fetch the read-only session folders (sessions.readOnly) for the separate
// read-only page. Deliberately simple (no debounce/coalesce): it is only
// triggered while that page is open, not on the hot dashboard path.
export async function fetchReadOnlySessions(): Promise<void> {
	readOnlySessionFolders.update((s) => ({...s, loading: true}));
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/sessions?view=readonly${token ? `&token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		readOnlySessionFolders.set({
			folders: data.folders || [],
			activeSessions: (data.activeSessions || []).map(
				(s: any) => s.sessionFile,
			),
			currentSession: get(readOnlySessionFolders).currentSession,
			loading: false,
		});
	} catch (err) {
		readOnlySessionFolders.update((s) => ({...s, loading: false}));
		console.error('Failed to fetch read-only sessions:', err);
	}
}

// ---------------------------------------------------------------------------
// Conversation search (GET /search), backed by the memonaut index server-side.
// ---------------------------------------------------------------------------

// One session file carrying a match. `sessionPath` is normalized by the SERVER
// with the same rule as SessionInfo.path, so it can be handed straight to
// switchSession() and matches the fork tree's nodes.
export interface SearchThreadResult {
	sessionPath: string;
	name: string | null;
	cwd: string;
	folderName: string;
	project: string | null;
	lastActivity: string | null;
	entryCount: number;
	seq: number;
	/** Entries this thread accumulated after the match: what tells forks apart. */
	after: number;
	isRoot: boolean;
	readOnly: boolean;
	/** Closed session (ADR 0025); only returned when the search included closed ones. */
	closed: boolean;
}

export interface SearchHitResult {
	entryKey: string;
	role: string;
	kind: string;
	tool: string | null;
	ts: string | null;
	/** FTS5 snippet with \u0001/\u0002 match markers (see core/search-snippet.ts). */
	snippet: string;
	score: number;
	/** EVERY visible thread carrying this entry, most recently active first. */
	threads: SearchThreadResult[];
	threadTotal: number;
	otherHits: number;
}

export interface SearchResponse {
	status: 'ok' | 'not-indexed' | 'unavailable' | 'error';
	query: string;
	usedQuery?: string;
	quotedFallback?: boolean;
	hits: SearchHitResult[];
	scanned?: number;
	hiddenHits?: number;
	index?: {path: string; files: number; entries: number; newest: string | null};
	message?: string;
}

// The latest query wins: a superseded request is aborted rather than raced, so
// a slow earlier response can never paint over a newer one.
let searchAbort: AbortController | null = null;

/**
 * Run one conversation search. Never throws: a transport failure comes back as
 * status:'error' so the panel can explain itself, and an aborted (superseded)
 * request resolves to null so the caller simply keeps what it has.
 */
export async function searchConversations(
	query: string,
	view: 'default' | 'readonly' = 'default',
	opts: {includeClosed?: boolean; since?: string; sort?: SearchSort} = {},
): Promise<SearchResponse | null> {
	searchAbort?.abort();
	const controller = new AbortController();
	searchAbort = controller;
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const params = searchRequestParams({
			query,
			view,
			includeClosed: opts.includeClosed,
			since: opts.since,
			sort: opts.sort,
			token,
		});
		const res = await fetch(`${baseUrl}/search?${params.toString()}`, {
			signal: controller.signal,
		});
		if (!res.ok) {
			return {
				status: 'error',
				query,
				hits: [],
				message:
					res.status === 401
						? 'Unauthorized: check the token in Connection Settings.'
						: `Search failed (HTTP ${res.status}).`,
			};
		}
		return (await res.json()) as SearchResponse;
	} catch (err) {
		if ((err as Error)?.name === 'AbortError') return null;
		return {
			status: 'error',
			query,
			hits: [],
			message: (err as Error)?.message || 'Search request failed.',
		};
	} finally {
		if (searchAbort === controller) searchAbort = null;
	}
}

export async function fetchModels(): Promise<void> {
	availableModels.update((s) => ({...s, loading: true}));
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/models${token ? `?token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		availableModels.set({
			models: data.models || [],
			loading: false,
		});
	} catch (err) {
		availableModels.update((s) => ({...s, loading: false}));
		console.error('Failed to fetch models:', err);
	}
}

export function getToken(): string {
	try {
		const config = localStorage.getItem('wherever-config');
		if (config) {
			const parsed = JSON.parse(config);
			return parsed.token || '';
		}
	} catch {}
	return '';
}

/**
 * A pending request to open the main list's new-session form (the filter
 * row's + in `SessionBrowser.svelte`, spec `sidebar-compact-layout` story 23)
 * from outside it, e.g. the desktop rail's +. A flag rather than a call into
 * the component: the rail expands the sidebar first, so the browser may only
 * be mounting when the request is made. The main-list `SessionBrowser` reads
 * it whenever it is mounted (on mount included), opens the form and clears it.
 */
export const newSessionFormRequested = writable<boolean>(false);

/** Open the main list's new-session form (now, or as soon as it is shown). */
export function openNewSessionForm(): void {
	newSessionFormRequested.set(true);
}

export const gitInitDefaultStore = writable<boolean>(false);
export const uploadMethodStore = writable<'websocket' | 'post'>('websocket');
export const searchFolderStore = writable<string | null>(null);
export const searchCreateRemoteStore = writable<boolean>(false);
// Default model (as "provider:modelId") for the configured search folder,
// resolved server-side against that folder's settings. null when unset.
export const searchDefaultModelStore = writable<string | null>(null);

/**
 * The assistant status from `/config` (`assistant`), a start-time snapshot of the
 * server (see server/src/assistant-folder.ts). `active` = configured AND this
 * server holds the folder lock. Later assistant tasks add fields.
 */
export type AssistantLockState =
	| {state: 'held'}
	| {
			state: 'refused';
			reason: 'live-lock' | 'foreign-host';
			holder: {pid: number; host: string};
			message: string;
	  }
	| {state: 'error'; message: string};
export interface AssistantStatus {
	configured: boolean;
	folder: string | null;
	active: boolean;
	lock: AssistantLockState | null;
	/**
	 * The CURRENT assistant session (server/src/assistant-controller.ts), only
	 * while `active`: null until one exists, absent when the assistant is off. Live:
	 * `assistant_status` frames move it (see applyAssistantPointer).
	 */
	currentSessionId?: string | null;
	currentSessionFile?: string | null;
	/**
	 * The user's CURRENT timezone (what a scheduled job without its own `tz`
	 * follows), only while `active`. Live: an `assistant_status` frame carrying
	 * `timezone` moves it (the web's own report on connect, or the assistant's
	 * `assistant_set_timezone`).
	 */
	timezone?: string | null;
	/**
	 * The assistant's Web Push channel (server/src/web-push.ts), only while
	 * `active`: whether it runs on the server, the VAPID public key once
	 * generated, and how many devices are subscribed. Whether THIS device is comes
	 * from `isThisDeviceSubscribed` (core/push-subscription.ts).
	 */
	webPush?: {
		enabled: boolean;
		publicKey: string | null;
		subscriptions: number;
	};
	/**
	 * The assistant's Telegram channel (server/src/telegram-channel.ts), only
	 * while `active`: whether `assistantTelegram.enabled` is set, and its state
	 * (disabled with an error, unpaired + the one-time code, paired + the user).
	 * See core/telegram-settings.ts.
	 */
	telegram?: TelegramStatus;
}
export const assistantNotConfigured: AssistantStatus = {
	configured: false,
	folder: null,
	active: false,
	lock: null,
};
export const assistantStatusStore = writable<AssistantStatus>(
	assistantNotConfigured,
);

/**
 * Apply a live `assistant_status` frame (the pointer moved, or the user's
 * timezone changed). Ignored while not active. A frame without `timezone` (an
 * older server) keeps the known one.
 */
export function applyAssistantPointer(pointer: {
	currentSessionId: string | null;
	currentSessionFile: string | null;
	timezone?: string | null;
}): void {
	assistantStatusStore.update((s) =>
		s.active
			? {
					...s,
					currentSessionId: pointer.currentSessionId,
					currentSessionFile: pointer.currentSessionFile,
					...(pointer.timezone !== undefined
						? {timezone: pointer.timezone}
						: {}),
				}
			: s,
	);
}

/** True when `sessionFile` is the current assistant session (drives the Reset action). */
export function isAssistantSession(
	status: AssistantStatus,
	sessionFile: string | null | undefined,
): boolean {
	return (
		status.active &&
		!!sessionFile &&
		!!status.currentSessionFile &&
		status.currentSessionFile === sessionFile
	);
}

/** Visual identity of the connected server instance (label + theme overrides). */
export const appearanceStore = writable<AppearanceInfo>(defaultAppearance);

export interface PathCheckResult {
	exists: boolean;
	isGit: boolean;
	resolvedPath: string;
}

export async function checkPath(
	pathStr: string,
): Promise<PathCheckResult | null> {
	if (!pathStr.trim()) return null;
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/check-path?path=${encodeURIComponent(pathStr)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as PathCheckResult;
	} catch (err) {
		console.error('Failed to check path:', err);
		return null;
	}
}

export interface RemoteRepoCheckResult {
	matched: boolean;
	provider?: string;
	exists: boolean;
	sshUrl?: string;
}

/**
 * Submit-time probe: ask the server whether the remote repo that would be
 * created for `pathStr` already exists. Runs a provider CLI on the server, so
 * this is called ON DEMAND at create time, never on every keystroke.
 */
export async function checkRemoteRepo(
	pathStr: string,
): Promise<RemoteRepoCheckResult | null> {
	if (!pathStr.trim()) return null;
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/check-remote-repo?path=${encodeURIComponent(pathStr)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as RemoteRepoCheckResult;
	} catch (err) {
		console.error('Failed to check remote repo:', err);
		return null;
	}
}

export interface RemoteCandidate {
	/** An scp-style SSH URL (`git@host:owner/repo.git`). Never HTTPS. */
	url: string;
	source: 'probe' | 'path-convention';
}

export interface RemoteCandidatesResult {
	resolvedPath: string;
	candidates: RemoteCandidate[];
}

/**
 * Which repository does this (missing) folder probably correspond to?
 *
 * Answers an ORDERED, ADVISORY list of SSH candidates -- the provider probe
 * first, then the `<host-token>/<owner>/<repo>` path convention -- used to
 * PRE-FILL the restore panel's editable url field so a repository can be
 * restored from a phone without typing one. Advisory only: the server clones
 * what it is finally given, not what it guessed, and an empty list is an honest
 * answer the user pastes over.
 *
 * The probe shells out to a provider CLI, so this is called ON DEMAND (the panel
 * opening), never per keystroke.
 */
export async function fetchRemoteCandidates(
	pathStr: string,
): Promise<RemoteCandidate[]> {
	if (!pathStr.trim()) return [];
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/remote-candidates?path=${encodeURIComponent(pathStr)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as RemoteCandidatesResult;
		return Array.isArray(data.candidates) ? data.candidates : [];
	} catch (err) {
		// A candidate is a convenience, never a gate: an unreachable endpoint leaves
		// the field empty and the user pastes a url.
		console.error('Failed to resolve remote candidates:', err);
		return [];
	}
}

export interface PathAutocompleteResult {
	completions: string[];
}

export async function autocompletePath(pathStr: string): Promise<string[]> {
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/autocomplete-path?path=${encodeURIComponent(pathStr)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as PathAutocompleteResult;
		return data.completions || [];
	} catch (err) {
		console.error('Failed to autocomplete path:', err);
		return [];
	}
}

export async function fetchConfig(): Promise<void> {
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const url = `${baseUrl}/config${token ? `?token=${encodeURIComponent(token)}` : ''}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		gitInitDefaultStore.set(!!data.gitInitDefault);
		uploadMethodStore.set(data.uploadMethod || 'websocket');
		searchFolderStore.set(data.searchFolder || null);
		searchCreateRemoteStore.set(!!data.searchCreateRemote);
		searchDefaultModelStore.set(data.searchDefaultModel || null);
		assistantStatusStore.set(
			data.assistant && typeof data.assistant === 'object'
				? data.assistant
				: assistantNotConfigured,
		);
		const appearance: AppearanceInfo = {
			label: data.appearance?.label || '',
			accent: data.appearance?.accent || null,
			colors: data.appearance?.colors || null,
			frame: !!data.appearance?.frame,
			pattern: data.appearance?.pattern || 'none',
		};
		// Publishing the appearance is all this module does with it: painting it
		// onto the document belongs to the UI (+layout.svelte), which re-themes
		// whenever this store changes. Keeping the DOM write out of here means the
		// transport layer stays testable without a document.
		appearanceStore.set(appearance);
	} catch (err) {
		console.error('Failed to fetch config:', err);
	}
}

/**
 * Apply a `session_working` frame: flip one row's isWorking in place. A no-op
 * (no store write) when the row is absent or already in that state, so the
 * frequent frames never cause a needless re-render or a /sessions refetch.
 */
export function setSessionWorking(sessionFile: string, working: boolean): void {
	// Both lists are built by the same server listing, so patch both (like
	// setSessionStarred): the read-only page never refetches on its own.
	patchWorking(sessionFolders, sessionFile, working);
	patchWorking(readOnlySessionFolders, sessionFile, working);
}

function patchWorking(
	store: typeof sessionFolders,
	sessionFile: string,
	working: boolean,
): void {
	const cur = get(store);
	const hit = cur.folders.some((f) =>
		f.sessions.some((x) => x.path === sessionFile && !!x.isWorking !== working),
	);
	if (!hit) return;
	store.set({
		...cur,
		folders: cur.folders.map((f) =>
			f.sessions.some((x) => x.path === sessionFile)
				? {
						...f,
						sessions: f.sessions.map((x) =>
							x.path === sessionFile ? {...x, isWorking: working} : x,
						),
					}
				: f,
		),
	});
}

export function setCurrentSession(sessionId: string | null): void {
	sessionFolders.update((s) => ({...s, currentSession: sessionId}));
}

/**
 * shipmates' attention inbox and the live sessions' presence (wherever ADR
 * 0023), as the server pushes them (`shipmates_update`, on connect and on every
 * change). `available` false (an older server, no shipmates database, or
 * `shipmates.enabled: false`) hides the inbox entirely.
 */
export const shipmatesStore = writable<ShipmatesState>(emptyShipmatesState);

/** Parse and store a received frame; returns the parsed state. */
export function applyShipmatesUpdate(frame: unknown): ShipmatesState {
	const parsed = parseShipmatesUpdate(frame);
	shipmatesStore.set(parsed);
	return parsed;
}
