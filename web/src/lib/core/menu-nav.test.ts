import {describe, it, expect} from 'vitest';
import {MENU_SHEET_QUERY, menuNavIndex} from './menu-nav';

describe('menu keyboard navigation', () => {
	it('ArrowDown / ArrowUp wrap around; Home / End jump', () => {
		expect(menuNavIndex(-1, 3, 'ArrowDown')).toBe(0);
		expect(menuNavIndex(0, 3, 'ArrowDown')).toBe(1);
		expect(menuNavIndex(2, 3, 'ArrowDown')).toBe(0);
		expect(menuNavIndex(-1, 3, 'ArrowUp')).toBe(2);
		expect(menuNavIndex(0, 3, 'ArrowUp')).toBe(2);
		expect(menuNavIndex(1, 3, 'Home')).toBe(0);
		expect(menuNavIndex(1, 3, 'End')).toBe(2);
	});

	it('ignores other keys and an empty menu', () => {
		expect(menuNavIndex(1, 3, 'a')).toBeNull();
		expect(menuNavIndex(1, 3, 'Tab')).toBeNull();
		expect(menuNavIndex(-1, 0, 'ArrowDown')).toBeNull();
	});

	it('the sheet / popover switch is the md breakpoint', () => {
		expect(MENU_SHEET_QUERY).toBe('(min-width: 48rem)');
	});
});
