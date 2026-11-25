import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'svelte/store';
import {
	createQuestionToasts,
	QUESTION_BAR_KEY,
	QUESTION_TOAST_MS,
	QUESTION_WAIT_MS,
	readQuestionPush,
	sessionIdFromNavigate,
	type QuestionPush,
} from './question-toasts';
import type {ShipmatesInboxItem, ShipmatesState} from '../shipmates';

// The foreground question toasts and the slim bar (spec `notifications-compact`,
// stories 1 to 11): a pure model driven by pushes, shipmates snapshots and the
// page's context, with fake time for the 8 s hide and the 5 s wait.

function item(id: string, extra: Partial<ShipmatesInboxItem> = {}) {
	return {
		id,
		question: `question ${id}?`,
		options: ['yes', 'no'],
		blocking: false,
		createdAt: 0,
		sessionFile: `/s/${id}.jsonl`,
		sessionId: `sess-${id}`,
		from: `asker-${id}`,
		onBehalfOf: 0,
		...extra,
	} satisfies ShipmatesInboxItem;
}

function snap(
	items: ShipmatesInboxItem[],
	extra: Partial<ShipmatesState> = {},
): ShipmatesState {
	return {available: true, inbox: items, presence: [], archives: [], ...extra};
}

function push(id: string, navigate = `/#sess-${id}`): QuestionPush {
	return {itemId: id, title: `asker-${id} asks`, body: `push ${id}`, navigate};
}

function memoryStorage(init: Record<string, string> = {}) {
	const data = new Map(Object.entries(init));
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
		removeItem: (k: string) => void data.delete(k),
		data,
	};
}

let storage: ReturnType<typeof memoryStorage>;
function make() {
	return createQuestionToasts({storage});
}

