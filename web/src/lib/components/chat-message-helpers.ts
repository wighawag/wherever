// Pure (non-reactive) helpers for ChatMessageList.svelte.
//
// Everything here is free of Svelte runes and DOM/lifecycle state, so it can be
// unit-tested in isolation and kept out of the .svelte file. Reactive glue
// (effects, $derived, $state) stays in the component; this module holds only the
// logic. Per the project convention: NO .svelte.ts/.svelte.js modules — this is a
// plain .ts module, and rendering caches are module-level Maps (shared across the
// single chat list, which is the intended memoization scope).

import {renderMarkdown, linkifyText} from '$lib/core/utils/markdown';
import {extractDownloadablePath} from '$lib/core/media-kind';
import {extractSayText} from '$lib/core/speak';
import {extractHumanAskArgs} from '$lib/core/human-ask-card';
import {parseSkillInvocation, type ChatMessage} from '$lib/wherever';

// The piState slice that drives message filtering. Kept structural (no import of
// the store) so this stays a pure function of its arguments.
export interface FilterOpts {
	hideThinking: boolean;
	hideTools: boolean;
}

// --- Rendering (memoized) -------------------------------------------------

// Memoize rendered markdown per (message id + content length) so a finalized
// assistant message is parsed once and its DOM stays stable afterwards. A
// stable node is what lets a text selection survive (re-parsing on every
// keystroke would collapse the selection, the bug this fixes). Streaming
// messages are NOT rendered as markdown -- they show plain text until final.
const markdownCache = new Map<string, string>();
export function renderAssistant(id: string, content: string): string {
	const key = `${id}:${content.length}`;
	let cached = markdownCache.get(key);
	if (cached === undefined) {
		cached = renderMarkdown(content);
		markdownCache.set(key, cached);
	}
	return cached;
}

// Link-only rendering for user messages: bare URLs become clickable, but the
// user's literal characters (asterisks, backticks) are NOT reinterpreted as
// markdown. Memoized on the cleaned content so the DOM stays stable.
const linkifyCache = new Map<string, string>();
export function renderUser(content: string): string {
	let cached = linkifyCache.get(content);
	if (cached === undefined) {
		cached = linkifyText(content);
		linkifyCache.set(content, cached);
	}
	return cached;
}

// --- Formatting -----------------------------------------------------------

// Context-window usage indicator, shown next to the Hide Thinking/Tools
// toggles. Humanize like the pi CLI: 1_000_000 -> "1.0M", 128_000 -> "128K".
export function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return (m >= 10 ? Math.round(m).toString() : m.toFixed(1)) + 'M';
	}
	if (n >= 1_000) return Math.round(n / 1_000) + 'K';
	return String(n);
}

export function formatTime(timestamp: number) {
	return new Date(timestamp).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
	});
}

// `/skill:<name> <args>` invocations are recovered from either their raw or
// their expanded (server-stored) form via the shared parseSkillInvocation()
// (see @wherever-dev/client), so the composer echo and history reloads render
// the same compact skill chip.
export function parseUserMessage(content: string) {
	if (!content) return {cleanContent: '', attachments: [], skill: null};
	const skill = parseSkillInvocation(content);
	if (skill) return {cleanContent: '', attachments: [], skill};
	const lines = content.split('\n');
	const fileRegex = /^\[Uploaded file: (.+)\]$/;
	const cleanLines: string[] = [];
	const attachments: string[] = [];

	for (const line of lines) {
		const match = line.match(fileRegex);
		if (match) {
			attachments.push(match[1]);
		} else {
			cleanLines.push(line);
		}
	}

	let cleanContent = cleanLines.join('\n').trim();
	if (cleanContent === 'I have uploaded the following file(s) for you:') {
		cleanContent = '';
	}
	return {cleanContent, attachments, skill: null};
}

// --- Tool message parsing -------------------------------------------------

function parseArgsObject(
	argsStr: string | undefined,
): Record<string, any> | null {
	if (!argsStr) return null;
	const trimmed = argsStr.trim();
	if (!trimmed) return null;

	// If it's JSON
	if (trimmed.startsWith('{')) {
		try {
			return JSON.parse(trimmed);
		} catch (e) {}
	}

	// The k=v format: the client's live `tool_start` writes each value as
	// `k=${JSON.stringify(v)}`, so a value is scanned as ONE JSON value (a string
	// with its escapes, an array or object with spaces inside) and decoded. A
	// 'single-quoted' or bare value that is not JSON is kept as its text.
	const obj: Record<string, any> = {};
	const keyRe = /([a-zA-Z0-9_-]+)\s*=\s*/y;
	let i = 0;
	while (i < trimmed.length) {
		while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
		keyRe.lastIndex = i;
		const m = keyRe.exec(trimmed);
		if (!m) {
			// Not a key: skip one token.
			while (i < trimmed.length && !/\s/.test(trimmed[i])) i++;
			continue;
		}
		i = keyRe.lastIndex;
		const end = scanArgValue(trimmed, i);
		const raw = trimmed.slice(i, end);
		obj[m[1]] = decodeArgValue(raw);
		i = end;
	}

	if (Object.keys(obj).length > 0) {
		return obj;
	}

	return null;
}

