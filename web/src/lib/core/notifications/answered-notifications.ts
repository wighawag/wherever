/**
 * Close a question's SYSTEM notification once it is answered anywhere (spec
 * `notifications-compact` story 21, resolved decision 1): closed by code from
 * any open wherever page on this device, with no extra "close" pushes. Instant
 * while a tab or the PWA is alive, otherwise at the next open.
 *
 * A question push is shown with tag `shipmates-<itemId>` (server
 * `webPushPayload`). On each shipmates snapshot RECEIVED from the server (never
 * the store's cached or initial state), the page lists the service worker's
 * notifications and closes those whose item is no longer in the inbox:
 *
 * - Only a good snapshot acts: `available` and no `inboxError` (a failed read
 *   lists nothing because nothing was read, not because all was answered).
 * - Time guard, for the race with a push that just arrived before the snapshot
 *   carrying its item: a notification is closed only when it was sent more
 *   than `CLOSE_GRACE_MS` before the snapshot was received. Its send time is
 *   `Notification.timestamp` (the device's show time), else `data.sentAt` (the
 *   server's clock; the grace absorbs a small skew). A notification with
 *   neither is kept.
 * - Freshness: the snapshot's time is when THIS page received it. Frames queued
 *   while the page was frozen are delivered in a burst on return (after the
 *   page's timers), so the closer acts only on the LATEST frame once frames
 *   settle for `SWEEP_SETTLE_MS`, and `noteReturn()` (load, visible, pageshow)
 *   drops any snapshot received before that moment.
 *
 * Decisions taken here are recorded in
 * work/notes/observations/close-answered-system-notifications-decisions.md.
 */
import type {ShipmatesState} from '../shipmates';

/** A notification younger than this, relative to the snapshot, is kept. */
export const CLOSE_GRACE_MS = 5000;
/** Frames are coalesced; the sweep runs on the latest once they stop for this long. */
export const SWEEP_SETTLE_MS = 1000;

const TAG_PREFIX = 'shipmates-';

/** The slice of a `Notification` this needs (faked in tests). */
export interface ShownNotification {
	tag: string;
	timestamp?: number;
	data?: unknown;
	close(): void;
}

/** A shipmates snapshot and when this page received it. */
export interface ReceivedSnapshot {
	state: ShipmatesState;
	receivedAt: number;
}

function sentAt(n: ShownNotification): number | null {
	if (typeof n.timestamp === 'number' && n.timestamp > 0) return n.timestamp;
	const d = n.data as {sentAt?: unknown} | null | undefined;
	if (d && typeof d.sentAt === 'number') return d.sentAt;
	return null;
}

/**
 * The shown question notifications whose item a good received snapshot no
 * longer lists, and that are older than the snapshot minus `graceMs`. Nothing
 * before the first real snapshot (`null`, or shipmates unavailable).
 */
export function answeredNotifications<N extends ShownNotification>(
	shown: N[],
	snapshot: ReceivedSnapshot | null,
	graceMs: number = CLOSE_GRACE_MS,
): N[] {
	if (!snapshot) return [];
	const {state, receivedAt} = snapshot;
	if (!state.available || state.inboxError) return [];
	const open = new Set(state.inbox.map((i) => i.id));
	return shown.filter((n) => {
		if (typeof n.tag !== 'string' || !n.tag.startsWith(TAG_PREFIX))
			return false;
		const itemId = n.tag.slice(TAG_PREFIX.length);
		if (!itemId || open.has(itemId)) return false;
		const at = sentAt(n);
		return at !== null && at < receivedAt - graceMs;
	});
}

export interface AnsweredNotificationCloser {
	/** A `shipmates_update` frame this page just received. */
	received(state: ShipmatesState): void;
	/** The page loaded or came back: forget snapshots received before now. */
	noteReturn(): void;
}

/**
 * Feeds `answeredNotifications` from received frames and closes the result.
 * `list` is the browser's `registration.getNotifications()`; a failure (no
 * service worker, no permission) closes nothing.
 */
export function createAnsweredNotificationCloser<
	N extends ShownNotification,
>(opts: {
	list: () => Promise<N[]>;
	now?: () => number;
	settleMs?: number;
}): AnsweredNotificationCloser {
	const now = opts.now ?? Date.now;
	const settleMs = opts.settleMs ?? SWEEP_SETTLE_MS;
	let latest: ReceivedSnapshot | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function sweep() {
		timer = null;
		const snapshot = latest;
		if (!snapshot) return;
		let shown: N[];
		try {
			shown = await opts.list();
		} catch {
			return;
		}
		// A return while listing makes this snapshot stale.
		if (latest !== snapshot) return;
		for (const n of answeredNotifications(shown, snapshot)) {
			try {
				n.close();
			} catch {
				// Already gone.
			}
		}
	}

	return {
		received(state) {
			latest = {state, receivedAt: now()};
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void sweep(), settleMs);
		},
		noteReturn() {
			latest = null;
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}

/**
 * This device's shown notifications, from the service worker registration.
 * Empty without a service worker, without the Notifications API, or without
 * permission.
 */
export async function browserNotifications(): Promise<Notification[]> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
		return [];
	if (
		typeof Notification === 'undefined' ||
		Notification.permission !== 'granted'
	)
		return [];
	const registration = await navigator.serviceWorker.getRegistration();
	if (!registration || typeof registration.getNotifications !== 'function')
		return [];
	return registration.getNotifications();
}