beforeEach(() => {
	vi.useFakeTimers();
	storage = memoryStorage();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('a question push', () => {
	it('shows the inbox item as the toast when it is already in the snapshot', () => {
		const m = make();
		m.shipmates(snap([item('a')]));
		m.push(push('a'));
		const v = get(m);
		expect(v.toast?.id).toBe('a');
		expect(v.toast?.item?.question).toBe('question a?');
		expect(v.toast?.fallback).toBeNull();
	});

	it('waits for a snapshot carrying it (the push comes before the flush)', () => {
		const m = make();
		m.shipmates(snap([]));
		m.push(push('a'));
		expect(get(m).toast).toBeNull();
		vi.advanceTimersByTime(2000);
		m.shipmates(snap([item('a')]));
		expect(get(m).toast?.item?.id).toBe('a');
	});

	it('is dropped when a good snapshot received after the push lacks it', () => {
		const m = make();
		m.push(push('a'));
		m.shipmates(snap([item('b')]));
		vi.advanceTimersByTime(QUESTION_WAIT_MS * 2);
		expect(get(m).toast).toBeNull();
		expect(get(m).bar).toEqual([]);
	});

	it('an inboxError snapshot does not drop it; it keeps waiting', () => {
		const m = make();
		m.push(push('a'));
		m.shipmates(snap([], {inboxError: true}));
		m.shipmates(snap([item('a')]));
		expect(get(m).toast?.item?.id).toBe('a');
	});

	it('shows a fallback from the push text when no snapshot arrives within 5 s', () => {
		const m = make();
		m.push(push('a'));
		vi.advanceTimersByTime(QUESTION_WAIT_MS - 1);
		expect(get(m).toast).toBeNull();
		vi.advanceTimersByTime(1);
		const t = get(m).toast;
		expect(t?.item).toBeNull();
		expect(t?.fallback).toEqual({
			title: 'asker-a asks',
			body: 'push a',
			navigate: '/#sess-a',
		});
	});

	it('a later snapshot upgrades the fallback to the item, or removes it', () => {
		const m = make();
		m.push(push('a'));
		m.push(push('b'));
		vi.advanceTimersByTime(QUESTION_WAIT_MS);
		m.shipmates(snap([item('a')]));
		expect(get(m).toast?.item?.id).toBe('a');
		expect(get(m).more).toBe(0);
	});

	it('a re-push of a question already shown, queued or in the bar is ignored', () => {
		const m = make();
		m.shipmates(snap([item('a'), item('b')]));
		m.push(push('a'));
		m.push(push('a'));
		expect(get(m).more).toBe(0);
		vi.advanceTimersByTime(QUESTION_TOAST_MS);
		m.push(push('a'));
		expect(get(m).toast).toBeNull();
		expect(get(m).bar).toEqual(['a']);
	});
});

describe('the queue', () => {
	it('shows one toast at a time with +N more', () => {
		const m = make();
		m.shipmates(snap([item('a'), item('b'), item('c')]));
		m.push(push('a'));
		m.push(push('b'));
		m.push(push('c'));
		expect(get(m).toast?.id).toBe('a');
		expect(get(m).more).toBe(2);
		vi.advanceTimersByTime(QUESTION_TOAST_MS);
		expect(get(m).toast?.id).toBe('b');
		expect(get(m).more).toBe(1);
		expect(get(m).bar).toEqual(['a']);
	});
});

describe('the 8 s auto-hide', () => {
	it('folds the toast into the bar after 8 s', () => {
		const m = make();
		m.shipmates(snap([item('a')]));
		m.push(push('a'));
		vi.advanceTimersByTime(QUESTION_TOAST_MS - 1);
		expect(get(m).toast?.id).toBe('a');
		vi.advanceTimersByTime(1);
		expect(get(m).toast).toBeNull();
		expect(get(m).bar).toEqual(['a']);
	});

	it('pauses while touched or hovered, and restarts 8 s on release', () => {
		const m = make();
		m.shipmates(snap([item('a')]));
		m.push(push('a'));
		m.hold('touch');
		m.hold('hover');
		vi.advanceTimersByTime(QUESTION_TOAST_MS * 3);
		expect(get(m).toast?.id).toBe('a');
		m.release('touch');
		vi.advanceTimersByTime(QUESTION_TOAST_MS * 3);
		expect(get(m).toast?.id).toBe('a');
		m.release('hover');
		vi.advanceTimersByTime(QUESTION_TOAST_MS - 1);
		expect(get(m).toast?.id).toBe('a');
		vi.advanceTimersByTime(1);
		expect(get(m).toast).toBeNull();
	});

	it('pauses while an answer is sending and while its error shows', () => {
		const m = make();
		m.shipmates(snap([item('a')]));
		m.push(push('a'));
		m.answering('a');
		expect(get(m).toast?.sending).toBe(true);
		vi.advanceTimersByTime(QUESTION_TOAST_MS * 3);
		expect(get(m).toast?.id).toBe('a');
		m.answered('a', {ok: false, error: 'not connected'});
		expect(get(m).toast).toMatchObject({
			sending: false,
			error: 'not connected',
		});
		vi.advanceTimersByTime(QUESTION_TOAST_MS * 3);
		expect(get(m).toast?.id).toBe('a');
		// Answering again clears the error.
		m.answering('a');
		expect(get(m).toast?.error).toBeNull();
	});
});

describe('answering', () => {
	it('a successful answer removes the question from the toast and the bar', () => {
		const m = make();
		m.shipmates(snap([item('a'), item('b')]));
		m.push(push('a'));
		m.push(push('b'));
		m.answering('a');
		m.answered('a', {ok: true});
		expect(get(m).toast?.id).toBe('b');
		expect(get(m).bar).toEqual([]);
	});
});

describe('dismissal', () => {
	it('✕ / swipe up removes it from the toast and the bar and shows the next', () => {
		const m = make();
		m.shipmates(snap([item('a'), item('b')]));
		m.push(push('a'));
		m.push(push('b'));
		m.dismiss('a');
		expect(get(m).toast?.id).toBe('b');
		vi.advanceTimersByTime(QUESTION_TOAST_MS);
		expect(get(m).bar).toEqual(['b']);
	});

	it('dismissing a toast that is no longer shown does nothing', () => {
		const m = make();
		m.shipmates(snap([item('a')]));
		m.push(push('a'));
		m.dismiss('zzz');
		expect(get(m).toast?.id).toBe('a');
	});
});

describe('suppression', () => {
	it('no toast and no bar entry while the Needs you panel is open', () => {
		const m = make();
		m.setContext({needsYouOpen: true, openSessionId: null});
		m.shipmates(snap([item('a')]));
		m.push(push('a'));
		expect(get(m).toast).toBeNull();
		expect(get(m).bar).toEqual([]);
	});

	it('a question from the session on screen skips the toast but enters the bar', () => {
		const m = make();
		m.setContext({needsYouOpen: false, openSessionId: 'sess-a'});
		m.shipmates(snap([item('a')]));
		m.push(push('a'));
		expect(get(m).toast).toBeNull();
		expect(get(m).bar).toEqual(['a']);
	});

	it('a fallback from the session on screen (session read from navigate) enters the bar', () => {
		const m = make();
		m.setContext({needsYouOpen: false, openSessionId: 'sess-a'});
		m.push(push('a'));
		vi.advanceTimersByTime(QUESTION_WAIT_MS);
		expect(get(m).toast).toBeNull();
		expect(get(m).bar).toEqual(['a']);
	});

	it('a fallback still shows while Needs you is open (its panel may be stale)', () => {
		const m = make();
		m.setContext({needsYouOpen: true, openSessionId: null});
		m.push(push('a'));
		vi.advanceTimersByTime(QUESTION_WAIT_MS);
		expect(get(m).toast?.fallback).not.toBeNull();
	});

	it('opening Needs you folds the shown toast into the bar and drops the queued ones', () => {
		const m = make();
		m.shipmates(snap([item('a'), item('b')]));
		m.push(push('a'));
		m.push(push('b'));
		m.setContext({needsYouOpen: true, openSessionId: null});
		expect(get(m).toast).toBeNull();
		expect(get(m).more).toBe(0);
		expect(get(m).bar).toEqual(['a']);
	});

	it('opening the asking session folds its toast and its queued questions into the bar', () => {
		const m = make();
		m.shipmates(snap([item('a'), item('b'), item('c', {sessionId: 'sess-a'})]));
		m.push(push('a'));
		m.push(push('b'));
		m.push(push('c'));
		m.setContext({needsYouOpen: false, openSessionId: 'sess-a'});
		expect(get(m).toast?.id).toBe('b');
		expect(get(m).more).toBe(0);
		expect(get(m).bar).toEqual(['a', 'c']);
	});
});

describe('answered elsewhere', () => {
	it('a good snapshot without the item removes it from the toast, the queue and the bar', () => {
		const m = make();
		m.shipmates(snap([item('a'), item('b'), item('c')]));
		m.push(push('a'));
		vi.advanceTimersByTime(QUESTION_TOAST_MS);
		m.push(push('b'));
		m.push(push('c'));
		expect(get(m).bar).toEqual(['a']);
		m.shipmates(snap([item('c')]));
		expect(get(m).toast?.id).toBe('c');
		expect(get(m).more).toBe(0);
		expect(get(m).bar).toEqual([]);
	});

	it('an inboxError or unavailable snapshot removes nothing', () => {
		const m = make();
		m.shipmates(snap([item('a'), item('b')]));
		m.push(push('a'));
		vi.advanceTimersByTime(QUESTION_TOAST_MS);
		m.push(push('b'));
		m.shipmates(snap([], {inboxError: true}));
		m.shipmates({available: false, inbox: [], presence: [], archives: []});
		expect(get(m).toast?.id).toBe('b');
		expect(get(m).bar).toEqual(['a']);
	});
});

describe('persistence of the bar', () => {
	it('round-trips the bar ids through storage', () => {
		const m = make();
		m.shipmates(snap([item('a'), item('b')]));
		m.push(push('a'));
		m.push(push('b'));
		vi.advanceTimersByTime(QUESTION_TOAST_MS * 2);
		expect(JSON.parse(storage.data.get(QUESTION_BAR_KEY)!)).toEqual(['a', 'b']);
		const again = make();
		expect(get(again).bar).toEqual(['a', 'b']);
	});

	it('prunes the stored ids against the first good snapshot', () => {
		storage = memoryStorage({[QUESTION_BAR_KEY]: JSON.stringify(['a', 'b'])});
		const m = make();
		m.shipmates(snap([], {inboxError: true}));
		expect(get(m).bar).toEqual(['a', 'b']);
		m.shipmates(snap([item('b')]));
		expect(get(m).bar).toEqual(['b']);
		expect(JSON.parse(storage.data.get(QUESTION_BAR_KEY)!)).toEqual(['b']);
	});

	it('an empty bar clears the key; malformed storage reads as empty', () => {
		const m = make();
		m.shipmates(snap([item('a')]));
		m.push(push('a'));
		vi.advanceTimersByTime(QUESTION_TOAST_MS);
		m.shipmates(snap([]));
		expect(storage.data.has(QUESTION_BAR_KEY)).toBe(false);
		storage = memoryStorage({[QUESTION_BAR_KEY]: '{nope'});
		expect(get(make()).bar).toEqual([]);
		storage = memoryStorage({[QUESTION_BAR_KEY]: '[1,"x"]'});
		expect(get(make()).bar).toEqual(['x']);
	});
});

describe('readQuestionPush', () => {
	it('reads a question push posted by the service worker', () => {
		expect(
			readQuestionPush({
				title: 'x asks',
				options: {
					body: 'why?',
					data: {kind: 'question', itemId: 'h_1', navigate: '/#s'},
				},
			}),
		).toEqual({itemId: 'h_1', title: 'x asks', body: 'why?', navigate: '/#s'});
	});

	it('anything else is not a question', () => {
		expect(
			readQuestionPush({title: 't', options: {data: {kind: 'update'}}}),
		).toBeNull();
		expect(
			readQuestionPush({title: 't', options: {data: {kind: 'question'}}}),
		).toBeNull();
		expect(readQuestionPush({title: 't', options: {}})).toBeNull();
		expect(readQuestionPush(undefined)).toBeNull();
	});
});

describe('sessionIdFromNavigate', () => {
	it('decodes the /#<sessionId> target', () => {
		expect(sessionIdFromNavigate('/#a%20b')).toBe('a b');
		expect(sessionIdFromNavigate('/')).toBeNull();
		expect(sessionIdFromNavigate('')).toBeNull();
	});
});
