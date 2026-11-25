import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {
	answeredNotifications,
	CLOSE_GRACE_MS,
	createAnsweredNotificationCloser,
	SWEEP_SETTLE_MS,
	type ShownNotification,
} from './answered-notifications';
import {
	emptyShipmatesState,
	type ShipmatesInboxItem,
	type ShipmatesState,
} from '../shipmates';

// Closing a question's system notification once it is answered anywhere (spec
// `notifications-compact` story 21, resolved decision 1): a pure selection of
// the stale `shipmates-<itemId>` notifications, and a closer that only acts on
// snapshots RECEIVED after the page loaded or came back.

function item(id: string): ShipmatesInboxItem {
	return {
		id,
		question: `question ${id}?`,
		options: null,
		blocking: false,
		createdAt: 0,
		sessionFile: `/s/${id}.jsonl`,
		sessionId: `sess-${id}`,
		from: `asker-${id}`,
		onBehalfOf: 0,
	};
}

function snap(
	ids: string[],
	extra: Partial<ShipmatesState> = {},
): ShipmatesState {
	return {
		available: true,
		inbox: ids.map(item),
		presence: [],
		archives: [],
		...extra,
	};
}

type Fake = ShownNotification & {closed: boolean};

function shown(
	tag: string,
	opts: {timestamp?: number; sentAt?: number; data?: unknown} = {},
): Fake {
	const n: Fake = {
		tag,
		timestamp: opts.timestamp,
		data:
			'data' in opts
				? opts.data
				: opts.sentAt !== undefined
					? {kind: 'question', itemId: tag.slice(10), sentAt: opts.sentAt}
					: {kind: 'question'},
		closed: false,
		close() {
			n.closed = true;
		},
	};
	return n;
}

const T = 1_000_000;
const old = T - CLOSE_GRACE_MS - 1;

describe('answeredNotifications', () => {
	it('closes the notification of an item no longer in the inbox', () => {
		const n = shown('shipmates-a', {timestamp: old});
		expect(
			answeredNotifications([n], {state: snap([]), receivedAt: T}),
		).toEqual([n]);
	});

	it('keeps the notification of an item still open', () => {
		const n = shown('shipmates-a', {timestamp: old});
		expect(
			answeredNotifications([n], {state: snap(['a']), receivedAt: T}),
		).toEqual([]);
	});

	it('closes nothing on an inboxError snapshot', () => {
		const n = shown('shipmates-a', {timestamp: old});
		expect(
			answeredNotifications([n], {
				state: snap([], {inboxError: true}),
				receivedAt: T,
			}),
		).toEqual([]);
	});

	it('closes nothing before the first real snapshot', () => {
		const n = shown('shipmates-a', {timestamp: old});
		expect(answeredNotifications([n], null)).toEqual([]);
		// The store's initial state (and an older server): shipmates unavailable.
		expect(
			answeredNotifications([n], {state: emptyShipmatesState, receivedAt: T}),
		).toEqual([]);
	});

	it('keeps a notification with neither timestamp nor sentAt', () => {
		const n = shown('shipmates-a');
		expect(
			answeredNotifications([n], {state: snap([]), receivedAt: T}),
		).toEqual([]);
	});

	it('falls back to data.sentAt when the browser gives no timestamp', () => {
		const n = shown('shipmates-a', {sentAt: old});
		expect(
			answeredNotifications([n], {state: snap([]), receivedAt: T}),
		).toEqual([n]);
	});

	it('keeps a notification newer than the snapshot minus the grace', () => {
		const recent = shown('shipmates-a', {timestamp: T - CLOSE_GRACE_MS + 1});
		const later = shown('shipmates-b', {sentAt: T + 10});
		expect(
			answeredNotifications([recent, later], {
				state: snap([]),
				receivedAt: T,
			}),
		).toEqual([]);
	});

	it('ignores notifications whose tag is not a shipmates question', () => {
		const update = shown('update-123', {timestamp: old});
		const untagged = shown('', {timestamp: old});
		const bare = shown('shipmates-', {timestamp: old});
		expect(
			answeredNotifications([update, untagged, bare], {
				state: snap([]),
				receivedAt: T,
			}),
		).toEqual([]);
	});
});

describe('createAnsweredNotificationCloser', () => {
	let now: number;
	beforeEach(() => {
		vi.useFakeTimers();
		now = T;
	});
	afterEach(() => vi.useRealTimers());

	function make(list: Fake[]) {
		const calls = {list: 0};
		const closer = createAnsweredNotificationCloser({
			list: async () => {
				calls.list++;
				return list;
			},
			now: () => now,
		});
		return {closer, calls};
	}

	async function settle() {
		vi.advanceTimersByTime(SWEEP_SETTLE_MS);
		await vi.runAllTimersAsync();
	}

	it('closes an answered notification after a received snapshot settles', async () => {
		const a = shown('shipmates-a', {timestamp: old});
		const b = shown('shipmates-b', {timestamp: old});
		const {closer} = make([a, b]);
		closer.received(snap(['b']));
		expect(a.closed).toBe(false);
		await settle();
		expect(a.closed).toBe(true);
		expect(b.closed).toBe(false);
	});

	it('does nothing until a snapshot is received', async () => {
		const a = shown('shipmates-a', {timestamp: old});
		const {closer, calls} = make([a]);
		closer.noteReturn();
		await settle();
		expect(calls.list).toBe(0);
		expect(a.closed).toBe(false);
	});

	it('acts on the latest of a burst (frames queued during a freeze)', async () => {
		const a = shown('shipmates-a', {timestamp: old});
		const {closer, calls} = make([a]);
		closer.received(snap([]));
		closer.received(snap(['a']));
		await settle();
		expect(calls.list).toBe(1);
		expect(a.closed).toBe(false);
	});

	it('drops a snapshot received before the page came back', async () => {
		const a = shown('shipmates-a', {timestamp: old});
		const {closer, calls} = make([a]);
		closer.received(snap([]));
		closer.noteReturn();
		await settle();
		expect(calls.list).toBe(0);
		expect(a.closed).toBe(false);
		// The next one received after the return acts.
		closer.received(snap([]));
		await settle();
		expect(a.closed).toBe(true);
	});

	it('times the guard by when the snapshot was received', async () => {
		const a = shown('shipmates-a', {timestamp: T - 100});
		const {closer} = make([a]);
		closer.received(snap([]));
		now = T + CLOSE_GRACE_MS * 10;
		await settle();
		expect(a.closed).toBe(false);
	});

	it('tolerates a failing notification list', async () => {
		const closer = createAnsweredNotificationCloser({
			list: async () => {
				throw new Error('no service worker');
			},
			now: () => now,
		});
		closer.received(snap([]));
		await expect(settle()).resolves.toBeUndefined();
	});
});
