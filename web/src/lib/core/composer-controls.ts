// Pure decision helpers for the pill composer (ChatInput.svelte), kept out of
// the component so they are unit-testable in the node-env vitest run.
//
// sendButtonState: the pill's right button, and whether ■ Stop shows.
//   - idle, empty pill          -> ➤ send, disabled
//   - idle, with content        -> ➤ send (disabled while sending is blocked)
//   - agent running, empty pill -> ➤ steer, disabled; ■ Stop above the pill
//   - agent running, content    -> ➤ steer; ■ Stop above the pill
//   - search mode               -> today's Search label, never a Stop
// The pill's button only ever SENDS. ■ Stop is a labelled red button in the
// row ABOVE the pill (beside "Cancel queued"), not in the pill: next to 🎤 a
// recording mic and a Stop were two red circles side by side and read as one
// control. ■ Stop follows ONLY `streaming`, exactly like the old settings-strip
// Abort (`disabled={!streaming}`): a reconnect or an upload in progress blocks
// SENDING, never stopping, and Stop is never hidden while the agent runs
// (resolved decision 1 of spec chat-compact-layout; where it sits was changed
// after the human's first use).
//
// contextRing: the small context-usage ring shown above the pill (it replaces
// the strip's "🧠 11.3% / 1.0M" label). The token formatter is injected so this
// module stays free of the chat-list helpers (and their store imports).

export interface SendButtonInput {
	/** The composer is in the empty state's web-search mode. */
	searchMode: boolean;
	/** The agent is mid-turn on the server. */
	streaming: boolean;
	/** The pill holds something to send: non-blank text or an attachment. */
	hasContent: boolean;
	/** Sending is allowed right now (connection, uploads, content all OK). */
	canSend: boolean;
}

export interface SendButtonState {
	/** The pill's rightmost button: it only ever sends. */
	primary: 'send' | 'steer' | 'search';
	primaryDisabled: boolean;
	/** Show ■ Stop (above the pill): the agent runs, outside search mode. */
	stop: boolean;
}

export function sendButtonState(input: SendButtonInput): SendButtonState {
	if (input.searchMode) {
		return {primary: 'search', primaryDisabled: !input.canSend, stop: false};
	}
	return {
		primary: input.streaming ? 'steer' : 'send',
		primaryDisabled: !input.canSend,
		stop: input.streaming,
	};
}

export interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ContextRing {
	/** The raw percentage, or null right after compaction (tokens unknown). */
	percent: number | null;
	/** How much of the ring to fill, clamped to 0..1. */
	fraction: number;
	/** The visible text, e.g. "33% of 1.0M" ("– of 1.0M" when unknown). */
	label: string;
	/** The tooltip: tokens of window. */
	title: string;
	/** Colour band: ok below 70%, warn from 70%, high from 90%. */
	tone: 'ok' | 'warn' | 'high';
}

export function contextRing(
	usage: ContextUsageLike | null | undefined,
	formatTokens: (n: number) => string,
): ContextRing | null {
	if (!usage || !usage.contextWindow) return null;
	const window = formatTokens(usage.contextWindow);
	const windowFull = usage.contextWindow.toLocaleString('en-US');
	const percent = usage.percent;
	if (percent == null) {
		return {
			percent: null,
			fraction: 0,
			label: `– of ${window}`,
			title: `Context window size: ${windowFull} tokens`,
			tone: 'ok',
		};
	}
	const fraction = Math.min(1, Math.max(0, percent / 100));
	const tokens =
		usage.tokens != null ? usage.tokens.toLocaleString('en-US') : '?';
	return {
		percent,
		fraction,
		label: `${Math.round(percent)}% of ${window}`,
		title: `${tokens} context tokens of ${windowFull} (${percent.toFixed(1)}%)`,
		tone: percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok',
	};
}
