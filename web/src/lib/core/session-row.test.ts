import {describe, it, expect} from 'vitest';
import {
	closeOwnedHint,
	ownedChipLabel,
	relativeTime,
	rowHoverAction,
	rowMenuHeaderMeta,
	rowMenuItems,
	rowMetaLine,
	rowNestMarker,
	sessionLinkUrl,
} from './session-row';

describe('relativeTime', () => {
	const now = Date.parse('2026-01-10T12:00:00Z');
	const ago = (ms: number) => new Date(now - ms).toISOString();

	it('says "just now" under a minute', () => {
		expect(relativeTime(ago(0), now)).toBe('just now');
		expect(relativeTime(ago(59_000), now)).toBe('just now');
	});

	it('counts minutes, hours, then days', () => {
		expect(relativeTime(ago(60_000), now)).toBe('1m ago');
		expect(relativeTime(ago(59 * 60_000), now)).toBe('59m ago');
		expect(relativeTime(ago(60 * 60_000), now)).toBe('1h ago');
		expect(relativeTime(ago(23 * 3_600_000 + 59 * 60_000), now)).toBe(
			'23h ago',
		);
		expect(relativeTime(ago(24 * 3_600_000), now)).toBe('1d ago');
		expect(relativeTime(ago(10 * 24 * 3_600_000), now)).toBe('10d ago');
	});
});

describe('ownedChipLabel', () => {
	it('is the name, else the truncated first message, else "session"', () => {
		expect(ownedChipLabel({name: 'N', firstMessage: 'm'})).toBe('N');
		expect(ownedChipLabel({firstMessage: 'm'})).toBe('m');
		expect(ownedChipLabel({firstMessage: ''})).toBe('session');
		expect(ownedChipLabel({firstMessage: 'x'.repeat(50)})).toBe(
			'x'.repeat(40) + '...',
		);
	});
});

describe('rowNestMarker', () => {
	it('keeps the folder view fork marker as the default', () => {
		expect(rowNestMarker('fork')).toEqual({
			title: 'Forked from the session above',
			ariaLabel: 'Forked session',
		});
	});

	it('has a spawned marker for the By-owner view', () => {
		expect(rowNestMarker('spawned')).toEqual({
			title: 'Spawned by the session above',
			ariaLabel: 'Spawned session',
		});
	});
});

describe('rowMenuItems', () => {
	it('orders a main-list row: close, star, rename, copy link, new tab, then delete apart', () => {
		expect(
			rowMenuItems({readOnly: false, closed: false, desktop: true}),
		).toEqual([
			'close',
			'star',
			'rename',
			'copy-link',
			'open-new-tab',
			'separator',
			'delete',
		]);
	});

	it('offers Reopen instead of Close on a closed row', () => {
		expect(
			rowMenuItems({readOnly: false, closed: true, desktop: true}),
		).toEqual([
			'reopen',
			'star',
			'rename',
			'copy-link',
			'open-new-tab',
			'separator',
			'delete',
		]);
	});

	it('leaves out Open in new tab on a phone', () => {
		expect(
			rowMenuItems({readOnly: false, closed: false, desktop: false}),
		).toEqual(['close', 'star', 'rename', 'copy-link', 'separator', 'delete']);
	});

	it('holds only Star, Copy link and Open in new tab on the read-only page (no Rename)', () => {
		expect(
			rowMenuItems({readOnly: true, closed: false, desktop: true}),
		).toEqual(['star', 'copy-link', 'open-new-tab']);
		expect(rowMenuItems({readOnly: true, closed: true, desktop: true})).toEqual(
			['star', 'copy-link', 'open-new-tab'],
		);
		expect(
			rowMenuItems({readOnly: true, closed: false, desktop: false}),
		).toEqual(['star', 'copy-link']);
	});
});

describe('rowHoverAction', () => {
	it('is close on an open row, reopen on a closed one, nothing read-only', () => {
		expect(rowHoverAction({readOnly: false, closed: false})).toBe('close');
		expect(rowHoverAction({readOnly: false, closed: true})).toBe('reopen');
		expect(rowHoverAction({readOnly: true, closed: false})).toBeNull();
		expect(rowHoverAction({readOnly: true, closed: true})).toBeNull();
	});
});

describe('closeOwnedHint', () => {
	it('says "and N owned" only when the close would cascade', () => {
		expect(closeOwnedHint(undefined)).toBeUndefined();
		expect(closeOwnedHint(0)).toBeUndefined();
		expect(closeOwnedHint(1)).toBe('and 1 owned');
		expect(closeOwnedHint(3)).toBe('and 3 owned');
	});
});

describe('sessionLinkUrl', () => {
	it('is the origin, the page path and #<session id>', () => {
		expect(
			sessionLinkUrl({origin: 'https://box.local:3000', pathname: '/'}, 'abc'),
		).toBe('https://box.local:3000/#abc');
	});

	it('keeps a base path', () => {
		expect(
			sessionLinkUrl(
				{origin: 'https://example.com', pathname: '/wherever/'},
				'abc',
			),
		).toBe('https://example.com/wherever/#abc');
		expect(
			sessionLinkUrl({origin: 'https://example.com', pathname: '/w'}, 'abc'),
		).toBe('https://example.com/w#abc');
	});

	it('treats an empty path as the root and encodes the id', () => {
		expect(
			sessionLinkUrl({origin: 'http://localhost', pathname: ''}, 'a b/c'),
		).toBe('http://localhost/#a%20b%2Fc');
	});
});

describe('rowMenuHeaderMeta', () => {
	it('is "folder · age · messages", without the folder when unknown', () => {
		const now = Date.parse('2026-01-10T12:00:00Z');
		const session = {
			modified: new Date(now - 6 * 3_600_000).toISOString(),
			messageCount: 235,
		};
		expect(rowMenuHeaderMeta(session, 'wherever', now)).toBe(
			'wherever · 6h ago · 235 msgs',
		);
		expect(rowMenuHeaderMeta(session, undefined, now)).toBe(
			'6h ago · 235 msgs',
		);
	});
});

describe('rowMetaLine', () => {
	const now = Date.parse('2026-01-10T12:00:00Z');
	const session = {
		modified: new Date(now - 6 * 3_600_000).toISOString(),
		messageCount: 235,
	};

	it('is "age · messages", with "owns N" only when it owns any', () => {
		expect(rowMetaLine(session, 0, now)).toBe('6h ago · 235 msgs');
		expect(rowMetaLine(session, 1, now)).toBe('6h ago · 235 msgs · owns 1');
	});
});
