import {describe, it, expect} from 'vitest';
import {copyText} from './clipboard';

// The Copy buttons' logic: the async Clipboard API when there is one, else the
// legacy execCommand('copy') on a temporary textarea, else a clear "no".

function fakeDocument(execResult: boolean | 'throw') {
	const added: any[] = [];
	const doc = {
		body: {
			appendChild: (el: any) => added.push(el),
			removeChild: (el: any) => added.splice(added.indexOf(el), 1),
		},
		createElement: () => ({
			value: '',
			style: {} as Record<string, string>,
			setAttribute() {},
			select() {
				(this as any).selected = true;
			},
		}),
		execCommand: (cmd: string) => {
			if (execResult === 'throw') throw new Error('nope');
			doc.copied = cmd === 'copy' ? added[0]?.value : undefined;
			return execResult;
		},
		copied: undefined as string | undefined,
		added,
	};
	return doc;
}

describe('copyText', () => {
	it('uses navigator.clipboard.writeText when available', async () => {
		let written = '';
		const ok = await copyText('ABCD1234', {
			clipboard: {writeText: async (t) => void (written = t)},
			document: fakeDocument(false) as any,
		});
		expect(ok).toBe(true);
		expect(written).toBe('ABCD1234');
	});

	it('falls back to execCommand when the clipboard API is missing or refuses', async () => {
		const doc = fakeDocument(true);
		expect(
			await copyText('X', {clipboard: undefined, document: doc as any}),
		).toBe(true);
		expect(doc.copied).toBe('X');
		expect(doc.added).toEqual([]);

		const doc2 = fakeDocument(true);
		const refused = {
			writeText: async () => {
				throw new Error('NotAllowedError');
			},
		};
		expect(
			await copyText('Y', {clipboard: refused, document: doc2 as any}),
		).toBe(true);
		expect(doc2.copied).toBe('Y');
	});

	it('answers false when nothing can copy (the caller then says to copy by hand)', async () => {
		expect(
			await copyText('Z', {
				clipboard: undefined,
				document: fakeDocument(false) as any,
			}),
		).toBe(false);
		expect(
			await copyText('Z', {
				clipboard: undefined,
				document: fakeDocument('throw') as any,
			}),
		).toBe(false);
		expect(
			await copyText('Z', {clipboard: undefined, document: undefined}),
		).toBe(false);
	});
});
