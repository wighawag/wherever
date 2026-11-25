import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'svelte/store';
import {
	createUpdateToasts,
	readUpdatePush,
	splitUpdateTitle,
	updateAge,
	UPDATE_LIST_CAP,
	UPDATE_LIST_KEY,
	UPDATE_TOAST_MS,
	type Update,
} from './update-toasts';

// The foreground update toasts and the updates list (spec
// `notifications-compact`, stories 12 to 17): a pure model driven by the
// update pushes posted to the visible page, with fake time for the 6 s hide.

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
let opened: string[];
let clock: number;

function make() {
	return createUpdateToasts({
		storage,
		openTarget: (n) => opened.push(n),
	});
}

function upd(id: string, extra: Partial<Update> = {}): Update {
	return {
		id,
		title: `code: ${id} finished`,
		body: `body ${id}`,
		navigate: `/#sess-${id}`,
		at: clock,
		...extra,
	};
}

const ids = (list: Update[]) => list.map((u) => u.id);

beforeEach(() => {
	vi.useFakeTimers();
	storage = memoryStorage();
	opened = [];
	clock = 1_000_000;
});
afterEach(() => {
	vi.useRealTimers();
});

describe('readUpdatePush', () => {
	it('reads the title, body, target and tag of a posted notification', () => {
		const u = readUpdatePush(
			{
				title: 'code: Deploy finished',
				options: {
					body: 'all green',
					tag: 'update-123',
					data: {kind: 'update', navigate: '/#s1'},
				},
			},
			42,
		);
		expect(u).toEqual({
			id: 'update-123',
			title: 'code: Deploy finished',
			body: 'all green',
			navigate: '/#s1',
			at: 42,
		});
	});

	it('copes with a push from an older server (no kind, no tag, no target)', () => {
		const u = readUpdatePush({title: 'hi', options: {}}, 7);
		expect(u.title).toBe('hi');
		expect(u.body).toBe('');
		expect(u.navigate).toBe('');
		expect(u.at).toBe(7);
		expect(u.id).toMatch(/^update-7-/);
		expect(readUpdatePush({title: 'hi', options: {}}, 7).id).not.toBe(u.id);
	});
});

describe('the update toast queue', () => {
	it('shows one update at a time; the rest wait as "+N more"', () => {
		const m = make();
		m.push(upd('a'));
		m.push(upd('b'));
		m.push(upd('c'));
		expect(get(m).toast?.id).toBe('a');
		expect(get(m).more).toBe(2);
		expect(get(m).list).toEqual([]);
	});

	it('a re-push of an update already known (same tag) is ignored', () => {
		const m = make();
		m.push(upd('a'));
		m.push(upd('a'));
		expect(get(m).more).toBe(0);
		vi.advanceTimersByTime(UPDATE_TOAST_MS);
		m.push(upd('a'));
		expect(get(m).toast).toBeNull();
		expect(ids(get(m).list)).toEqual(['a']);
	});
});

