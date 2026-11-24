import {describe, it, expect} from 'vitest';
import {ownedChipLabel, relativeTime, rowNestMarker} from './session-row';

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
