/**
 * The chat top bar's ⋯ session menu (spec `chat-compact-layout` stories 5, 6,
 * 8 to 11, 13, 14): which items it shows, in which section, and the text of
 * its Beep, context and versions lines. Rendered by `ChatSessionMenu.svelte`.
 *
 * Sections, in order:
 * - session actions (no title): Model, Star / Unstar, Rename, Copy link, Open in
 *   new tab (desktop), Close / Reopen (not read-only), Search the web (when
 *   configured), Reset the assistant (when viewing it);
 * - "This chat": Beep when done (tri-state, only on a drivable session) and
 *   Conversation mode (per conversation, following the default unless set);
 * - "On this device": Hide thinking, Enter sends, Voice settings… (device-wide
 *   settings, so the section says so instead of the mockup's single "This chat");
 * - details (no title): the context usage and the versions, as text.
 *
 * With no session open only "On this device" is shown (Enter sends stays
 * reachable on the home / web-search screen); the Conversation mode DEFAULT is
 * edited in Connection Settings there.
 */

export type ChatMenuItem =
	| 'model'
	| 'star'
	| 'rename'
	| 'copy-link'
	| 'open-new-tab'
	| 'close'
	| 'reopen'
	| 'search-web'
	| 'reset-assistant'
	| 'beep'
	| 'conversation'
	| 'hide-thinking'
	| 'enter-sends'
	| 'voice-settings'
	| 'context'
	| 'versions';

export interface ChatMenuSection {
	id: 'session' | 'this-chat' | 'device' | 'details';
	/** The section's header ("This chat", "On this device"), if it has one. */
	title?: string;
	items: ChatMenuItem[];
}

export interface ChatMenuInput {
	/** A session is open. */
	hasSession: boolean;
	/** The open session is read-only (observe only). */
	readOnly: boolean;
	/** The open session is closed (offer Reopen). */
	closed: boolean;
	/** Desktop width (popover): adds Open in new tab. */
	desktop: boolean;
	/** The session reports a model (the Model item; pickable or text). */
	hasModel: boolean;
	/** Web search is configured and the socket is up (today's 🔍). */
	searchWeb: boolean;
	/** The open session is the assistant's current one, connected (↺ Reset). */
	viewingAssistant: boolean;
	/** Context usage is known (the context line). */
	hasContext: boolean;
}

const DEVICE: ChatMenuSection = {
	id: 'device',
	title: 'On this device',
	items: ['hide-thinking', 'enter-sends', 'voice-settings'],
};

export function chatMenuSections(input: ChatMenuInput): ChatMenuSection[] {
	if (!input.hasSession) return [{...DEVICE, items: [...DEVICE.items]}];

	const session: ChatMenuItem[] = [];
	if (input.hasModel) session.push('model');
	session.push('star');
	if (!input.readOnly) session.push('rename');
	session.push('copy-link');
	if (input.desktop) session.push('open-new-tab');
	if (!input.readOnly) session.push(input.closed ? 'reopen' : 'close');
	if (input.searchWeb) session.push('search-web');
	if (input.viewingAssistant) session.push('reset-assistant');

	const thisChat: ChatMenuItem[] = [];
	if (!input.readOnly) thisChat.push('beep');
	thisChat.push('conversation');

	const details: ChatMenuItem[] = [];
	if (input.hasContext) details.push('context');
	details.push('versions');

	return [
		{id: 'session', items: session},
		{id: 'this-chat', title: 'This chat', items: thisChat},
		{...DEVICE, items: [...DEVICE.items]},
		{id: 'details', items: details},
	];
}

/** Beep's next per-session choice: Default -> On -> Off -> Default. */
export function nextBeepOverride(
	override: boolean | undefined,
): boolean | undefined {
	if (override === undefined) return true;
	if (override === true) return false;
	return undefined;
}

/** "Default (on)" / "Default (off)" / "On" / "Off". */
export function beepMenuLabel(
	override: boolean | undefined,
	effectiveOn: boolean,
): string {
	if (override === undefined) return `Default (${effectiveOn ? 'on' : 'off'})`;
	return override ? 'On' : 'Off';
}

/** "Context 33.1% of 1.0M" ("Context – of 1.0M" right after compaction). */
export function contextMenuText(
	usage:
		| {tokens: number | null; contextWindow: number; percent: number | null}
		| null
		| undefined,
	formatTokens: (n: number) => string,
): string | null {
	if (!usage || !usage.contextWindow) return null;
	const window = formatTokens(usage.contextWindow);
	if (usage.percent == null) return `Context – of ${window}`;
	return `Context ${usage.percent.toFixed(1)}% of ${window}`;
}

/**
 * "v0.29.0 / srv 0.29.0 / pi 0.70.2", each part only when known. The app's
 * "v" is dropped when its build id is not a version number (a dev build's
 * commit id).
 */
export function versionsText(v: {
	app: string;
	server?: string | null;
	pi?: string | null;
}): string {
	const parts = [/^\d/.test(v.app) ? `v${v.app}` : v.app];
	if (v.server) parts.push(`srv ${v.server}`);
	if (v.pi) parts.push(`pi ${v.pi}`);
	return parts.join(' / ');
}

/** The current model's label from the model list, else its raw id. */
export function modelMenuLabel(
	model: string,
	models: ReadonlyArray<{provider: string; modelId: string; label: string}>,
): string {
	return (
		models.find((m) => `${m.provider}:${m.modelId}` === model)?.label ?? model
	);
}
