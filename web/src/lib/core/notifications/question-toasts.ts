/**
 * The foreground question toasts and the slim bar (spec `notifications-compact`,
 * stories 1 to 11, resolved decision 2). Pure but for its timers and the
 * injected storage, so every rule is unit-tested with fake time; the view is
 * `QuestionToasts.svelte`.
 *
 * A push the service worker posts to the visible page with
 * `data: {kind: 'question', itemId}` (server `webPushPayload`) is a question.
 * The toast is built from the shipmates inbox item, not from the push text:
 *
 * - The item is looked up in the latest shipmates snapshot. If absent, the
 *   model waits up to `QUESTION_WAIT_MS` for a snapshot carrying it (the push
 *   is sent before the server's throttled flush). A good snapshot RECEIVED
 *   after the push that lacks it drops it (answered already); with no good
 *   snapshot in time (socket down, stale) a FALLBACK toast shows the push's own
 *   title and body, so a question is never shown nowhere.
 * - One toast at a time, the rest queued ("+N more"). A toast hides after
 *   `QUESTION_TOAST_MS` unless held (touched, hovered), sending an answer or
 *   showing an error; releasing restarts the full delay. Hiding FOLDS it into
 *   the bar.
 * - Suppression: no toast while the Needs you panel is open (and no bar entry:
 *   the user is looking at it); a question from the session on screen skips the
 *   toast but enters the bar (its tool call in the chat has no answer controls).
 * - ✕ / swipe up removes it from the toast AND the bar (it stays in Needs you).
 * - It leaves the toast, the queue and the bar once a good snapshot (available,
 *   no `inboxError`) no longer lists it: answered anywhere.
 * - The bar's ids persist on this device (localStorage, ids only) and are
 *   pruned against each good snapshot.
 *
 * Decisions taken here are recorded in
 * work/notes/observations/question-toasts-and-bar-decisions.md.
 */
import {writable, type Readable} from 'svelte/store';
import type {ShipmatesInboxItem, ShipmatesState} from '../shipmates';

/** How long a question toast shows before folding into the bar. */
export const QUESTION_TOAST_MS = 8000;
/** How long a question push waits for a snapshot carrying its item. */
export const QUESTION_WAIT_MS = 5000;
/** The localStorage key holding the bar's question ids (a JSON array). */
export const QUESTION_BAR_KEY = 'wherever-question-bar';

/** What the page knows of a question push before its item is found. */
export interface QuestionPush {
	itemId: string;
	title: string;
	body: string;
	navigate: string;
}

/** The push's own text, shown when the item could not be read in time. */
export interface QuestionFallback {
	title: string;
	body: string;
	navigate: string;
}

export interface QuestionToast {
	id: string;
	/** The inbox item; null for a fallback toast. */
	item: ShipmatesInboxItem | null;
	fallback: QuestionFallback | null;
	/** The asking session, when known (the item's, else the push target's). */
	sessionId: string | null;
	sending: boolean;
	error: string | null;
}

export interface QuestionToastsView {
	toast: QuestionToast | null;
	/** Questions queued behind the toast ("+N more"). */
	more: number;
	/** The bar's question ids, oldest first. */
	bar: string[];
}

export interface QuestionContext {
	/** The Needs you panel is on screen (its view AND a visible sidebar). */
	needsYouOpen: boolean;
	/** The session on screen. */
	openSessionId: string | null;
}

export type HoldReason = 'touch' | 'hover';

type BarStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface Entry {
	id: string;
	item: ShipmatesInboxItem | null;
	fallback: QuestionFallback | null;
	sessionId: string | null;
}

/** The session a `/#<sessionId>` push target opens, else null. */
export function sessionIdFromNavigate(navigate: string): string | null {
	const i = navigate.indexOf('#');
	if (i < 0 || i === navigate.length - 1) return null;
	try {
		return decodeURIComponent(navigate.slice(i + 1));
	} catch {
		return null;
	}
}

/**
 * A notification the service worker posted (`{title, options}`), read as a
 * question push when its `data` says `kind: 'question'` with an item id; null
 * for anything else (an update).
 */