// The end (exclusive) of one k=v value starting at `start`: a quoted string
// (escapes honoured), a bracketed JSON value (strings and nesting honoured),
// or a bare token up to the next whitespace.
function scanArgValue(s: string, start: number): number {
	const c = s[start];
	if (c === '"' || c === "'") {
		let i = start + 1;
		while (i < s.length && s[i] !== c) i += s[i] === '\\' ? 2 : 1;
		return Math.min(i + 1, s.length);
	}
	if (c === '[' || c === '{') {
		let depth = 0;
		let inStr = false;
		for (let i = start; i < s.length; i++) {
			const ch = s[i];
			if (inStr) {
				if (ch === '\\') i++;
				else if (ch === '"') inStr = false;
			} else if (ch === '"') inStr = true;
			else if (ch === '[' || ch === '{') depth++;
			else if (ch === ']' || ch === '}') {
				depth--;
				if (depth === 0) return i + 1;
			}
		}
		return s.length;
	}
	let i = start;
	while (i < s.length && !/\s/.test(s[i])) i++;
	return i;
}

function decodeArgValue(raw: string): any {
	if (raw.startsWith("'"))
		return raw.slice(1, raw.endsWith("'") ? -1 : undefined);
	if (raw.startsWith('"') || raw.startsWith('[') || raw.startsWith('{')) {
		try {
			return JSON.parse(raw);
		} catch {
			// A quoted value that is not valid JSON: its text without the quotes.
			if (raw.startsWith('"'))
				return raw.slice(1, raw.endsWith('"') ? -1 : undefined);
			return raw;
		}
	}
	// A bare token stays text (a number or boolean keeps its old string form).
	return raw;
}

function getSmartTitleArgs(
	toolName: string,
	argsObj: Record<string, any> | null,
	rawArgsStr: string,
): string {
	if (!argsObj) {
		return rawArgsStr ? rawArgsStr.trim() : '';
	}

	const name = toolName.toLowerCase();

	// 1. read, write, edit, ls: show the path directly
	if (['read', 'write', 'edit', 'ls'].includes(name)) {
		const pathVal = argsObj.path || argsObj.filepath || argsObj.file;
		if (pathVal) {
			return String(pathVal);
		}
	}

	// 2. bash: show the first few characters of the command
	if (name === 'bash') {
		const cmd = argsObj.command || argsObj.cmd;
		if (cmd) {
			const cleanCmd = String(cmd).replace(/\s+/g, ' ').trim();
			return cleanCmd.length > 50 ? cleanCmd.slice(0, 47) + '...' : cleanCmd;
		}
	}

	// 3. grep: show pattern / pattern in path
	if (name === 'grep') {
		const pattern = argsObj.pattern;
		const pathVal = argsObj.path;
		if (pattern) {
			return pathVal ? `"${pattern}" in ${pathVal}` : `"${pattern}"`;
		}
	}

	// 4. find: show pattern or path
	if (name === 'find') {
		const pattern = argsObj.pattern || argsObj.path;
		if (pattern) {
			return String(pattern);
		}
	}

	// Custom tools check for common key names
	const commonPath =
		argsObj.path ||
		argsObj.filepath ||
		argsObj.file ||
		argsObj.name ||
		argsObj.query;
	if (commonPath) {
		return String(commonPath);
	}

	// Default fallback formatting for title
	return Object.entries(argsObj)
		.filter(([k, v]) => v !== undefined && v !== '')
		.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
		.join(' ');
}

function getFullArgsFormatted(
	argsObj: Record<string, any> | null,
	rawArgsStr: string,
): string {
	if (argsObj) {
		return JSON.stringify(argsObj, null, 2);
	}
	return rawArgsStr ? rawArgsStr.trim() : '';
}

