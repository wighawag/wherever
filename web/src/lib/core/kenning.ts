/**
 * kenning on the web (wherever ADR 0023): the shapes of the server's
 * `kenning_update` frame, and the pure helpers the inbox panel, its badge and
 * the session list's presence line are built from.
 *
 * Every session is named by its normalized transcript path, the same string
 * the `/sessions` listing uses as `path`, so presence joins the list by that key.
 */

export type KenningSessionState =
	| 'running'
	| 'waiting-for-human'
	| 'waiting-for-session'
	| 'idle';

export interface KenningInboxItem {
	id: string;
	question: string;
	options: string[] | null;
	blocking: boolean;
	createdAt: number;
	sessionFile: string;
	sessionId: string | null;
	from: string;
	onBehalfOf: number;
}

export interface KenningPresence {
	sessionFile: string;
	sessionId: string | null;
	roles: string[];
	state: KenningSessionState;
	status: string | null;
	waitingOn: string | null;
}

export interface KenningState {
	available: boolean;
	inbox: KenningInboxItem[];
	presence: KenningPresence[];
}

export const emptyKenningState: KenningState = {
	available: false,
	inbox: [],
	presence: [],
};

/** A `kenning_update` frame as the store keeps it; anything malformed reads as no kenning. */
export function parseKenningUpdate(frame: unknown): KenningState {
	const f = frame as Partial<KenningState> | null | undefined;
	if (!f || f.available !== true) return emptyKenningState;
	return {
		available: true,
		inbox: Array.isArray(f.inbox)
			? f.inbox.filter(
					(i): i is KenningInboxItem =>
						!!i && typeof i.id === 'string' && typeof i.question === 'string',
				)
			: [],
		presence: Array.isArray(f.presence)
			? f.presence.filter(
					(p): p is KenningPresence => !!p && typeof p.sessionFile === 'string',
				)
			: [],
	};
}

/** Presence by session file, for the session list. */
export function presenceByFile(
	presence: KenningPresence[],
): Map<string, KenningPresence> {
	return new Map(presence.map((p) => [p.sessionFile, p]));
}

const STATE_LABEL: Record<KenningSessionState, string> = {
	running: 'running',
	'waiting-for-human': 'waiting for you',
	'waiting-for-session': 'waiting on a session',
	idle: 'idle',
};

export function stateLabel(state: KenningSessionState): string {
	return STATE_LABEL[state] ?? state;
}

/**
 * The one presence line under a session in the list: its role(s), its state
 * when that says something (idle says nothing), and its own status line.
 * Empty when there is nothing worth a line.
 */
export function presenceLine(p: KenningPresence | undefined): string {
	if (!p) return '';
	const parts: string[] = [];
	if (p.roles.length) parts.push(p.roles.join(', '));
	if (p.state !== 'idle') parts.push(stateLabel(p.state));
	if (p.status) parts.push(p.status);
	return parts.join(' · ');
}

/** The badge: how many items, and whether any blocks a session. Null when the inbox is empty. */
export function inboxBadge(
	inbox: KenningInboxItem[],
): {count: number; blocking: boolean} | null {
	if (!inbox.length) return null;
	return {count: inbox.length, blocking: inbox.some((i) => i.blocking)};
}
