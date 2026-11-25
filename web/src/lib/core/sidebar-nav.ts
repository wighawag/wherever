/**
 * The sidebar's icon tabs and current-session line (spec
 * `sidebar-compact-layout`, stories 12 to 17). Pure, so it is unit-tested;
 * `+page.svelte` renders it.
 *
 * The tabs replace the old navigation rows and their "Back to ..." rows: a
 * tab shows the view it opens as active, and tapping the active tab goes back
 * (to the read-only page for a search opened from it, else to the main list).
 * The Assistant tab is not here: it is an action (open the assistant session),
 * not a view.
 */
import {sessionDotState, type DotState} from './state-dot';
import type {ShipmatesPresence} from './shipmates';

/** Which list the sidebar shows (`sessionView` in `+page.svelte`). */
export type SidebarView = 'main' | 'readonly' | 'search' | 'inbox';

/** The tabs that open a view. */
export type SidebarTab = 'inbox' | 'search' | 'readonly';

export interface SidebarNav {
	view: SidebarView;
	/** The search was opened from the read-only page and searches its sessions. */
	searchReadOnly: boolean;
}

/** The tab to show as active, or null on the main list. */
export function activeTab(nav: SidebarNav): SidebarTab | null {
	return nav.view === 'main' ? null : nav.view;
}

export interface TabTapResult extends SidebarNav {
	/** The read-only list must be (re)fetched, as opening that page always did. */
	fetchReadOnly: boolean;
}

/**
 * Where a tap on `tab` leads. The active tab goes back; any other tab opens its
 * view. The search tab always searches the main sessions: the read-only search
 * is the "Search these conversations" link on the read-only page.
 */
export function tapTab(nav: SidebarNav, tab: SidebarTab): TabTapResult {
	if (activeTab(nav) === tab) {
		const back = tab === 'search' && nav.searchReadOnly ? 'readonly' : 'main';
		return {view: back, searchReadOnly: false, fetchReadOnly: false};
	}
	return {
		view: tab,
		searchReadOnly: false,
		fetchReadOnly: tab === 'readonly',
	};
}

/**
 * The open session's dot on the current-session line. Its listing entry when
 * listed (as the top bar finds `currentStarred` / `currentClosed`); a session
 * this client has open is loaded, so an unlisted one is loaded-idle. This
 * client's own streaming counts as running, so the dot does not wait for the
 * listing to catch up.
 */
export function openSessionDot(input: {
	listed:
		| {isWorking?: boolean; isActive?: boolean; closed?: boolean}
		| undefined;
	streaming: boolean;
	presence: Pick<ShipmatesPresence, 'state'> | undefined;
}): DotState {
	const {listed, streaming, presence} = input;
	return sessionDotState(
		{
			isWorking: streaming || !!listed?.isWorking,
			isActive: listed ? !!listed.isActive || streaming : true,
		},
		presence,
		!!listed?.closed,
	);
}