// The tools that render as a FIRST-CLASS card (their own affordance, exempt
// from the "hide tools" collapse), not as a generic tool row:
//   - attach_file: an attachment the agent explicitly offered for download.
//   - say: the agent's SHORT spoken-form reply, shown as a distinct "spoken:"
//     card so its divergence from the full written reply is spottable. The
//     full reply always stays in the transcript; the say card is additive.
//   - human_ask: a question for the human, shown with its options as buttons
//     that answer it (HumanAskCard.svelte), like the Needs you inbox does.
export function isFirstClassTool(toolName: string | undefined): boolean {
	return (
		toolName === 'attach_file' || toolName === 'say' || toolName === 'human_ask'
	);
}

// True when `msg` is a bash tool call produced by a user `!command` /
// `!!command` (a "force command"), as opposed to one the agent issued. The
// server marks these explicitly (`forceCommand`) both live (tool_start) and in
// reloaded history (the bashExecution -> tool_call mapping), so this is an
// unambiguous per-message flag: no structural inference, and it works
// correctly for back-to-back `!command`s and after a reload.
export function isAssociatedWithForceCommand(msg: ChatMessage): boolean {
	return msg.role === 'tool' && msg.forceCommand === true;
}

// How a message is laid out in the chat column (spec chat-compact-layout,
// stories 25 to 28):
//   - 'document': assistant text, full column width, no bubble chrome.
//   - 'bubble':   the user's own message, a compact right-aligned bubble.
//   - 'chip':     a generic tool call, a one-line chip that expands on tap.
//   - 'card':     everything that keeps its own card: thinking blocks, the
//                 shipmates card, first-class tools (attach_file, say) and the
//                 hide-tools "Running tool" row (a `!command` stays a chip there,
//                 since hide-tools never hides it).
export type MessageLayout = 'document' | 'bubble' | 'chip' | 'card';
export function messageLayout(
	msg: ChatMessage,
	hideTools: boolean,
): MessageLayout {
	if (msg.role === 'assistant') return 'document';
	if (msg.role === 'user') return 'bubble';
	if (msg.role === 'tool') {
		if (isFirstClassTool(msg.toolName)) return 'card';
		if (hideTools && !isAssociatedWithForceCommand(msg)) return 'card';
		return 'chip';
	}
	return 'card';
}

// The status a tool chip shows in front of its name. `interrupted` is a tool
// that ended with no result (e.g. killed by a CLI takeover): outcome unknown.
export type ToolChipStatus = 'running' | 'error' | 'interrupted' | 'done';
export function toolChipStatus(
	msg: {isStreaming?: boolean},
	parsed: {isError: boolean; interrupted?: boolean},
): ToolChipStatus {
	if (msg.isStreaming) return 'running';
	if (parsed.isError) return 'error';
	if (parsed.interrupted) return 'interrupted';
	return 'done';
}

export function shouldAutoExpand(
	msg: ChatMessage,
	list: ChatMessage[],
): boolean {
	return isAssociatedWithForceCommand(msg);
}

export function parseToolMessage(msg: ChatMessage) {
	let toolName = msg.toolName || 'tool';
	let toolArgs = msg.toolArgs !== undefined ? msg.toolArgs : '';
	let toolOutput = msg.toolOutput !== undefined ? msg.toolOutput : '';
	let isError = !!msg.isError;

	// If we don't have toolArgs or toolOutput, or if they are empty but msg.content is populated,
	// let's parse from content to be absolutely sure we get any args embedded in the raw text.
	if (!toolArgs && !toolOutput && msg.content) {
		let content = msg.content || '';

		if (content.startsWith('Error: ')) {
			isError = true;
			content = content.slice(7);
		} else if (content.startsWith('Tool error: ')) {
			isError = true;
			content = content.slice(12);
		}

		const firstLineBreak = content.indexOf('\n');
		const headerLine =
			firstLineBreak !== -1 ? content.slice(0, firstLineBreak) : content;
		toolOutput = firstLineBreak !== -1 ? content.slice(firstLineBreak + 1) : '';

		let header = headerLine.trim();
		if (header.startsWith('$ ')) {
			header = header.slice(2);
		}

		const firstSpace = header.indexOf(' ');
		toolName =
			msg.toolName ||
			(firstSpace !== -1 ? header.slice(0, firstSpace) : header) ||
			'tool';
		toolArgs = firstSpace !== -1 ? header.slice(firstSpace + 1) : '';
	}

	const argsObj = parseArgsObject(toolArgs);
	const smartTitleArgs = getSmartTitleArgs(toolName, argsObj, toolArgs);
	const fullArgs = getFullArgsFormatted(argsObj, toolArgs);

	return {
		toolName,
		smartTitleArgs,
		fullArgs,
		toolOutput,
		isError,
		// A tool call that ended with no result (e.g. killed by a CLI takeover).
		// Outcome unknown: render a neutral "interrupted" state, not success.
		interrupted: !!msg.interrupted,
		// The path of a single file this tool operated on, when it is a
		// file-oriented tool. Drives the per-tool download button + inline
		// preview. Narrowed to two tools (see extractDownloadablePath):
		//   - `attach_file`: the agent EXPLICITLY offered this file for download
		//     (the intended, agent-driven path, e.g. "give me the gpx").
		//   - `read`: the card already carries the exact path the agent read,
		//     so we offer it opportunistically too.
		// `write`/`edit` (a download of a just-written file is noise) and
		// `ls`/`grep`/`find` (directory/search scope) are excluded. Suppressed
		// on errors.
		downloadPath: extractDownloadablePath(toolName, argsObj, isError),
		// The short spoken-form text from a `say` tool call's args ({ text }).
		// Drives the first-class "spoken:" card AND the browser TTS off the SAME
		// extracted text (see core/speak.ts), so what is shown and what is
		// spoken cannot diverge. Null for non-say tools or a blank/missing text.
		sayText: toolName === 'say' ? extractSayText(argsObj) : null,
		// The question, options and blocking flag of a `human_ask` call: drives
		// the first-class question card. Null for other tools or no question.
		humanAsk: toolName === 'human_ask' ? extractHumanAskArgs(argsObj) : null,
	};
}