describe('the 6 s hide and the fold into the bar', () => {
	it('hides after 6 s and folds into the list; the next one shows', () => {
		const m = make();
		m.push(upd('a'));
		m.push(upd('b'));
		vi.advanceTimersByTime(UPDATE_TOAST_MS - 1);
		expect(get(m).toast?.id).toBe('a');
		vi.advanceTimersByTime(1);
		expect(get(m).toast?.id).toBe('b');
		expect(ids(get(m).list)).toEqual(['a']);
		vi.advanceTimersByTime(UPDATE_TOAST_MS);
		expect(get(m).toast).toBeNull();
		expect(ids(get(m).list)).toEqual(['b', 'a']);
	});

	it('the list is newest first', () => {
		const m = make();
		m.push(upd('a', {at: 1}));
		clock += 10;
		m.push(upd('b', {at: 2}));
		vi.advanceTimersByTime(UPDATE_TOAST_MS * 2);
		expect(ids(get(m).list)).toEqual(['b', 'a']);
	});

	it('does not hide while touched or hovered; releasing restarts the full 6 s', () => {
		const m = make();
		m.push(upd('a'));
		vi.advanceTimersByTime(5000);
		m.hold('touch');
		m.hold('hover');
		vi.advanceTimersByTime(UPDATE_TOAST_MS * 3);
		expect(get(m).toast?.id).toBe('a');
		m.release('touch');
		vi.advanceTimersByTime(UPDATE_TOAST_MS * 3);
		expect(get(m).toast?.id).toBe('a');
		m.release('hover');
		vi.advanceTimersByTime(UPDATE_TOAST_MS - 1);
		expect(get(m).toast?.id).toBe('a');
		vi.advanceTimersByTime(1);
		expect(get(m).toast).toBeNull();
		expect(ids(get(m).list)).toEqual(['a']);
	});

	it('a hold is per toast: the next toast starts unheld', () => {
		const m = make();
		m.push(upd('a'));
		m.push(upd('b'));
		m.hold('hover');
		m.dismiss('a');
		vi.advanceTimersByTime(UPDATE_TOAST_MS);
		expect(get(m).toast).toBeNull();
	});
});

describe('open and dismiss', () => {
	it('tapping the toast opens its target and removes it (not listed)', () => {
		const m = make();
		m.push(upd('a'));
		m.push(upd('b'));
		m.open('a');
		expect(opened).toEqual(['/#sess-a']);
		expect(get(m).toast?.id).toBe('b');
		vi.advanceTimersByTime(UPDATE_TOAST_MS);
		expect(ids(get(m).list)).toEqual(['b']);
	});

	it('✕ on the toast dismisses it: gone, not listed, nothing opened', () => {
		const m = make();
		m.push(upd('a'));
		m.dismiss('a');
		expect(get(m).toast).toBeNull();
		expect(get(m).list).toEqual([]);
		expect(opened).toEqual([]);
		expect(storage.data.has(UPDATE_LIST_KEY)).toBe(false);
	});

	it('Open in the list opens its target and removes it', () => {
		const m = make();
		m.push(upd('a'));
		m.push(upd('b'));
		vi.advanceTimersByTime(UPDATE_TOAST_MS * 2);
		m.open('a');
		expect(opened).toEqual(['/#sess-a']);
		expect(ids(get(m).list)).toEqual(['b']);
	});

	it('an update without a target only goes away', () => {
		const m = make();
		m.push(upd('a', {navigate: ''}));
		m.open('a');
		expect(opened).toEqual([]);
		expect(get(m).toast).toBeNull();
	});

	it('Dismiss in the list removes it', () => {
		const m = make();
		m.push(upd('a'));
		m.push(upd('b'));
		vi.advanceTimersByTime(UPDATE_TOAST_MS * 2);
		m.dismiss('b');
		expect(ids(get(m).list)).toEqual(['a']);
	});

	it('Clear all empties the list but leaves the toast on screen and the queue', () => {
		const m = make();
		m.push(upd('a'));
		m.push(upd('b'));
		vi.advanceTimersByTime(UPDATE_TOAST_MS);
		m.push(upd('c'));
		expect(ids(get(m).list)).toEqual(['a']);
		m.clearAll();
		expect(get(m).list).toEqual([]);
		expect(get(m).toast?.id).toBe('b');
		expect(get(m).more).toBe(1);
	});

	it('an unknown id is ignored', () => {
		const m = make();
		m.push(upd('a'));
		m.open('zzz');
		m.dismiss('zzz');
		expect(get(m).toast?.id).toBe('a');
		expect(opened).toEqual([]);
	});
});

