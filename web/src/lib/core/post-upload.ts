/**
 * The `uploads.method: 'post'` upload: one `POST /session/upload` over
 * XMLHttpRequest, mapped onto the same `onProgress({acked, size, state,
 * error?})` contract as the WebSocket paths, so the composer chip renders it
 * identically.
 *
 * XMLHttpRequest rather than `fetch` because `fetch` has no upload progress;
 * `xhr.upload.onprogress` does. The XHR is injected (`createXhr`) so the
 * mapping is unit-tested without a browser.
 *
 * Decisions (recorded here, the choice site; linked from the task's done record):
 * - Over POST, `acked` is `upload.onprogress`'s `loaded`: the bytes the browser
 *   has handed to the network, not bytes the server confirmed (the WebSocket
 *   paths' meaning). It is the only progress signal HTTP gives, and the task
 *   prescribes it. The bar can therefore sit at 100% `sending` while the server
 *   finishes writing; `done` only follows the server's 2xx reply.
 * - The `File` is sent as-is (streamed by the browser) instead of being read
 *   into one `ArrayBuffer` first, as the old `fetch` path did, so a large file
 *   is never held in memory. The price is that an OS-invalidated pick no longer
 *   throws `NotReadableError` up front; it surfaces as a network error. So on
 *   `error`, the source is probed (`probeReadable`, one byte) and an unreadable
 *   file reports `code: 'not_readable'` ("pick it again"), as before.
 * - XHR does not settle a promise by itself, so every terminal event (`load`,
 *   `error`, `abort`, `timeout`) settles it, exactly once; events after that are
 *   ignored. There is no resume over POST: a failure is retried from zero.
 */
import type {UploadError, UploadProgress} from '@wherever-dev/client';

/** The parts of XMLHttpRequest this module uses. */
export interface PostUploadXhr {
	open(method: string, url: string): void;
	setRequestHeader(name: string, value: string): void;
	send(body: any): void;
	abort(): void;
	readonly status: number;
	readonly responseText: string;
	upload: {onprogress: ((e: {loaded: number}) => void) | null};
	onload: (() => void) | null;
	onerror: (() => void) | null;
	onabort: (() => void) | null;
	ontimeout: (() => void) | null;
}

export interface PostUploadResult {
	savedPath: string;
	filename: string;
}

export const NOT_READABLE_MESSAGE =
	'The file is no longer readable, pick it again';

function abortError(): Error {
	return Object.assign(new Error('Upload cancelled'), {name: 'AbortError'});
}

export function postUpload(opts: {
	url: string;
	body: unknown;
	size: number;
	signal?: AbortSignal;
	onProgress?: (p: UploadProgress) => void;
	createXhr?: () => PostUploadXhr;
	/** Resolves false when the source can no longer be read (see the module comment). */
	probeReadable?: () => Promise<boolean>;
}): Promise<PostUploadResult> {
	const {size, signal} = opts;
	let acked = 0;
	const report = (state: UploadProgress['state'], error?: UploadError) =>
		opts.onProgress?.({acked, size, state, ...(error ? {error} : {})});

	return new Promise<PostUploadResult>((resolve, reject) => {
		if (signal?.aborted) {
			report('aborted');
			reject(abortError());
			return;
		}
		const xhr = (
			opts.createXhr ?? (() => new XMLHttpRequest() as PostUploadXhr)
		)();
		let settled = false;
		const onSignal = () => xhr.abort();
		const finish = () => {
			settled = true;
			signal?.removeEventListener('abort', onSignal);
		};
		const fail = (message: string, code?: UploadError['code']) => {
			if (settled) return;
			finish();
			const error: UploadError = code ? {message, code} : {message};
			report('failed', error);
			reject(Object.assign(new Error(message), code ? {code} : {}));
		};

		xhr.upload.onprogress = (e) => {
			if (settled) return;
			acked = Math.max(0, Math.min(size, e.loaded));
			report('sending');
		};
		xhr.onload = () => {
			if (settled) return;
			let data: any;
			try {
				data = JSON.parse(xhr.responseText);
			} catch {
				data = undefined;
			}
			if (xhr.status < 200 || xhr.status >= 300) {
				fail(
					(data && typeof data.error === 'string' && data.error) ||
						`Upload failed with status ${xhr.status}`,
				);
				return;
			}
			if (!data || typeof data.savedPath !== 'string') {
				fail('Upload failed: the server sent an unreadable reply');
				return;
			}
			finish();
			acked = size;
			report('done');
			resolve(data);
		};
		xhr.onerror = () => {
			if (settled) return;
			const probe = opts.probeReadable ?? (async () => true);
			probe()
				.catch(() => false)
				.then((readable) =>
					readable
						? fail('Upload failed (network error)')
						: fail(NOT_READABLE_MESSAGE, 'not_readable'),
				);
		};
		xhr.ontimeout = () => fail('Upload timed out');
		xhr.onabort = () => {
			if (settled) return;
			finish();
			report('aborted');
			reject(abortError());
		};

		signal?.addEventListener('abort', onSignal);
		xhr.open('POST', opts.url);
		// `text/plain`, as the `fetch` path sent: a CORS-safelisted type keeps
		// this a simple request (the server reads the raw body regardless).
		xhr.setRequestHeader('Content-Type', 'text/plain');
		report('sending');
		xhr.send(opts.body);
	});
}

/** Can the first byte of `file` still be read? (an OS-invalidated pick cannot). */
export async function fileStillReadable(file: Blob): Promise<boolean> {
	try {
		await file.slice(0, 1).arrayBuffer();
		return true;
	} catch {
		return false;
	}
}