// Format a tool call's run duration the way the pi CLI does: "N.Ns" (one
// decimal). While running, count from startedAt to the live `now`; once ended,
// freeze at endedAt. Returns null when we have no start time (e.g. a tool
// reconstructed from loaded history, which carries no timing).
export function toolDuration(msg: ChatMessage, now: number): string | null {
	if (msg.startedAt === undefined) return null;
	const end = msg.endedAt ?? (msg.isStreaming ? now : undefined);
	if (end === undefined) return null;
	const ms = Math.max(0, end - msg.startedAt);
	return `${(ms / 1000).toFixed(1)}s`;
}

// --- Message-list filtering ----------------------------------------------

// The pure core of the component's `msgList` $derived: filter the raw message
// stream according to the hide-thinking/hide-tools toggles, and append a
// fallback loader bubble when the agent is streaming but no streaming node is
// present yet. `streaming` is whether the session is currently streaming a turn.
export function filterMessages(
	messages: ChatMessage[],
	opts: FilterOpts,
	streaming: boolean,
): ChatMessage[] {
	const filtered = messages.filter((msg) => {
		if (msg.role === 'thinking') {
			if (opts.hideThinking) {
				return false;
			}
		}
		if (msg.role === 'tool') {
			// attach_file (an attachment) and say (a first-class "spoken:" card)
			// render as first-class affordances, not tool noise, so they are
			// never suppressed by "hide tools".
			if (opts.hideTools && !isFirstClassTool(msg.toolName)) {
				return isAssociatedWithForceCommand(msg) || !!msg.isStreaming;
			}
		}
		return (
			(msg.role !== 'assistant' && msg.role !== 'thinking') ||
			msg.isStreaming ||
			msg.content.trim() !== ''
		);
	});

	const activeStreamExists = filtered.some((msg) => msg.isStreaming);
	if (streaming && !activeStreamExists) {
		const isThinking = messages.some(
			(msg) => msg.role === 'thinking' && msg.isStreaming,
		);
		filtered.push({
			id: 'fallback-loader-message-id',
			role: 'thinking',
			content: isThinking ? 'FALLBACK_THINKING_LOADER' : 'FALLBACK_LOADER',
			timestamp: Date.now(),
			isStreaming: true,
		});
	}

	return filtered;
}

// --- Speech helpers -------------------------------------------------------

export function speechLocale(): string {
	if (typeof localStorage === 'undefined') return '';
	return localStorage.getItem('wherever-speech-locale') || '';
}

export function lastAssistantReply(
	list: ChatMessage[],
): {id: string; text: string} | null {
	for (let i = list.length - 1; i >= 0; i--) {
		const msg = list[i];
		if (msg.role === 'user') return null; // nothing said since the human spoke
		if (msg.role !== 'assistant' || msg.isStreaming) continue;
		return {
			id: msg.id,
			text: typeof msg.content === 'string' ? msg.content : '',
		};
	}
	return null;
}

// --- Scroll math ----------------------------------------------------------

export function isScrolledToBottom(el: HTMLDivElement): boolean {
	const threshold = 20;
	return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
