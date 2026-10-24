import {describe, it, expect} from 'vitest';
import type {UploadProgress} from '@wherever-dev/client';
import {postUpload, type PostUploadXhr} from './post-upload.js';

/** A scripted XMLHttpRequest: the test fires its events by hand. */
class FakeXhr implements PostUploadXhr {
	status = 0;
	responseText = '';
	upload: {onprogress: ((e: {loaded: number}) => void) | null} = {
		onprogress: null,
	};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	opened: [string, string] | null = null;
	headers: Record<string, string> = {};
	sent: unknown = undefined;
	aborted = 0;
	open(method: string, url: string) {
		this.opened = [method, url];
	}
	setRequestHeader(k: string, v: string) {
		this.headers[k] = v;
	}
	send(body: unknown) {
		this.sent = body;
	}
	abort() {
		this.aborted++;
		// A real XHR fires `abort` for an in-flight request.
		this.onabort?.();
	}
	reply(status: number, body: unknown) {
		this.status = status;
		this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
		this.onload?.();
	}
}

function start(opts?: {
	signal?: AbortSignal;
	size?: number;
	readable?: boolean;
}) {
	const xhr = new FakeXhr();
	const reports: UploadProgress[] = [];
	const size = opts?.size ?? 100;
	const promise = postUpload({
		url: 'https://h/session/upload?sessionId=s&filename=a.txt',
		body: 'BODY',
		size,
		signal: opts?.signal,
		onProgress: (p) => reports.push(p),
		createXhr: () => xhr,
		probeReadable: async () => opts?.readable ?? true,
	});
	return {xhr, reports, promise};
}

describe('postUpload', () => {
	it('POSTs the body and maps upload.onprogress to sending, then done', async () => {
		const {xhr, reports, promise} = start();
		expect(xhr.opened).toEqual([
			'POST',
			'https://h/session/upload?sessionId=s&filename=a.txt',
		]);
		expect(xhr.sent).toBe('BODY');
		xhr.upload.onprogress?.({loaded: 40});
		xhr.upload.onprogress?.({loaded: 100});
		xhr.reply(200, {
			status: 'uploaded',
			filename: 'a.txt',
			savedPath: '/x/a.txt',
		});
		await expect(promise).resolves.toEqual({
			status: 'uploaded',
			filename: 'a.txt',
			savedPath: '/x/a.txt',
		});
		expect(reports).toEqual([
			{acked: 0, size: 100, state: 'sending'},
			{acked: 40, size: 100, state: 'sending'},
			{acked: 100, size: 100, state: 'sending'},
			{acked: 100, size: 100, state: 'done'},
		]);
	});

	it('clamps progress to the size', async () => {
		const {xhr, reports} = start({size: 10});
		xhr.upload.onprogress?.({loaded: 25});
		expect(reports.at(-1)).toEqual({acked: 10, size: 10, state: 'sending'});
	});

	it('reports a refusal with the server reason and rejects with it', async () => {
		const {xhr, reports, promise} = start();
		xhr.reply(403, {error: 'This session is read-only from here'});
		await expect(promise).rejects.toThrow(
			'This session is read-only from here',
		);
		expect(reports.at(-1)).toEqual({
			acked: 0,
			size: 100,
			state: 'failed',
			error: {message: 'This session is read-only from here'},
		});
	});

	it('falls back to the status when the refusal has no JSON reason', async () => {
		const {xhr, reports, promise} = start();
		xhr.reply(502, '<html>bad gateway</html>');
		await expect(promise).rejects.toThrow('Upload failed with status 502');
		expect(reports.at(-1)?.state).toBe('failed');
	});

	it('a cancel aborts the request, reports aborted and rejects', async () => {
		const ac = new AbortController();
		const {xhr, reports, promise} = start({signal: ac.signal});
		xhr.upload.onprogress?.({loaded: 30});
		ac.abort();
		await expect(promise).rejects.toMatchObject({name: 'AbortError'});
		expect(xhr.aborted).toBe(1);
		expect(reports.at(-1)).toEqual({acked: 30, size: 100, state: 'aborted'});
	});

	it('an already-aborted signal never sends', async () => {
		const ac = new AbortController();
		ac.abort();
		const {xhr, reports, promise} = start({signal: ac.signal});
		await expect(promise).rejects.toMatchObject({name: 'AbortError'});
		expect(xhr.sent).toBeUndefined();
		expect(reports).toEqual([{acked: 0, size: 100, state: 'aborted'}]);
	});

	it('a network error reports failed and rejects', async () => {
		const {xhr, reports, promise} = start();
		xhr.onerror?.();
		await expect(promise).rejects.toThrow(/network/i);
		expect(reports.at(-1)?.state).toBe('failed');
		expect(reports.at(-1)?.error?.code).toBeUndefined();
	});

	it('a network error on a file that is no longer readable says pick it again', async () => {
		const {xhr, reports, promise} = start({readable: false});
		xhr.onerror?.();
		await expect(promise).rejects.toMatchObject({code: 'not_readable'});
		expect(reports.at(-1)).toEqual({
			acked: 0,
			size: 100,
			state: 'failed',
			error: {
				message: 'The file is no longer readable, pick it again',
				code: 'not_readable',
			},
		});
	});

	it('settles exactly once: a late event after the reply changes nothing', async () => {
		const ac = new AbortController();
		const {xhr, reports, promise} = start({signal: ac.signal});
		xhr.reply(200, {status: 'uploaded', filename: 'a.txt', savedPath: '/x'});
		await promise;
		const n = reports.length;
		ac.abort();
		xhr.onerror?.();
		xhr.onabort?.();
		expect(xhr.aborted).toBe(0);
		expect(reports.length).toBe(n);
	});

	it('a 2xx reply that is not JSON fails rather than hanging', async () => {
		const {xhr, reports, promise} = start();
		xhr.reply(200, 'not json');
		await expect(promise).rejects.toThrow();
		expect(reports.at(-1)?.state).toBe('failed');
	});
});
