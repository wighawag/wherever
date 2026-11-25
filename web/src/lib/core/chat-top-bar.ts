/**
 * The chat top bar (spec `chat-compact-layout`, stories 1 to 3): which
 * conversation is open, and what the ☰ amber dot says. Pure, so it is
 * unit-tested; `+page.svelte` renders it. The subtitle's state dot is the
 * sidebar's `openSessionDot` (core/sidebar-nav.ts), so both show the same.
 */
import {sessionListLabel, type LiveSessionLike} from './live-sessions';
import type {AnyoneWaitsForYou} from './state-dot';

/** A folder's display name: its last path segment, else the whole path. */
export function folderName(cwd: string | null | undefined): string {
	if (!cwd) return '';
	return cwd.split('/').pop() || cwd;
}

/**
 * The open session's title: its listing entry's label (name, else first
 * message, as the sidebar row), else the folder name while the session is
 * not listed yet, else "Session".
 */
export function openSessionTitle(input: {
	listed: Pick<LiveSessionLike, 'name' | 'firstMessage'> | undefined;
	cwd: string | null | undefined;
}): string {
	if (input.listed) return sessionListLabel(input.listed);
	return folderName(input.cwd) || 'Session';
}

/**
 * What waits for you, as text ("2 questions for you, 1 session waiting for
 * you"): the ☰ button's and the rail's tooltip and accessible label. Empty
 * when nothing waits.
 */
export function waitsForYouText(w: AnyoneWaitsForYou): string {
	return [
		w.inbox ? `${w.inbox} question${w.inbox === 1 ? '' : 's'} for you` : '',
		w.sessions
			? `${w.sessions} session${w.sessions === 1 ? '' : 's'} waiting for you`
			: '',
	]
		.filter(Boolean)
		.join(', ');
}
