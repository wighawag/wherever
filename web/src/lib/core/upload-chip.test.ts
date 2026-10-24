import {describe, it, expect} from 'vitest';
import {
	PRE_START,
	attachmentBlocksSend,
	chipView,
	isUploadInFlight,
	preStartUpload,
	uploadErrorFrom,
	uploadPercent,
} from './upload-chip.js';

describe('uploadPercent', () => {
	it('is the acked share of the size, rounded down', () => {
		expect(uploadPercent(0, 1000)).toBe(0);
		expect(uploadPercent(333, 1000)).toBe(33);
		expect(uploadPercent(999, 1000)).toBe(99);
		expect(uploadPercent(1000, 1000)).toBe(100);
	});

	it('is clamped and never NaN', () => {
		expect(uploadPercent(2000, 1000)).toBe(100);
		expect(uploadPercent(-5, 1000)).toBe(0);
		expect(uploadPercent(0, 0)).toBe(0);
	});
});

describe('chipView', () => {
	it('shows a bare spinner before the upload is handed over', () => {
		expect(chipView(preStartUpload(10))).toEqual({kind: 'pending'});
	});

	it('says it is waiting for connection while queued or paused', () => {
		expect(chipView({state: 'queued', acked: 0, size: 10})).toEqual({
			kind: 'waiting',
		});
		expect(chipView({state: 'paused', acked: 4, size: 10})).toEqual({
			kind: 'waiting',
		});
	});

	it('is indeterminate (not 0%) while sending with nothing acked', () => {
		expect(chipView({state: 'sending', acked: 0, size: 10})).toEqual({
			kind: 'indeterminate',
		});
	});

	it('shows a percentage once bytes are acked', () => {
		expect(chipView({state: 'sending', acked: 256, size: 1024})).toEqual({
			kind: 'progress',
			percent: 25,
		});
	});

	it('shows finishing at 100%', () => {
		expect(chipView({state: 'finishing', acked: 10, size: 10})).toEqual({
			kind: 'finishing',
			percent: 100,
		});
	});

	it('shows done', () => {
		expect(chipView({state: 'done', acked: 10, size: 10})).toEqual({
			kind: 'done',
		});
	});

	it('removes the chip on aborted', () => {
		expect(chipView({state: 'aborted', acked: 3, size: 10})).toEqual({
			kind: 'removed',
		});
	});

	it('shows the reason and offers Retry on a failure', () => {
		expect(
			chipView({
				state: 'failed',
				acked: 0,
				size: 10,
				error: {message: 'session changed'},
			}),
		).toEqual({
			kind: 'failed',
			message: 'session changed',
			retry: true,
			pickAgain: false,
		});
	});

	it('asks to pick the file again (no Retry) when it is not readable', () => {
		expect(
			chipView({
				state: 'failed',
				acked: 0,
				size: 10,
				error: {message: 'whatever text', code: 'not_readable'},
			}),
		).toEqual({
			kind: 'failed',
			message: 'whatever text',
			retry: false,
			pickAgain: true,
		});
	});

	it('decides "pick again" from the code, never from the message', () => {
		const view = chipView({
			state: 'failed',
			acked: 0,
			size: 10,
			error: {message: 'The file is no longer readable, pick it again'},
		});
		expect(view).toMatchObject({retry: true, pickAgain: false});
	});

	it('falls back to a generic reason when a failure carries none', () => {
		expect(chipView({state: 'failed', acked: 0, size: 10})).toMatchObject({
			kind: 'failed',
			message: 'Failed to upload',
			retry: true,
		});
	});
});

describe('isUploadInFlight', () => {
	it('is true for pre-start, queued, sending, paused and finishing', () => {
		for (const s of [
			PRE_START,
			'queued',
			'sending',
			'paused',
			'finishing',
		] as const) {
			expect(isUploadInFlight(s)).toBe(true);
		}
	});

	it('is false for done, failed and aborted', () => {
		for (const s of ['done', 'failed', 'aborted'] as const) {
			expect(isUploadInFlight(s)).toBe(false);
		}
	});
});

describe('attachmentBlocksSend', () => {
	it('blocks while the upload is in flight', () => {
		expect(
			attachmentBlocksSend({upload: {state: 'paused', acked: 0, size: 1}}),
		).toBe(true);
		expect(attachmentBlocksSend({upload: preStartUpload(1)})).toBe(true);
	});

	it('does not block on a failed chip', () => {
		expect(
			attachmentBlocksSend({
				upload: {state: 'failed', acked: 0, size: 1, error: {message: 'x'}},
			}),
		).toBe(false);
	});

	it('blocks on done until the saved path is known', () => {
		const upload = {state: 'done' as const, acked: 1, size: 1};
		expect(attachmentBlocksSend({upload})).toBe(true);
		expect(attachmentBlocksSend({upload, path: '/tmp/a'})).toBe(false);
	});

	it('does not block a search-held file or an attachment with no upload', () => {
		expect(attachmentBlocksSend({})).toBe(false);
	});
});

describe('uploadErrorFrom', () => {
	it('keeps the message and the not_readable code', () => {
		const err = Object.assign(new Error('pick it again'), {
			code: 'not_readable',
		});
		expect(uploadErrorFrom(err)).toEqual({
			message: 'pick it again',
			code: 'not_readable',
		});
	});

	it('drops any other code', () => {
		const err = Object.assign(new Error('nope'), {code: 'EPIPE'});
		expect(uploadErrorFrom(err)).toEqual({message: 'nope'});
	});

	it('falls back to a generic message', () => {
		expect(uploadErrorFrom(new Error(''))).toEqual({
			message: 'Failed to upload',
		});
		expect(uploadErrorFrom('weird')).toEqual({message: 'Failed to upload'});
	});
});
