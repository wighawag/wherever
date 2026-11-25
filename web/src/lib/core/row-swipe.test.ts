import {describe, expect, it} from 'vitest';
import {
	SWIPE_ACTION_WIDTH_PX,
	SWIPE_CLOSE_PX,
	SWIPE_KEEP_REVEALED_PX,
	SWIPE_SLOP_PX,
	classifySwipe,
	nextSwipeDecision,
	rowCanSwipe,
	swipeOffset,
	swipeRelease,
} from './row-swipe';

describe('classifySwipe', () => {
	it('is a row swipe for a clear leftward move past the slop', () => {
		expect(classifySwipe(-SWIPE_SLOP_PX - 2, 0)).toBe('swipe');
		expect(classifySwipe(-30, 4)).toBe('swipe');
		expect(classifySwipe(-30, -4)).toBe('swipe');
	});

	it('leaves a rightward move to the browser', () => {
		expect(classifySwipe(SWIPE_SLOP_PX + 2, 0)).toBe('pass');
		expect(classifySwipe(40, 2)).toBe('pass');
	});

	it('leaves a vertical move (a scroll) to the browser', () => {
		expect(classifySwipe(0, 20)).toBe('pass');
		expect(classifySwipe(-2, -30)).toBe('pass');
	});

	it('leaves a diagonal move to the browser', () => {
		expect(classifySwipe(-20, 20)).toBe('pass');
		expect(classifySwipe(-20, -15)).toBe('pass');
	});

	it('is undecided under the slop', () => {
		expect(classifySwipe(0, 0)).toBe('pending');
		expect(classifySwipe(-SWIPE_SLOP_PX + 1, 0)).toBe('pending');
		expect(classifySwipe(3, -3)).toBe('pending');
	});
});

describe('nextSwipeDecision', () => {
	it('decides from the first movement past the slop', () => {
		let d = nextSwipeDecision('pending', -3, 0);
		expect(d).toBe('pending');
		d = nextSwipeDecision(d, -20, 1);
		expect(d).toBe('swipe');
	});

	it('keeps a swipe a swipe for the whole gesture', () => {
		expect(nextSwipeDecision('swipe', 0, 80)).toBe('swipe');
		expect(nextSwipeDecision('swipe', 50, 0)).toBe('swipe');
	});

	it('keeps a pass a pass for the whole gesture', () => {
		const d = nextSwipeDecision('pending', 0, 30);
		expect(d).toBe('pass');
		expect(nextSwipeDecision(d, -100, 30)).toBe('pass');
	});
});

describe('swipeOffset', () => {
	it('follows the finger leftward', () => {
		expect(swipeOffset(-40, 300)).toBe(-40);
	});
	it('never goes right of rest', () => {
		expect(swipeOffset(25, 300)).toBe(0);
	});
	it('stops at the row width', () => {
		expect(swipeOffset(-500, 300)).toBe(-300);
	});
});

describe('swipeRelease', () => {
	it('closes once released past the button', () => {
		expect(SWIPE_CLOSE_PX).toBe(SWIPE_ACTION_WIDTH_PX);
		expect(swipeRelease(-SWIPE_CLOSE_PX)).toBe('close');
		expect(swipeRelease(-200)).toBe('close');
	});
	it('stays revealed between the keep threshold and the button', () => {
		expect(swipeRelease(-SWIPE_KEEP_REVEALED_PX)).toBe('reveal');
		expect(swipeRelease(-SWIPE_CLOSE_PX + 1)).toBe('reveal');
	});
	it('snaps back before that', () => {
		expect(swipeRelease(0)).toBe('snap-back');
		expect(swipeRelease(-SWIPE_KEEP_REVEALED_PX + 1)).toBe('snap-back');
	});
});

describe('rowCanSwipe', () => {
	it('is only for open rows of the main list', () => {
		expect(rowCanSwipe({readOnly: false, closed: false})).toBe(true);
		expect(rowCanSwipe({readOnly: false, closed: true})).toBe(false);
		expect(rowCanSwipe({readOnly: true, closed: false})).toBe(false);
		expect(rowCanSwipe({readOnly: true, closed: true})).toBe(false);
	});
});
