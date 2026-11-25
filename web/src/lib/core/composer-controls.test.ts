import {describe, it, expect} from 'vitest';
import {contextRing, sendButtonState} from './composer-controls.js';

const idle = {
	searchMode: false,
	streaming: false,
	hasContent: false,
	canSend: false,
};

describe('sendButtonState', () => {
	// The pill's right button only ever SENDS (➤ send, ➤ steer, or Search).
	// ■ Stop is a labelled button in the row ABOVE the pill, away from 🎤: a
	// recording mic and a Stop were two red circles side by side.

	it('idle with an empty pill: a disabled ➤ send, no Stop', () => {
		expect(sendButtonState(idle)).toEqual({
			primary: 'send',
			primaryDisabled: true,
			stop: false,
		});
	});

	it('idle with text: an enabled ➤ send', () => {
		expect(sendButtonState({...idle, hasContent: true, canSend: true})).toEqual(
			{primary: 'send', primaryDisabled: false, stop: false},
		);
	});

	it('idle with text but sending blocked (disconnected, uploading): ➤ stays disabled', () => {
		expect(
			sendButtonState({...idle, hasContent: true, canSend: false}),
		).toEqual({primary: 'send', primaryDisabled: true, stop: false});
	});

	it('running with an empty pill: a disabled ➤ steer, and Stop above the pill', () => {
		expect(sendButtonState({...idle, streaming: true})).toEqual({
			primary: 'steer',
			primaryDisabled: true,
			stop: true,
		});
	});

	it('Stop follows only streaming, not the send gate (Abort parity)', () => {
		// canSend is false (e.g. the socket is reconnecting), yet Stop shows,
		// exactly like the old Abort button's `disabled={!streaming}`.
		const s = sendButtonState({...idle, streaming: true, canSend: false});
		expect(s.stop).toBe(true);
	});

	it('running with text: an enabled ➤ steer, Stop still above the pill', () => {
		expect(
			sendButtonState({
				...idle,
				streaming: true,
				hasContent: true,
				canSend: true,
			}),
		).toEqual({primary: 'steer', primaryDisabled: false, stop: true});
	});

	it('running with text but sending blocked: steer disabled, Stop still shown', () => {
		expect(
			sendButtonState({
				...idle,
				streaming: true,
				hasContent: true,
				canSend: false,
			}),
		).toEqual({primary: 'steer', primaryDisabled: true, stop: true});
	});

	it('search mode: the Search button, gated on canSend, never a Stop', () => {
		expect(sendButtonState({...idle, searchMode: true})).toEqual({
			primary: 'search',
			primaryDisabled: true,
			stop: false,
		});
		expect(
			sendButtonState({
				searchMode: true,
				streaming: true,
				hasContent: true,
				canSend: true,
			}),
		).toEqual({primary: 'search', primaryDisabled: false, stop: false});
	});
});

const fmt = (n: number) => `${n / 1000}K`;

describe('contextRing', () => {
	it('is null without usage or without a window size', () => {
		expect(contextRing(null, fmt)).toBeNull();
		expect(contextRing(undefined, fmt)).toBeNull();
		expect(
			contextRing({tokens: 10, contextWindow: 0, percent: 1}, fmt),
		).toBeNull();
	});

	it('rounds the label to a whole percent and fills the ring by fraction', () => {
		const r = contextRing(
			{tokens: 33_100, contextWindow: 100_000, percent: 33.1},
			fmt,
		);
		expect(r).toEqual({
			percent: 33.1,
			fraction: 0.331,
			label: '33% of 100K',
			title: '33,100 context tokens of 100,000 (33.1%)',
			tone: 'ok',
		});
	});

	it('shows a dash right after compaction, when the percent is unknown', () => {
		const r = contextRing(
			{tokens: null, contextWindow: 100_000, percent: null},
			fmt,
		);
		expect(r?.percent).toBeNull();
		expect(r?.fraction).toBe(0);
		expect(r?.label).toBe('– of 100K');
		expect(r?.title).toBe('Context window size: 100,000 tokens');
		expect(r?.tone).toBe('ok');
	});

	it('clamps the fill to the ring and warns as the window fills', () => {
		expect(
			contextRing({tokens: 1, contextWindow: 1000, percent: 75}, fmt)?.tone,
		).toBe('warn');
		const full = contextRing(
			{tokens: 1, contextWindow: 1000, percent: 120},
			fmt,
		);
		expect(full?.tone).toBe('high');
		expect(full?.fraction).toBe(1);
		expect(
			contextRing({tokens: 1, contextWindow: 1000, percent: -3}, fmt)?.fraction,
		).toBe(0);
	});
});
