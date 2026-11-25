import {describe, it, expect} from 'vitest';
import {
	beepMenuLabel,
	chatMenuSections,
	contextMenuText,
	modelMenuLabel,
	nextBeepOverride,
	versionsText,
	type ChatMenuInput,
} from './chat-session-menu.js';

const base: ChatMenuInput = {
	hasSession: true,
	readOnly: false,
	closed: false,
	desktop: false,
	hasModel: true,
	searchWeb: false,
	viewingAssistant: false,
	hasContext: true,
};

function itemsOf(input: Partial<ChatMenuInput>) {
	return Object.fromEntries(
		chatMenuSections({...base, ...input}).map((s) => [s.id, s.items]),
	);
}

describe('chatMenuSections', () => {
	it('a drivable session on the phone: actions, This chat, On this device, details', () => {
		const sections = chatMenuSections(base);
		expect(sections.map((s) => [s.id, s.title])).toEqual([
			['session', undefined],
			['this-chat', 'This chat'],
			['device', 'On this device'],
			['details', undefined],
		]);
		expect(itemsOf({})).toEqual({
			session: ['model', 'star', 'rename', 'copy-link', 'close'],
			'this-chat': ['beep', 'conversation'],
			device: ['hide-thinking', 'enter-sends', 'voice-settings'],
			details: ['context', 'versions'],
		});
	});

	it('desktop adds Open in new tab after Copy link', () => {
		expect(itemsOf({desktop: true}).session).toEqual([
			'model',
			'star',
			'rename',
			'copy-link',
			'open-new-tab',
			'close',
		]);
	});

	it('a closed session offers Reopen instead of Close', () => {
		expect(itemsOf({closed: true}).session).toContain('reopen');
		expect(itemsOf({closed: true}).session).not.toContain('close');
	});

	it('read-only: no Rename, no Close / Reopen, no Beep', () => {
		const items = itemsOf({readOnly: true, closed: true});
		expect(items.session).toEqual(['model', 'star', 'copy-link']);
		expect(items['this-chat']).toEqual(['conversation']);
	});

	it('Search the web and Reset the assistant only when they apply', () => {
		expect(itemsOf({searchWeb: true}).session).toContain('search-web');
		expect(itemsOf({viewingAssistant: true}).session).toContain(
			'reset-assistant',
		);
		expect(itemsOf({}).session).not.toContain('search-web');
		expect(itemsOf({}).session).not.toContain('reset-assistant');
	});

	it('no Model item without a model; no context line without usage', () => {
		expect(itemsOf({hasModel: false}).session).not.toContain('model');
		expect(itemsOf({hasContext: false}).details).toEqual(['versions']);
	});

	it('with no session open, only "On this device"', () => {
		const sections = chatMenuSections({
			...base,
			hasSession: false,
			searchWeb: true,
			viewingAssistant: true,
		});
		expect(sections).toEqual([
			{
				id: 'device',
				title: 'On this device',
				items: ['hide-thinking', 'enter-sends', 'voice-settings'],
			},
		]);
	});
});

describe('Beep (tri-state, as the old strip)', () => {
	it('cycles Default -> On -> Off -> Default', () => {
		expect(nextBeepOverride(undefined)).toBe(true);
		expect(nextBeepOverride(true)).toBe(false);
		expect(nextBeepOverride(false)).toBe(undefined);
	});
	it('says what Default follows', () => {
		expect(beepMenuLabel(undefined, true)).toBe('Default (on)');
		expect(beepMenuLabel(undefined, false)).toBe('Default (off)');
		expect(beepMenuLabel(true, true)).toBe('On');
		expect(beepMenuLabel(false, false)).toBe('Off');
	});
});

const fmt = (n: number) =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : String(n);

describe('contextMenuText', () => {
	it('"Context 33.1% of 1.0M"', () => {
		expect(
			contextMenuText(
				{tokens: 331_000, contextWindow: 1_000_000, percent: 33.08},
				fmt,
			),
		).toBe('Context 33.1% of 1.0M');
	});
	it('a dash right after compaction, null without usage', () => {
		expect(
			contextMenuText(
				{tokens: null, contextWindow: 1_000_000, percent: null},
				fmt,
			),
		).toBe('Context – of 1.0M');
		expect(contextMenuText(null, fmt)).toBe(null);
		expect(
			contextMenuText({tokens: 1, contextWindow: 0, percent: 1}, fmt),
		).toBe(null);
	});
});

describe('versionsText', () => {
	it('v / srv / pi, each only when known', () => {
		expect(versionsText({app: '0.29.0'})).toBe('v0.29.0');
		expect(versionsText({app: '0.29.0', server: '0.29.1'})).toBe(
			'v0.29.0 / srv 0.29.1',
		);
		expect(versionsText({app: '0.29.0', server: '0.29.1', pi: '0.70.2'})).toBe(
			'v0.29.0 / srv 0.29.1 / pi 0.70.2',
		);
	});
	it('no "v" before a dev build id', () => {
		expect(versionsText({app: 'e75a84c-dirty', server: '0.29.0'})).toBe(
			'e75a84c-dirty / srv 0.29.0',
		);
	});
});

describe('modelMenuLabel', () => {
	const models = [
		{provider: 'anthropic', modelId: 'claude-opus', label: 'Claude Opus'},
	];
	it("is the list's label for the current model, else the raw id", () => {
		expect(modelMenuLabel('anthropic:claude-opus', models)).toBe('Claude Opus');
		expect(modelMenuLabel('openai:gpt-x', models)).toBe('openai:gpt-x');
	});
});
