// Adopting an auth token handed to the browser in the page URL.
//
// A token-protected server authenticates BOTH the page request and the
// WebSocket upgrade (`/ws?token=...`). The dashboard only ever learned its
// token from the `wherever-config` localStorage entry, so a freshly opened
// `https://host/?token=SECRET` rendered the page (the server saw the query
// parameter) and then failed the upgrade, because the client had no token to
// put on the WebSocket URL. This module closes that gap: on boot the token is
// taken out of the page URL, merged into the stored config, and removed from
// the address bar. From then on every consumer -- page fetches, /sessions
// calls, the WebSocket -- reads it from the config as usual.
//
// THE HASH FRAGMENT IS THE DOCUMENTED FORM, AND THAT IS DELIBERATE: a fragment
// is never sent to the server. `https://host/#token=SECRET` keeps the secret
// out of HTTP access logs, out of the `Referer` header sent to any third party
// the user navigates to next, and out of the request logs of every reverse
// proxy and intermediary in between, none of which is true of `?token=SECRET`.
// Do NOT "simplify" this by folding the hash form back into the query
// parameter: the query form is retained only as a fallback for links that were
// already handed out, and both forms are scrubbed from the address bar the
// moment they are read.

// The single localStorage entry holding the dashboard's connection config.
// Read/written here directly (rather than through wherever.ts) so adoption can
// run before any config consumer without importing half the app.
const CONFIG_KEY = 'wherever-config';
const TOKEN_PARAM = 'token';

type TokenTake = {
	/** A `token` key was present, whether or not its value was usable. */
	present: boolean;
	/** The value verbatim, '' when there was no non-blank one. */
	value: string;
	/** The `?...` / `#...` remainder with the token key(s) removed, '' when empty. */
	rest: string;
};

// Parses one URL component with URLSearchParams, so `#token=X&foo=1` behaves
// sensibly and a percent-encoded token is decoded correctly.
//
// The key is matched CASE-INSENSITIVELY, which matters more here than it looks:
// the fragment is ALSO this app's session-id channel (`+page.svelte` feeds
// `location.hash` straight into switchSession). A near-miss capitalisation such
// as `#TOKEN=SECRET` that this function failed to recognise would not merely be
// ignored, it would be read as a session id, sent to the server, and echoed
// back into the DOM as `Session with ID "<secret>" not found`. Recognising the
// key in any case keeps the secret out of that path.
function takeToken(raw: string, prefix: '?' | '#'): TokenTake {
	const body = raw.startsWith(prefix) ? raw.slice(1) : raw;
	if (!body) return {present: false, value: '', rest: raw};
	const params = new URLSearchParams(body);
	const keys = [
		...new Set(
			[...params.keys()].filter((k) => k.toLowerCase() === TOKEN_PARAM),
		),
	];
	// When there is no token key the component is left BYTE-FOR-BYTE alone
	// rather than reserialised: a non key/value fragment (say `#/some/route`,
	// which is exactly what a session deep link looks like) would come back out
	// of URLSearchParams mangled into `%2Fsome%2Froute=`.
	if (keys.length === 0) return {present: false, value: '', rest: raw};
	// Stored VERBATIM, not trimmed: the server compares the token byte-for-byte
	// (`provided === token`), and this project deliberately supports a token with
	// surrounding whitespace (see "Supplying the token" in the README, where the
	// pre-existing sources are taken as-is). Trimming here would silently change
	// which string authenticates. The trim below decides only whether the value
	// is BLANK, which is a separate question.
	// All values are collected before anything is deleted, so a link that
	// repeats the key (`#token=&token=REAL`) still finds the usable one instead
	// of stopping at the blank first occurrence.
	const values = keys.flatMap((key) => params.getAll(key));
	const value = values.find((candidate) => candidate.trim()) ?? '';
	for (const key of keys) params.delete(key);
	const remaining = params.toString();
	return {present: true, value, rest: remaining ? `${prefix}${remaining}` : ''};
}

export type UrlTokenRead = {
	/** The usable token, or null when absent or blank. */
	token: string | null;
	/** A token key was present somewhere, so the address bar needs scrubbing. */
	present: boolean;
	/** The search component to keep. */
	search: string;
	/** The hash component to keep. */
	hash: string;
};

/**
 * Pure read of the token from a URL's search and hash components.
 *
 * The hash wins when it carries a value; the query is a fallback. A blank or
 * whitespace-only token yields `token: null` but still `present: true`, so the
 * caller scrubs it without storing it: writing '' would clear a token that is
 * already working, turning a malformed link into a logout.
 *
 * Note that `+` decodes to a space, as form encoding says it must, and as the
 * server already does for the query form. A token containing `+` has to be
 * percent-encoded in the link; the README says so.
 */
