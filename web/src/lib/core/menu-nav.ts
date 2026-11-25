/**
 * The pure parts of the shared ⋯ menu (`components/menu/Menu.svelte`): which
 * item a navigation key moves to, and the breakpoint at which the menu stops
 * being a bottom sheet and becomes an anchored popover.
 */

/**
 * At and above this width (Tailwind's `md`) a menu is an anchored popover;
 * below it, a bottom sheet.
 */
export const MENU_SHEET_QUERY = '(min-width: 48rem)';

/**
 * The index to focus after `key` in a menu of `count` items, `current` being
 * the focused one (-1 for none), or null when the key does not navigate.
 * ArrowDown / ArrowUp wrap around; Home / End jump to the ends.
 */
export function menuNavIndex(
	current: number,
	count: number,
	key: string,
): number | null {
	if (count === 0) return null;
	switch (key) {
		case 'ArrowDown':
			return current < 0 ? 0 : (current + 1) % count;
		case 'ArrowUp':
			return current < 0 ? count - 1 : (current - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}