describe('persistence on this device', () => {
	it('keeps every update not opened or dismissed, newest first, across a reload', () => {
		const m = make();
		m.push(upd('a', {at: 1}));
		m.push(upd('b', {at: 2}));
		vi.advanceTimersByTime(UPDATE_TOAST_MS);
		const stored = JSON.parse(storage.data.get(UPDATE_LIST_KEY)!) as Update[];
		expect(ids(stored)).toEqual(['b', 'a']);
		// A reload: what was on screen or waiting comes back in the list, folded
		// (it is not toasted again).
		const again = make();
		expect(get(again).toast).toBeNull();
		expect(ids(get(again).list)).toEqual(['b', 'a']);
		expect(get(again).list[0]).toEqual(upd('b', {at: 2}));
	});

	it('opening, dismissing and clearing are kept too', () => {
		const m = make();
		m.push(upd('a', {at: 1}));
		m.push(upd('b', {at: 2}));
		m.push(upd('c', {at: 3}));
		vi.advanceTimersByTime(UPDATE_TOAST_MS * 3);
		m.open('c');
		m.dismiss('a');
		expect(ids(get(make()).list)).toEqual(['b']);
		m.clearAll();
		expect(storage.data.has(UPDATE_LIST_KEY)).toBe(false);
		expect(get(make()).list).toEqual([]);
	});

	it(`is capped at ${UPDATE_LIST_CAP}: the oldest goes first`, () => {
		const m = make();
		for (let i = 0; i < UPDATE_LIST_CAP + 3; i++) {
			m.push(upd(`u${i}`, {at: i}));
			vi.advanceTimersByTime(UPDATE_TOAST_MS);
		}
		const list = get(m).list;
		expect(list).toHaveLength(UPDATE_LIST_CAP);
		expect(list[0]!.id).toBe(`u${UPDATE_LIST_CAP + 2}`);
		expect(list.at(-1)!.id).toBe('u3');
		const stored = JSON.parse(storage.data.get(UPDATE_LIST_KEY)!) as Update[];
		expect(stored).toHaveLength(UPDATE_LIST_CAP);
	});

	it('a capped-out update still waiting in the queue is dropped from it', () => {
		const m = make();
		for (let i = 0; i < UPDATE_LIST_CAP + 1; i++) m.push(upd(`u${i}`, {at: i}));
		// u0 is on screen; the cap drops the oldest one NOT on screen.
		expect(get(m).toast?.id).toBe('u0');
		expect(get(m).more).toBe(UPDATE_LIST_CAP - 1);
	});

	it('ignores a corrupt or foreign stored value', () => {
		storage = memoryStorage({[UPDATE_LIST_KEY]: '{nope'});
		expect(get(make()).list).toEqual([]);
		storage = memoryStorage({
			[UPDATE_LIST_KEY]: JSON.stringify([
				{id: 'ok', title: 't', body: 'b', navigate: '/#x', at: 1},
				{id: 3},
				'junk',
			]),
		});
		expect(ids(get(make()).list)).toEqual(['ok']);
	});

	it('works without storage', () => {
		const m = createUpdateToasts({openTarget: () => {}});
		m.push(upd('a'));
		vi.advanceTimersByTime(UPDATE_TOAST_MS);
		expect(ids(get(m).list)).toEqual(['a']);
	});
});

describe('updateAge', () => {
	it('reads as now, minutes, hours, then days', () => {
		const t = 10_000_000;
		expect(updateAge(t, t + 30_000)).toBe('now');
		expect(updateAge(t, t + 5 * 60_000)).toBe('5 min');
		expect(updateAge(t, t + 3 * 3_600_000)).toBe('3 h');
		expect(updateAge(t, t + 2 * 86_400_000)).toBe('2 d');
	});
});

describe('splitUpdateTitle', () => {
	it('splits "<source>: <title>" for the bold source and the muted rest', () => {
		expect(splitUpdateTitle('drive-sidebar-tasks: finished')).toEqual({
			source: 'drive-sidebar-tasks',
			text: 'finished',
		});
		expect(splitUpdateTitle('code: a: b')).toEqual({
			source: 'code',
			text: 'a: b',
		});
	});

	it('a title without a source is all text', () => {
		expect(splitUpdateTitle('Deploy finished')).toEqual({
			source: '',
			text: 'Deploy finished',
		});
		expect(splitUpdateTitle(': odd')).toEqual({source: '', text: ': odd'});
	});
});
