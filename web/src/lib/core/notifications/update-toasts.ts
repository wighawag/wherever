/**
 * The foreground update toasts and the updates list (spec
 * `notifications-compact`, stories 12 to 17). Pure but for its timer and the
 * injected storage, so every rule is unit-tested with fake time; the views are
 * `UpdateToast.svelte` (the toast above the composer) and the updates part of
 * the slim bar with its list (`NotificationToasts.svelte`).
 *
 * An UPDATE is any push posted to the visible page that is not a question
 * (`data.kind: 'update'`, or no kind from an older server): `assistant_notify`,
 * a lane finished, a test notification.
 *
 * - One toast at a time, the rest queued ("+N more"). A toast hides after
 *   `UPDATE_TOAST_MS` unless held (touched, hovered); releasing restarts the
 *   full delay. Hiding FOLDS it into the list, which the bar counts.
 * - Tapping the toast, or Open in the list, opens its target (`openTarget`,
 *   the page's `openNotificationTarget`) and removes it. ✕ on the toast, or
 *   Dismiss in the list, removes it. Clear all empties the list (the toast on
 *   screen and the queue stay).
 * - Every update not yet opened or dismissed (on screen, queued or listed) is
 *   kept on this device in localStorage (`UPDATE_LIST_KEY`, newest first,
 *   capped at `UPDATE_LIST_CAP`, the oldest dropped first). A reload brings
 *   them all back in the list, folded: nothing is toasted twice.
 * - Only pushes that reach the visible page land here: a push in the
 *   background stays a system notification.
 *
 * Decisions taken here are recorded in
 * work/notes/observations/update-toasts-and-list-decisions.md.
 */
import {writable, type Readable} from 'svelte/store';

/** How long an update toast shows before folding into the list. */
export const UPDATE_TOAST_MS = 6000;
/** The most updates kept on this device; the oldest goes first. */
export const UPDATE_LIST_CAP = 50;
/** The localStorage key holding the kept updates (a JSON array, newest first). */
export const UPDATE_LIST_KEY = 'wherever-updates';

export interface Update {
	/** The push's tag (`update-<uuid>`), else made up on arrival. */
	id: string;
	title: string;
	body: string;
	/** The push's `navigate` (`/#<sessionId>`; `/#` is the main screen). */
	navigate: string;
	/** When it reached this page (ms). */
	at: number;
}

export interface UpdateToastsView {
	toast: Update | null;
	/** Updates queued behind the toast ("+N more"). */
	more: number;
	/** The folded updates the bar counts, newest first. */
	list: Update[];
}

export type UpdateHoldReason = 'touch' | 'hover';

type ListStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let made = 0;

/**
 * A notification the service worker posted (`{title, options}`), read as an
 * update. The tag is its id (so a re-push of the same one is ignored); an
 * older server sent none, so one is made up.
 */
