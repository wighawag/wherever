// The phone row swipe of `SessionRow.svelte` (spec `sidebar-compact-layout`,
// stories 37 and 38): swipe an open row of the main list left to reveal
// "⊘ Close"; release past the button to close it (through `closeSession`, so
// the cascade prompt and the Undo banner still apply). Pure, so the gesture's
// decisions are unit-tested; the component only feeds pointer deltas in.
//
// The thresholds are named so the phone device pass (`sidebar-phone-device-pass`)
// can tune them in one place.
//
// Release outcome (decided here, see
// work/notes/observations/session-row-swipe-to-close-decisions.md): past the
// button's width closes; past half of it the row stays revealed so "⊘ Close"
// can be tapped; under that it snaps back. Without the middle band "tap the
// revealed button" could never happen, since the finger is still down while
// the button shows.

/** Width of the revealed "⊘ Close" button behind the row (mockup: 86px). */
export const SWIPE_ACTION_WIDTH_PX = 86;

/** Released at least this far left: the session closes. */
export const SWIPE_CLOSE_PX = SWIPE_ACTION_WIDTH_PX;

/** Released at least this far left (but not past the button): stays revealed. */
export const SWIPE_KEEP_REVEALED_PX = Math.round(SWIPE_ACTION_WIDTH_PX / 2);

/** Movement under this distance (px) decides nothing yet. */
export const SWIPE_SLOP_PX = 8;

/**
 * A row swipe needs the horizontal movement to be at least this many times
 * the vertical one ("clearly more horizontal than vertical").
 */
export const SWIPE_DIRECTION_RATIO = 1.5;

/** How long the row takes to snap back or settle, in ms (CSS transition). */
export const SWIPE_SETTLE_MS = 180;

/**
 * Where a gesture stands: `pending` until it moves past the slop, then
 * `swipe` (the row follows the finger) or `pass` (left to the browser, a
 * vertical scroll or anything else), held for the rest of the gesture.
 */
export type SwipeDecision = 'pending' | 'swipe' | 'pass';

/**
 * Classify a movement (`dx`, `dy` from the pointerdown, in px) on its own:
 * `swipe` only when it is leftward, past the slop and clearly more horizontal
 * than vertical; `pass` for anything else past the slop.
 */
export function classifySwipe(dx: number, dy: number): SwipeDecision {
	if (Math.hypot(dx, dy) < SWIPE_SLOP_PX) return 'pending';
	if (dx < 0 && Math.abs(dx) >= SWIPE_DIRECTION_RATIO * Math.abs(dy))
		return 'swipe';
	return 'pass';
}

/** The gesture's decision after a move: once decided, it holds. */
export function nextSwipeDecision(
	current: SwipeDecision,
	dx: number,
	dy: number,
): SwipeDecision {
	return current === 'pending' ? classifySwipe(dx, dy) : current;
}

/** The row's translateX while swiping: follows the finger, from 0 to -max. */
export function swipeOffset(dx: number, max: number): number {
	return Math.max(-Math.abs(max), Math.min(0, dx));
}

export type SwipeRelease = 'close' | 'reveal' | 'snap-back';

/** What releasing the row at `offset` (its translateX, <= 0) does. */
export function swipeRelease(offset: number): SwipeRelease {
	const distance = -offset;
	if (distance >= SWIPE_CLOSE_PX) return 'close';
	if (distance >= SWIPE_KEEP_REVEALED_PX) return 'reveal';
	return 'snap-back';
}

/** Only an open row of the main list swipes (not a closed or read-only one). */
export function rowCanSwipe(opts: {
	readOnly: boolean;
	closed: boolean;
}): boolean {
	return !opts.readOnly && !opts.closed;
}
