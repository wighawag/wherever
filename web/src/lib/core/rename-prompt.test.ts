import {describe, it, expect} from 'vitest';
import {
	normalizeSessionName,
	renamePromptAction,
	renamePromptInitial,
} from './rename-prompt';

describe('renamePromptInitial', () => {
	it('is the current name, or empty when the session has none', () => {
		expect(renamePromptInitial('My session')).toBe('My session');
		expect(renamePromptInitial(undefined)).toBe('');
		expect(renamePromptInitial('')).toBe('');
	});
});

describe('normalizeSessionName', () => {
	it('collapses whitespace runs (newlines included) and trims, as the server does', () => {
		expect(normalizeSessionName('  a   b \n c\t')).toBe('a b c');
		expect(normalizeSessionName('   ')).toBe('');
	});
});

describe('renamePromptAction', () => {
	it('saves the cleaned name', () => {
		expect(renamePromptAction('  New  name ', 'Old')).toEqual({
			kind: 'save',
			name: 'New name',
		});
		expect(renamePromptAction('First name', undefined)).toEqual({
			kind: 'save',
			name: 'First name',
		});
	});

	it('cancels on an empty (or blank) value', () => {
		expect(renamePromptAction('', 'Old')).toEqual({kind: 'cancel'});
		expect(renamePromptAction('  \n ', undefined)).toEqual({kind: 'cancel'});
	});

	it('cancels when the name is unchanged (nothing to write)', () => {
		expect(renamePromptAction('Old', 'Old')).toEqual({kind: 'cancel'});
		expect(renamePromptAction(' Old ', 'Old')).toEqual({kind: 'cancel'});
	});
});
