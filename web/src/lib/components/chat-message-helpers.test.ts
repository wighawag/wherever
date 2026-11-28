import {describe, expect, it} from 'vitest';
import type {ChatMessage} from '$lib/wherever';
import {
	isFirstClassTool,
	messageLayout,
	parseToolMessage,
	shouldAutoExpand,
	toolChipStatus,
	toolDuration,
} from './chat-message-helpers';

function msg(partial: Partial<ChatMessage>): ChatMessage {
	return {
		id: 'm1',
		role: 'assistant',
		content: '',
		timestamp: 0,
		...partial,
	} as ChatMessage;
}

describe('messageLayout', () => {
	it('renders assistant text as a full-width document, never a bubble', () => {
		expect(messageLayout(msg({role: 'assistant', content: 'hi'}), false)).toBe(
			'document',
		);
	});

	it('renders the user as a compact bubble', () => {
		expect(messageLayout(msg({role: 'user', content: 'hi'}), false)).toBe(
			'bubble',
		);
	});

	it('renders a generic tool call as a one-line chip', () => {
		expect(messageLayout(msg({role: 'tool', toolName: 'bash'}), false)).toBe(
			'chip',
		);
	});

	it('keeps first-class tools (attach_file, say) as cards', () => {
		expect(
			messageLayout(msg({role: 'tool', toolName: 'attach_file'}), false),
		).toBe('card');
		expect(messageLayout(msg({role: 'tool', toolName: 'say'}), true)).toBe(
			'card',
		);
	});

	it('keeps the hide-tools "Running tool" row as a card', () => {
		expect(messageLayout(msg({role: 'tool', toolName: 'bash'}), true)).toBe(
			'card',
		);
	});

	it('still renders a !command as a chip under hide-tools', () => {
		expect(
			messageLayout(
				msg({role: 'tool', toolName: 'bash', forceCommand: true}),
				true,
			),
		).toBe('chip');
	});

	it('keeps thinking and shipmates as cards', () => {
		expect(messageLayout(msg({role: 'thinking'}), false)).toBe('card');
		expect(messageLayout(msg({role: 'shipmates'}), false)).toBe('card');
	});
});

describe('toolChipStatus', () => {
	it('is running while the tool streams', () => {
		expect(toolChipStatus({isStreaming: true}, {isError: false})).toBe(
			'running',
		);
	});

	it('is error when the tool failed', () => {
		expect(toolChipStatus({isStreaming: false}, {isError: true})).toBe('error');
	});

	it('is interrupted when the tool ended with no result', () => {
		expect(
			toolChipStatus({isStreaming: false}, {isError: false, interrupted: true}),
		).toBe('interrupted');
	});

	it('is done otherwise', () => {
		expect(toolChipStatus({isStreaming: false}, {isError: false})).toBe('done');
	});
});

describe('existing tool helpers', () => {
	it('isFirstClassTool is only attach_file, say and human_ask', () => {
		expect(isFirstClassTool('attach_file')).toBe(true);
		expect(isFirstClassTool('say')).toBe(true);
		expect(isFirstClassTool('human_ask')).toBe(true);
		expect(isFirstClassTool('bash')).toBe(false);
		expect(isFirstClassTool(undefined)).toBe(false);
	});

	it('shouldAutoExpand opens a !command and nothing else', () => {
		const force = msg({role: 'tool', toolName: 'bash', forceCommand: true});
		const agent = msg({role: 'tool', toolName: 'bash'});
		expect(shouldAutoExpand(force, [force])).toBe(true);
		expect(shouldAutoExpand(agent, [agent])).toBe(false);
	});

	it('toolDuration formats seconds and is null without timing', () => {
		expect(
			toolDuration(msg({role: 'tool', startedAt: 1000, endedAt: 2500}), 0),
		).toBe('1.5s');
		expect(toolDuration(msg({role: 'tool'}), 0)).toBe(null);
	});
});

describe('parseToolMessage args', () => {
	// Exactly how the client builds a live `tool_start`'s toolArgs.
	const liveArgs = (args: Record<string, unknown>) =>
		Object.entries(args)
			.filter(([, v]) => v !== undefined && v !== '')
			.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
			.join(' ');

	it('decodes a live human_ask: escaped question, options with spaces, blocking', () => {
		const args = {
			question: 'Line 1\n"two" and a=b',
			options: ['yes, publish', 'no'],
			blocking: false,
		};
		const parsed = parseToolMessage(
			msg({role: 'tool', toolName: 'human_ask', toolArgs: liveArgs(args)}),
		);
		expect(parsed.humanAsk).toEqual(args);
	});

	it('reads the same human_ask from JSON args (history)', () => {
		const args = {question: 'Q?', options: ['a'], blocking: true};
		const parsed = parseToolMessage(
			msg({
				role: 'tool',
				toolName: 'human_ask',
				toolArgs: JSON.stringify(args),
			}),
		);
		expect(parsed.humanAsk).toEqual(args);
	});

	it('keeps bare and single-quoted k=v values as text', () => {
		const parsed = parseToolMessage(
			msg({role: 'tool', toolName: 'say', toolArgs: "text='hi there' n=3"}),
		);
		expect(parsed.sayText).toBe('hi there');
	});
});
