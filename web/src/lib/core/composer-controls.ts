// Pure decision helpers for the pill composer (ChatInput.svelte), kept out of
// the component so they are unit-testable in the node-env vitest run.
//
// sendButtonState: which button(s) sit at the right end of the pill.
//   - idle, empty pill          -> ➤ send, disabled
//   - idle, with content        -> ➤ send (disabled while sending is blocked)
//   - agent running, empty pill -> ■ Stop only
//   - agent running, content    -> ➤ steer, with ■ Stop beside it
//   - search mode               -> today's Search label, never a Stop
// ■ Stop follows ONLY `streaming`, exactly like the old settings-strip Abort
// (`disabled={!streaming}`): a reconnect or an upload in progress blocks
// SENDING, never stopping. Resolved decision 1 of spec chat-compact-layout:
// Stop is never hidden while the agent runs.
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
	/** The pill's rightmost button. */
	primary: 'send' | 'steer' | 'stop' | 'search';
	primaryDisabled: boolean;
	/** Show a separate ■ Stop next to the primary (running with content). */
	stopBeside: boolean;
}

export function sendButtonState(input: SendButtonInput): SendButtonState {
	if (input.searchMode) {
		return {
			primary: 'search',
			primaryDisabled: !input.canSend,
			stopBeside: false,
		};
	}
	if (input.streaming) {
		if (!input.hasContent) {
			return {primary: 'stop', primaryDisabled: false, stopBeside: false};
		}
		return {
			primary: 'steer',
			primaryDisabled: !input.canSend,
			stopBeside: true,
		};
	}
	return {primary: 'send', primaryDisabled: !input.canSend, stopBeside: false};
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
