/**
 * The desktop sidebar rail (spec `sidebar-compact-layout`, story 19 and
 * resolved decision 2): « in the sidebar header collapses the sidebar to a
 * thin rail, » on the rail expands it again. The collapsed state is a device
 * preference, kept in localStorage like the Live strip's collapsed state
 * (`LIVE_STRIP_COLLAPSED_KEY`): "1" when collapsed, no key when expanded.
 *
 * It only applies from the `md` breakpoint up: `+page.svelte` gates the rail
 * with `md:` classes, so the phone drawer ignores the flag entirely.
 */

/** The localStorage key holding the desktop sidebar's collapsed state. */
export const SIDEBAR_COLLAPSED_KEY = 'wherever-sidebar-collapsed';

/** The part of `Storage` the rail needs (injectable for tests). */
export type RailStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): RailStorage | undefined {
	return typeof localStorage !== 'undefined' ? localStorage : undefined;
}

/** Is the desktop sidebar collapsed to its rail on this device? Expanded by default. */
export function readSidebarCollapsed(
	storage: RailStorage | undefined = defaultStorage(),
): boolean {
	try {
		return storage?.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
	} catch {
		return false;
	}
}

/** Remember the desktop sidebar's collapsed state on this device. */
export function writeSidebarCollapsed(
	storage: RailStorage | undefined,
	collapsed: boolean,
): void {
	try {
		if (collapsed) storage?.setItem(SIDEBAR_COLLAPSED_KEY, '1');
		else storage?.removeItem(SIDEBAR_COLLAPSED_KEY);
	} catch {
		// Storage unavailable (private mode, quota): the state just is not kept.
	}
}