export function readUrlToken(search: string, hash: string): UrlTokenRead {
	const fromHash = takeToken(hash || '', '#');
	const fromSearch = takeToken(search || '', '?');
	const value = fromHash.value || fromSearch.value;
	return {
		token: value ? value : null,
		present: fromHash.present || fromSearch.present,
		search: fromSearch.rest,
		hash: fromHash.rest,
	};
}

/**
 * Removes the token from the address bar, leaving the rest of the URL alone.
 *
 * Idempotent and safe to call at any time: with no token in the URL it does
 * nothing. It is SEPARATE from adoption, and exported, because in a SvelteKit
 * app it MUST run a second time. This is measured behaviour, not a precaution:
 *
 * The dashboard boots in client-side-routing mode (the generated index.html
 * calls `kit.start(app, element)` with no hydrate payload), and SvelteKit's
 * `start()` reads `location.href` and then performs an initial `enter`
 * navigation with it. That navigation is what dynamically imports the route
 * modules, which is where adoption below runs, so the URL is scrubbed while the
 * navigation is still in flight. When the navigation then commits, SvelteKit
 * stamps the history entry with the href it captured BEFORE the import, and the
 * token reappears in the address bar. Instrumented in a real browser: the scrub
 * lands, and ~12ms later the router's own `history.replaceState` puts the token
 * back. Nothing in a jsdom-free unit test can see this, because the router is
 * not running there.
 *
 * Hence `+layout.svelte` calls this again from `afterNavigate`, which fires
 * after that commit. Native `history.replaceState` is used rather than the
 * `replaceState` from `$app/navigation` because this whole app already drives
 * the fragment natively (`window.location.hash = ...` in `+page.svelte` and
 * `SessionBrowser.svelte`): the app's session-id channel is the fragment, and
 * routing it through the shallow-routing API here would be the odd one out.
 *
 * Returns true when the address bar was actually changed.
 */
export function scrubTokenFromUrl(): boolean {
	if (typeof window === 'undefined' || !window.location) return false;

	const loc = window.location;
	const read = readUrlToken(loc.search || '', loc.hash || '');
	if (!read.present) return false;

	// replaceState, never pushState: a pushed entry would keep the secret alive
	// in the session history (and in the back button) after the URL is clean.
	try {
		const history = window.history;
		if (history && typeof history.replaceState === 'function') {
			const path = loc.pathname || '/';
			history.replaceState(
				history.state ?? null,
				'',
				`${path}${read.search}${read.hash}`,
			);
			return true;
		}
	} catch {
		// A failed scrub must not cost the user the token itself.
	}
	return false;
}

/**
 * Adopts a token from the current page URL: persist it into the stored config
 * (MERGED, never replacing the object, so host/port/hideThinking/beepDefault
 * and the rest survive) and strip it from the address bar.
 *
 * Returns true when a token was actually stored.
 */
export function adoptTokenFromUrl(): boolean {
	// SSR/prerender: no window, nothing to adopt.
	if (typeof window === 'undefined' || !window.location) return false;

	const loc = window.location;
	const read = readUrlToken(loc.search || '', loc.hash || '');
	if (!read.present) return false;

	// Scrub FIRST, and regardless of whether the value turned out to be usable.
	scrubTokenFromUrl();

	if (!read.token) return false;

	// A corrupt entry is parsed in ITS OWN try, so it degrades to "no stored
	// config" (which is how getConfig() already treats it) instead of aborting
	// the adoption and leaving the user with no token at all.
	let stored: Record<string, unknown> = {};
	try {
		const raw = localStorage.getItem(CONFIG_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				stored = parsed as Record<string, unknown>;
			}
		}
	} catch {
		stored = {};
	}

	try {
		// A non-empty token in the URL wins over a stored one -- following a link
		// is an explicit act by the user -- but it overwrites the token FIELD
		// only. Never log or render the value.
		localStorage.setItem(
			CONFIG_KEY,
			JSON.stringify({...stored, token: read.token}),
		);
		return true;
	} catch {
		return false;
	}
}

let adopted = false;

/**
 * Idempotent entry point. Called from every place that reads the config early
 * (getConfig() in wherever.ts, session-store's module scope) so adoption has
 * always happened before the first read, no matter which module the route
 * pulled in first. Repeat calls are free.
 */
export function adoptTokenFromUrlOnce(): boolean {
	if (adopted) return false;
	adopted = true;
	return adoptTokenFromUrl();
}
