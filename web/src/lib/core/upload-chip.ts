/**
 * What a composer attachment chip shows for its upload.
 *
 * The chip's ONLY source of upload state is the `onProgress({acked, size,
 * state, error?})` callback of `uploadFile()` (`web/src/lib/wherever.ts`):
 * the composer never sees an `uploadId`, and POST uploads never enter the
 * client's `uploadsStore`, so the callback is the one feed that covers every
 * path. This module turns that state into a view, plus the two decisions the
 * composer needs (does this attachment block Send, may it be retried), as pure
 * functions so they are unit-tested without a DOM.
 *
 * Decisions (also listed in the task's done record):
 * - `pre-start` is a LOCAL state, not a client one: `handleFileChange` uploads
 *   the picked files one at a time, so later files of a multi-pick wait before
 *   `uploadFile` is even called. They show a bare spinner (no "waiting" label,
 *   since nothing is waiting for the connection yet) and block Send. It is a
 *   separate name rather than a reuse of `queued`, because `queued` is the
 *   client's "held: no socket / rejoin pending / capabilities unknown" and
 *   renders "Paused, waiting for connection".
 * - `queued` and `paused` render the SAME "waiting for connection" label: to
 *   the user both mean "it will continue once the connection is back". This
 *   replaces the old label derived from `!connected || resyncing`.
 * - Sending with nothing acked yet is INDETERMINATE, not 0%: the legacy WS
 *   frame only ever reports acked 0 (POST too, until its first
 *   `upload.onprogress`), and a bar stuck at 0% would read
 *   as a hung upload, which is what story 1 is about.
 * - The percentage rounds DOWN, so 100% only shows once every byte is acked.
 * - `done` blocks Send until the resolved `savedPath` is on the attachment:
 *   the `done` callback fires just before `uploadFile` resolves, and the path
 *   (which is what the message carries) only arrives with the resolution.
 * - "Pick it again" is decided from `error.code === 'not_readable'`, never
 *   from the message text.
 */
import type {UploadError, UploadState} from '@wherever-dev/client';

/** The composer's local state for a picked file not yet handed to `uploadFile`. */
export const PRE_START = 'pre-start';

export type ChipUploadState = typeof PRE_START | UploadState;

/** The `onProgress` payload, widened with the local pre-start state. */
export interface ChipUpload {
	state: ChipUploadState;
	acked: number;
	size: number;
	error?: UploadError;
}

export type ChipView =
	/** Not handed to `uploadFile` yet: spinner, no label. */
	| {kind: 'pending'}
	/** `queued` or `paused`: "Paused, waiting for connection". */
	| {kind: 'waiting'}
	/** `sending` with nothing acked yet: spinner, no percentage. */
	| {kind: 'indeterminate'}
	/** `sending` with acked bytes: bar + percentage. */
	| {kind: 'progress'; percent: number}
	/** Every byte acked, completion pending: full bar + spinner. */
	| {kind: 'finishing'; percent: 100}
	| {kind: 'done'}
	/**
	 * The reason, and either Retry (the composer kept the `File`) or a
	 * "pick the file again" hint (the OS invalidated it).
	 */
	| {kind: 'failed'; message: string; retry: boolean; pickAgain: boolean}
	/** Cancelled: the chip goes away, with no error and no Retry. */
	| {kind: 'removed'};

const GENERIC_FAILURE = 'Failed to upload';

export function preStartUpload(size: number): ChipUpload {
	return {state: PRE_START, acked: 0, size};
}

/** Acked share of the size as a whole percentage, rounded down, 0..100. */
export function uploadPercent(acked: number, size: number): number {
	if (!(size > 0)) return 0;
	const pct = Math.floor((acked / size) * 100);
	return Math.min(100, Math.max(0, pct));
}

/** Whether a failure may be retried from the same `File`. */
export function canRetryUpload(error: UploadError | undefined): boolean {
	return error?.code !== 'not_readable';
}

export function chipView(upload: ChipUpload): ChipView {
	switch (upload.state) {
		case PRE_START:
			return {kind: 'pending'};
		case 'queued':
		case 'paused':
			return {kind: 'waiting'};
		case 'sending':
			return upload.acked > 0
				? {kind: 'progress', percent: uploadPercent(upload.acked, upload.size)}
				: {kind: 'indeterminate'};
		case 'finishing':
			return {kind: 'finishing', percent: 100};
		case 'done':
			return {kind: 'done'};
		case 'aborted':
			return {kind: 'removed'};
		case 'failed': {
			const retry = canRetryUpload(upload.error);
			return {
				kind: 'failed',
				message: upload.error?.message || GENERIC_FAILURE,
				retry,
				pickAgain: !retry,
			};
		}
	}
}

/** Pre-start, queued, sending, paused or finishing: Cancel applies. */
export function isUploadInFlight(state: ChipUploadState): boolean {
	return (
		state === PRE_START ||
		state === 'queued' ||
		state === 'sending' ||
		state === 'paused' ||
		state === 'finishing'
	);
}

/**
 * Whether this attachment keeps Send disabled. A failed chip does not (the
 * user may send without it); a search-held file has no `upload` and does not.
 */
export function attachmentBlocksSend(attachment: {
	upload?: ChipUpload;
	path?: string;
}): boolean {
	const upload = attachment.upload;
	if (!upload) return false;
	if (isUploadInFlight(upload.state)) return true;
	return upload.state === 'done' && !attachment.path;
}

/**
 * The `UploadError` for a thrown failure (the promise rejection of
 * `uploadFile`, or a failure before it ran such as "No active session").
 * Only the `not_readable` code is carried over.
 */
export function uploadErrorFrom(err: unknown): UploadError {
	const e = err as {message?: unknown; code?: unknown} | null | undefined;
	const message =
		typeof e?.message === 'string' && e.message ? e.message : GENERIC_FAILURE;
	return e?.code === 'not_readable'
		? {message, code: 'not_readable'}
		: {message};
}
