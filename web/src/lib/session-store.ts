import {writable, get} from 'svelte/store';

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
	clientCount: number;
	// Absolute path of the parent session this one was forked from, or undefined
	// for a root session. Used to build the fork-hierarchy tree in the browser.
	parentSessionPath?: string;
}

export interface FolderWithSessions {
	path: string;
	name: string;
	sessions: SessionInfo[];
	readOnly?: boolean;
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
): Promise<SearchResponse | null> {
	searchAbort?.abort();
	const controller = new AbortController();
	searchAbort = controller;
	try {
		const baseUrl = getBaseUrl();
		const token = getToken();
		const params = new URLSearchParams({q: query});
		if (view === 'readonly') params.set('view', 'readonly');
		if (token) params.set('token', token);
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

export const gitInitDefaultStore = writable<boolean>(false);
export const uploadMethodStore = writable<'websocket' | 'post'>('websocket');
export const searchFolderStore = writable<string | null>(null);
export const searchCreateRemoteStore = writable<boolean>(false);
// Default model (as "provider:modelId") for the configured search folder,
// resolved server-side against that folder's settings. null when unset.
export const searchDefaultModelStore = writable<string | null>(null);

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
	} catch (err) {
		console.error('Failed to fetch config:', err);
	}
}

export function setCurrentSession(sessionId: string | null): void {
	sessionFolders.update((s) => ({...s, currentSession: sessionId}));
}