export function readQuestionPush(n: unknown): QuestionPush | null {
	const x = n as
		| {title?: unknown; options?: {body?: unknown; data?: unknown}}
		| null
		| undefined;
	const data = x?.options?.data as
		| {kind?: unknown; itemId?: unknown; navigate?: unknown}
		| null
		| undefined;
	if (!data || data.kind !== 'question' || typeof data.itemId !== 'string')
		return null;
	return {
		itemId: data.itemId,
		title: typeof x?.title === 'string' ? x.title : 'Question for you',
		body: typeof x?.options?.body === 'string' ? x.options.body : '',
		navigate: typeof data.navigate === 'string' ? data.navigate : '',
	};
}

function readBar(storage: BarStorage | undefined): string[] {
	try {
		const raw = storage?.getItem(QUESTION_BAR_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((v): v is string => typeof v === 'string')
			: [];
	} catch {
		return [];
	}
}

function writeBar(storage: BarStorage | undefined, bar: string[]): void {
	try {
		if (bar.length) storage?.setItem(QUESTION_BAR_KEY, JSON.stringify(bar));
		else storage?.removeItem(QUESTION_BAR_KEY);
	} catch {
		// Storage unavailable: the bar just is not kept across reloads.
	}
}

function fromItem(item: ShipmatesInboxItem): Entry {
	return {id: item.id, item, fallback: null, sessionId: item.sessionId};
}

function isGood(state: ShipmatesState): boolean {
	return state.available && !state.inboxError;
}

export type QuestionToasts = Readable<QuestionToastsView> & {
	push(p: QuestionPush): void;
	shipmates(state: ShipmatesState): void;
	setContext(c: QuestionContext): void;
	hold(reason: HoldReason): void;
	release(reason: HoldReason): void;
	answering(id: string): void;
	answered(id: string, r: {ok: true} | {ok: false; error: string}): void;
	/** ✕ or swipe up: off the toast and the bar (still in Needs you). */
	dismiss(id: string): void;
	/** Fold the shown toast into the bar now (Open ›, before navigating). */
	fold(id: string): void;
};

export function createQuestionToasts(
	opts: {storage?: BarStorage} = {},
): QuestionToasts {
	const storage = opts.storage;
	let latest: ShipmatesState | null = null;
	let ctx: QuestionContext = {needsYouOpen: false, openSessionId: null};
	const pending = new Map<
		string,
		{push: QuestionPush; timer: ReturnType<typeof setTimeout>}
	>();
	let current: Entry | null = null;
	let sending = false;
	let error: string | null = null;
	const holds = new Set<HoldReason>();
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let queue: Entry[] = [];
	let bar = readBar(storage);

	const store = writable<QuestionToastsView>(view());

	function view(): QuestionToastsView {
		return {
			toast: current && {
				id: current.id,
				item: current.item,
				fallback: current.fallback,
				sessionId: current.sessionId,
				sending,
				error,
			},
			more: queue.length,
			bar: [...bar],
		};
	}
	function emit() {
		store.set(view());
	}

	function setBar(next: string[]) {
		const changed =
			next.length !== bar.length || next.some((id, i) => id !== bar[i]);
		bar = next;
		if (changed) writeBar(storage, bar);
	}
	function addBar(id: string) {
		if (!bar.includes(id)) setBar([...bar, id]);
	}
	function removeBar(id: string) {
		if (bar.includes(id)) setBar(bar.filter((b) => b !== id));
	}

	function schedule() {
		if (hideTimer) clearTimeout(hideTimer);
		hideTimer = null;
		if (current && holds.size === 0 && !sending && !error) {
			const id = current.id;
			hideTimer = setTimeout(() => {
				hideTimer = null;
				fold(id);
			}, QUESTION_TOAST_MS);
		}
	}

	function showNext() {
		current = queue.shift() ?? null;
		sending = false;
		error = null;
		holds.clear();
		schedule();
	}

	function known(id: string): boolean {
		return (
			current?.id === id ||
			queue.some((e) => e.id === id) ||
			pending.has(id) ||
			bar.includes(id)
		);
	}

	function fromSessionOnScreen(e: Entry): boolean {
		return !!e.sessionId && e.sessionId === ctx.openSessionId;
	}

	function admit(e: Entry) {
		// A fallback ignores the Needs you rule: no good snapshot came, so the
		// panel may well not list it either.
		if (ctx.needsYouOpen && !e.fallback) return;
		if (fromSessionOnScreen(e)) {
			addBar(e.id);
			emit();
			return;
		}
		queue.push(e);
		if (!current) showNext();
		emit();
	}

	function push(p: QuestionPush) {
		if (known(p.itemId)) return;
		const found = latest?.inbox.find((i) => i.id === p.itemId);
		if (found) {
			admit(fromItem(found));
			return;
		}
		const timer = setTimeout(() => {
			pending.delete(p.itemId);
			admit({
				id: p.itemId,
				item: null,
				fallback: {title: p.title, body: p.body, navigate: p.navigate},
				sessionId: sessionIdFromNavigate(p.navigate),
			});
		}, QUESTION_WAIT_MS);
		pending.set(p.itemId, {push: p, timer});
	}

	function shipmates(state: ShipmatesState) {
		latest = state;
		if (!isGood(state)) return;
		const byId = new Map(state.inbox.map((i) => [i.id, i]));
		// Resolve the pushes waiting for this snapshot: found or dropped.
		const resolved: Entry[] = [];
		for (const [id, p] of [...pending]) {
			clearTimeout(p.timer);
			pending.delete(id);
			const found = byId.get(id);
			if (found) resolved.push(fromItem(found));
		}
		// Answered anywhere: off the toast, the queue and the bar. Still open:
		// refresh the item (a fallback becomes the real item).
		const refresh = (e: Entry): Entry | null => {
			const found = byId.get(e.id);
			return found ? fromItem(found) : null;
		};
		queue = queue.map(refresh).filter((e): e is Entry => !!e);
		setBar(bar.filter((id) => byId.has(id)));
		if (current) {
			const next = refresh(current);
			if (next) current = next;
			else showNext();
		}
		for (const e of resolved) admit(e);
		emit();
	}

	function setContext(c: QuestionContext) {
		ctx = c;
		let changed = false;
		// The shown toast first (it showed, so it counts in the bar), then the
		// queue, so the bar keeps arrival order.
		const foldCurrent =
			!!current && (ctx.needsYouOpen || fromSessionOnScreen(current));
		if (foldCurrent) addBar(current!.id);
		const kept: Entry[] = [];
		for (const e of queue) {
			if (ctx.needsYouOpen && !e.fallback) {
				changed = true; // suppressed: never shown, the user is looking
			} else if (fromSessionOnScreen(e)) {
				addBar(e.id);
				changed = true;
			} else kept.push(e);
		}
		queue = kept;
		if (foldCurrent) {
			showNext();
			changed = true;
		}
		if (changed) emit();
	}

	function hold(reason: HoldReason) {
		if (!current || holds.has(reason)) return;
		holds.add(reason);
		schedule();
	}
	function release(reason: HoldReason) {
		if (!holds.delete(reason)) return;
		schedule();
	}

	function answering(id: string) {
		if (current?.id !== id) return;
		sending = true;
		error = null;
		schedule();
		emit();
	}

	function answered(id: string, r: {ok: true} | {ok: false; error: string}) {
		if (current?.id === id) {
			if (r.ok) {
				removeBar(id);
				showNext();
			} else {
				sending = false;
				error = r.error;
				schedule();
			}
			emit();
			return;
		}
		if (r.ok) {
			queue = queue.filter((e) => e.id !== id);
			removeBar(id);
			emit();
		}
	}

	function dismiss(id: string) {
		if (current?.id !== id) return;
		removeBar(id);
		showNext();
		emit();
	}

	function fold(id: string) {
		if (current?.id !== id) return;
		addBar(id);
		showNext();
		emit();
	}

	return {
		subscribe: store.subscribe,
		push,
		shipmates,
		setContext,
		hold,
		release,
		answering,
		answered,
		dismiss,
		fold,
	};
}
