import {describe, it, expect} from 'vitest';
import {
	cascadePromptText,
	closeBannerText,
	closeWithCascade,
	undoClose,
	type CloseApi,
	type CloseResult,
} from './close-flow';

/** A fake server: ownership, a closed set with batches, and stars. */
function fakeServer(
	ownership: Record<string, string[]>,
	starred: string[] = [],
) {
	const closed = new Map<string, {batch: string; unstarred: boolean}>();
	const stars = new Set(starred);
	const calls: string[] = [];
	let n = 0;
	const subtree = (f: string): string[] =>
		(ownership[f] ?? []).flatMap((c) => [c, ...subtree(c)]);
	const api: CloseApi = {
		async owned(f) {
			calls.push(`owned ${f}`);
			return subtree(f).filter((c) => !closed.has(c));
		},
		async close(f, cascade): Promise<CloseResult> {
			calls.push(`close ${f} cascade=${cascade}`);
			const batch = `c_${++n}`;
			const took: string[] = [];
			for (const x of cascade ? [f, ...subtree(f)] : [f]) {
				if (closed.has(x)) continue;
				closed.set(x, {batch, unstarred: stars.delete(x)});
				took.push(x);
			}
			return {batch, sessions: took};
		},
		async reopenBatch(batch): Promise<CloseResult> {
			calls.push(`reopen ${batch}`);
			const took: string[] = [];
			for (const [f, e] of closed) {
				if (e.batch !== batch) continue;
				closed.delete(f);
				if (e.unstarred) stars.add(f);
				took.push(f);
			}
			return {batch, sessions: took};
		},
	};
	return {api, closed, stars, calls};
}

describe('close flow', () => {
	it('asks with the SERVER N (the transitive subtree), not the listed children count', async () => {
		// The sidebar lists only `child`; the server knows the grandchild too.
		const listedChildren = ['/s/child.jsonl'];
		const s = fakeServer({
			'/s/owner.jsonl': ['/s/child.jsonl'],
			'/s/child.jsonl': ['/w/grandchild.jsonl'],
		});
		const asked: number[] = [];
		const banner = await closeWithCascade(
			'/s/owner.jsonl',
			s.api,
			async (n) => {
				asked.push(n);
				return true;
			},
		);
		expect(asked).toEqual([2]);
		expect(asked[0]).not.toBe(listedChildren.length);
		expect(cascadePromptText(2)).toBe('Also close the 2 sessions it owns?');
		expect(cascadePromptText(1)).toBe('Also close the 1 session it owns?');
		expect(banner).toMatchObject({
			batch: 'c_1',
			root: '/s/owner.jsonl',
			owned: 2,
		});
		expect(closeBannerText('Owner', banner!.owned)).toBe(
			'Closed Owner (and 2 owned).',
		);
		expect([...s.closed.keys()].sort()).toEqual(
			['/s/owner.jsonl', '/s/child.jsonl', '/w/grandchild.jsonl'].sort(),
		);

		// Undo reopens the whole batch.
		await undoClose(banner!, s.api);
		expect(s.closed.size).toBe(0);
		expect(s.calls.at(-1)).toBe('reopen c_1');
	});

	it('a session that owns nothing closes without a question and still gets an undo banner; undo restores its star', async () => {
		const s = fakeServer({}, ['/s/one.jsonl']);
		const banner = await closeWithCascade('/s/one.jsonl', s.api, async () => {
			throw new Error('must not ask');
		});
		expect(banner).toMatchObject({
			batch: 'c_1',
			root: '/s/one.jsonl',
			owned: 0,
		});
		expect(closeBannerText('One', 0)).toBe('Closed One.');
		expect(s.stars.has('/s/one.jsonl')).toBe(false);
		await undoClose(banner!, s.api);
		expect(s.closed.size).toBe(0);
		expect(s.stars.has('/s/one.jsonl')).toBe(true);
	});

	it('"only this one" closes just the session; cancel closes nothing', async () => {
		const own = {'/s/owner.jsonl': ['/s/child.jsonl']};
		const only = fakeServer(own);
		const b = await closeWithCascade(
			'/s/owner.jsonl',
			only.api,
			async () => false,
		);
		expect(b).toMatchObject({owned: 0});
		expect([...only.closed.keys()]).toEqual(['/s/owner.jsonl']);
		expect(only.calls).toContain('close /s/owner.jsonl cascade=false');

		const cancel = fakeServer(own);
		expect(
			await closeWithCascade('/s/owner.jsonl', cancel.api, async () => null),
		).toBeNull();
		expect(cancel.closed.size).toBe(0);
	});

	it('a failed ownership lookup still closes the session alone', async () => {
		const s = fakeServer({'/s/owner.jsonl': ['/s/child.jsonl']});
		s.api.owned = async () => {
			throw new Error('offline');
		};
		const b = await closeWithCascade('/s/owner.jsonl', s.api, async () => {
			throw new Error('must not ask');
		});
		expect(b).toMatchObject({owned: 0});
		expect([...s.closed.keys()]).toEqual(['/s/owner.jsonl']);
	});

	it('no banner when the close took nothing (already closed)', async () => {
		const s = fakeServer({});
		await closeWithCascade('/s/x.jsonl', s.api, async () => true);
		expect(
			await closeWithCascade('/s/x.jsonl', s.api, async () => true),
		).toBeNull();
	});
});
