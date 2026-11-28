/**
 * The `human_ask` tool call as a first-class chat card: the question the agent
 * asked the human, its options as buttons, and (once answered) the answer.
 *
 * The card answers through the SAME path as the Needs you inbox
 * (`shipmates_answer`, channel `web`), so it needs the open inbox item the call
 * raised. A blocking call has no tool result while it waits, so the item is
 * found by its question in this session's open items; a finished call names
 * its item id (`h_...`) in its result text, which @shipmates/pi writes as:
 *
 *   - `the human answered h_x (origin human, <where>):\n<answer>`
 *   - `raised h_x in the human's inbox (not blocking). ...`
 *   - `no answer after N s; h_x stays in the human's inbox. ...`
 *   - `h_x was withdrawn`
 *   - `aborted; h_x stays in the inbox ...` / `the human dismissed the dialog; h_x stays ...`
 *
 * Pure: a function of the tool call, its result and the inbox.
 */
import type {ShipmatesInboxItem} from './shipmates';

export interface HumanAskArgs {
	question: string;
	options: string[];
	blocking: boolean;
}

/** The question, options and blocking flag from a `human_ask` call's args, or null when there is no question. */
export function extractHumanAskArgs(
	args: Record<string, unknown> | null,
): HumanAskArgs | null {
	if (!args || typeof args.question !== 'string' || !args.question.trim())
		return null;
	let options: unknown = args.options;
	// A k=v style arg string carries the array as JSON text.
	if (typeof options === 'string') {
		try {
			options = JSON.parse(options);
		} catch {
			options = [];
		}
	}
	return {
		question: args.question,
		options: Array.isArray(options)
			? options.filter((o): o is string => typeof o === 'string' && !!o)
			: [],
		blocking: args.blocking !== false && args.blocking !== 'false',
	};
}

export type HumanAskOutcome =
	| {kind: 'answered'; itemId: string; answer: string; where: string}
	| {kind: 'withdrawn'; itemId: string | null}
	/** Still open in the inbox: not blocking, timed out, aborted or dismissed. */
	| {kind: 'pending'; itemId: string | null}
	| {kind: 'unknown'};

const ITEM_ID = /\bh_[A-Za-z0-9_-]+/;

/** What a finished `human_ask` result says happened. */
export function parseHumanAskResult(output: string): HumanAskOutcome {
	const text = output ?? '';
	const answered =
		/the human answered (h_[A-Za-z0-9_-]+) \(origin human, ([^)]*)\):\n?([\s\S]*)$/.exec(
			text,
		);
	if (answered)
		return {
			kind: 'answered',
			itemId: answered[1],
			where: answered[2],
			answer: answered[3],
		};
	const id = ITEM_ID.exec(text)?.[0] ?? null;
	if (/was withdrawn/.test(text)) return {kind: 'withdrawn', itemId: id};
	if (id) return {kind: 'pending', itemId: id};
	return {kind: 'unknown'};
}

/**
 * The open inbox item this call raised, if it is still open: by id when the
 * result names one, else (a blocking call still waiting) the newest open item
 * of this session with the same question.
 */
export function findHumanAskItem(
	inbox: ShipmatesInboxItem[],
	opts: {
		itemId: string | null;
		question: string;
		sessionId: string | null;
		sessionFile: string | null;
	},
): ShipmatesInboxItem | null {
	if (opts.itemId) return inbox.find((i) => i.id === opts.itemId) ?? null;
	const mine = (i: ShipmatesInboxItem) =>
		(!!opts.sessionId && i.sessionId === opts.sessionId) ||
		(!!opts.sessionFile && i.sessionFile === opts.sessionFile);
	const candidates = inbox.filter(
		(i) => i.question === opts.question && mine(i),
	);
	if (!candidates.length) return null;
	return candidates.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
}

export type HumanAskCardState =
	/** Open in the inbox: the card can answer it. */
	| {kind: 'open'; item: ShipmatesInboxItem}
	/** Waiting, but the inbox item is not (yet) visible: show the question, no buttons. */
	| {kind: 'waiting'}
	| {kind: 'answered'; answer: string; where: string}
	| {kind: 'withdrawn'}
	/** Closed some other way (answered elsewhere after the tool returned, an older result shape). */
	| {kind: 'closed'}
	| {kind: 'error'};

export function humanAskCardState(input: {
	args: HumanAskArgs;
	isStreaming: boolean;
	isError: boolean;
	output: string;
	inbox: ShipmatesInboxItem[];
	sessionId: string | null;
	sessionFile: string | null;
}): HumanAskCardState {
	if (input.isError) return {kind: 'error'};
	const outcome: HumanAskOutcome = input.isStreaming
		? {kind: 'pending', itemId: null}
		: parseHumanAskResult(input.output);
	if (outcome.kind === 'answered')
		return {kind: 'answered', answer: outcome.answer, where: outcome.where};
	if (outcome.kind === 'withdrawn') return {kind: 'withdrawn'};
	// Only a waiting call (or one whose result names its item) may match the
	// inbox: an old finished call with the same question must not grab a newer one.
	const itemId = outcome.kind === 'pending' ? outcome.itemId : null;
	if (!input.isStreaming && !itemId) return {kind: 'closed'};
	const item = findHumanAskItem(input.inbox, {
		itemId,
		question: input.args.question,
		sessionId: input.sessionId,
		sessionFile: input.sessionFile,
	});
	if (item) return {kind: 'open', item};
	return input.isStreaming ? {kind: 'waiting'} : {kind: 'closed'};
}