export function readUpdatePush(n: unknown, now: number = Date.now()): Update {
	const x = n as
		| {
				title?: unknown;
				options?: {body?: unknown; tag?: unknown; data?: unknown};
		  }
		| null
		| undefined;
	const data = x?.options?.data as {navigate?: unknown} | null | undefined;
	const tag = x?.options?.tag;
	return {
		id:
			typeof tag === 'string' && tag
				? tag
				: `update-${now}-${(++made).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		title: typeof x?.title === 'string' ? x.title : 'Notification',
		body: typeof x?.options?.body === 'string' ? x.options.body : '',
		navigate: typeof data?.navigate === 'string' ? data.navigate : '',
		at: now,
	};
}

/** "now", "5 min", "3 h", "2 d": an update's age in the list. */
export function updateAge(at: number, now: number = Date.now()): string {
	const mins = Math.floor((now - at) / 60000);
	if (mins < 1) return 'now';
	if (mins < 60) return `${mins} min`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours} h`;
	return `${Math.floor(hours / 24)} d`;
}

/**
 * An update's title as the toast shows it: the server writes
 * "<source>: <title>", shown as the source in bold and the rest muted
 * ("drive-sidebar-tasks finished" in the mockup). No source: all of it.
 */
export function splitUpdateTitle(title: string): {
	source: string;
	text: string;
} {
	const i = title.indexOf(': ');
	if (i <= 0) return {source: '', text: title};
	return {source: title.slice(0, i), text: title.slice(i + 2)};
}

function isUpdate(v: unknown): v is Update {
	const u = v as Partial<Update> | null;
	return (
		!!u &&
		typeof u.id === 'string' &&
		typeof u.title === 'string' &&
		typeof u.body === 'string' &&
		typeof u.navigate === 'string' &&
		typeof u.at === 'number'
	);
}

function readList(storage: ListStorage | undefined): Update[] {
	try {
		const raw = storage?.getItem(UPDATE_LIST_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(isUpdate)
			.map(({id, title, body, navigate, at}) => ({
				id,
				title,
				body,
				navigate,
				at,
			}))
			.sort((a, b) => b.at - a.at)
			.slice(0, UPDATE_LIST_CAP);
	} catch {
		return [];
	}
}

function writeList(storage: ListStorage | undefined, list: Update[]): void {
	try {
		if (list.length) storage?.setItem(UPDATE_LIST_KEY, JSON.stringify(list));
		else storage?.removeItem(UPDATE_LIST_KEY);
	} catch {
		// Storage unavailable: the updates just are not kept across reloads.
	}
}

export type UpdateToasts = Readable<UpdateToastsView> & {
	push(u: Update): void;
	hold(reason: UpdateHoldReason): void;
	release(reason: UpdateHoldReason): void;
	/** Tap on the toast, or Open in the list: open its target, remove it. */
	open(id: string): void;
	/** ✕ on the toast, or Dismiss in the list: remove it. */
	dismiss(id: string): void;
	/** Clear all: empty the list (not the toast on screen nor the queue). */
	clearAll(): void;
};

export function createUpdateToasts(opts: {
	storage?: ListStorage;
	openTarget: (navigate: string) => void;
}): UpdateToasts {
	const {storage, openTarget} = opts;
	// Every live update (on screen, queued, listed), newest first.
	let entries: Update[] = readList(storage);
	let current: string | null = null;
	let queue: string[] = [];
	const holds = new Set<UpdateHoldReason>();
	let hideTimer: ReturnType<typeof setTimeout> | null = null;

	const store = writable<UpdateToastsView>(view());

	function view(): UpdateToastsView {
		return {
			toast: entries.find((e) => e.id === current) ?? null,
			more: queue.length,
			list: entries.filter((e) => e.id !== current && !queue.includes(e.id)),
		};
	}
	function emit() {
		store.set(view());
	}
	function save() {
		writeList(storage, entries);
	}

	function schedule() {
		if (hideTimer) clearTimeout(hideTimer);
		hideTimer = null;
		if (current && holds.size === 0) {
			hideTimer = setTimeout(() => {
				hideTimer = null;
				showNext(); // the shown one stays in `entries`: folded
				emit();
			}, UPDATE_TOAST_MS);
		}
	}

	function showNext() {
		current = queue.shift() ?? null;
		holds.clear();
		schedule();
	}

	function remove(id: string): Update | null {
		const found = entries.find((e) => e.id === id);
		if (!found) return null;
		entries = entries.filter((e) => e.id !== id);
		queue = queue.filter((q) => q !== id);
		if (current === id) showNext();
		save();
		return found;
	}

	function push(u: Update) {
		if (entries.some((e) => e.id === u.id)) return;
		const at = entries.findIndex((e) => e.at <= u.at);
		entries =
			at < 0
				? [...entries, u]
				: [...entries.slice(0, at), u, ...entries.slice(at)];
		queue.push(u.id);
		// Over the cap: drop the oldest that is not on screen.
		while (entries.length > UPDATE_LIST_CAP) {
			const oldest = [...entries].reverse().find((e) => e.id !== current);
			if (!oldest) break;
			entries = entries.filter((e) => e.id !== oldest.id);
			queue = queue.filter((q) => q !== oldest.id);
		}
		if (!current) showNext();
		save();
		emit();
	}

	function hold(reason: UpdateHoldReason) {
		if (!current || holds.has(reason)) return;
		holds.add(reason);
		schedule();
	}
	function release(reason: UpdateHoldReason) {
		if (!holds.delete(reason)) return;
		schedule();
	}

	function open(id: string) {
		const u = remove(id);
		if (!u) return;
		emit();
		if (u.navigate) openTarget(u.navigate);
	}

	function dismiss(id: string) {
		if (remove(id)) emit();
	}

	function clearAll() {
		const listed = new Set(view().list.map((e) => e.id));
		if (!listed.size) return;
		entries = entries.filter((e) => !listed.has(e.id));
		save();
		emit();
	}

	return {
		subscribe: store.subscribe,
		push,
		hold,
		release,
		open,
		dismiss,
		clearAll,
	};
}
