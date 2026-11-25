import {describe, expect, it} from 'vitest';
import {
	SIDEBAR_COLLAPSED_KEY,
	readSidebarCollapsed,
	writeSidebarCollapsed,
	type RailStorage,
} from './sidebar-rail';

function memory(initial: Record<string, string> = {}): RailStorage & {
	data: Record<string, string>;
} {
	const data = {...initial};
	return {
		data,
		getItem: (k) => (k in data ? data[k] : null),
		setItem: (k, v) => {
			data[k] = v;
		},
		removeItem: (k) => {
			delete data[k];
		},
	};
}

function throwing(): RailStorage {
	const fail = () => {
		throw new Error('SecurityError');
	};
	return {getItem: fail, setItem: fail, removeItem: fail};
}

describe('readSidebarCollapsed', () => {
	it('is expanded by default (nothing stored)', () => {
		expect(readSidebarCollapsed(memory())).toBe(false);
	});
	it('is collapsed when the key holds "1"', () => {
		expect(readSidebarCollapsed(memory({[SIDEBAR_COLLAPSED_KEY]: '1'}))).toBe(
			true,
		);
	});
	it('treats any other value as expanded', () => {
		expect(
			readSidebarCollapsed(memory({[SIDEBAR_COLLAPSED_KEY]: 'true'})),
		).toBe(false);
	});
	it('is expanded without storage or when storage throws', () => {
		expect(readSidebarCollapsed(undefined)).toBe(false);
		expect(readSidebarCollapsed(throwing())).toBe(false);
	});
});

describe('writeSidebarCollapsed', () => {
	it('stores "1" when collapsed and removes the key when expanded', () => {
		const s = memory();
		writeSidebarCollapsed(s, true);
		expect(s.data[SIDEBAR_COLLAPSED_KEY]).toBe('1');
		expect(readSidebarCollapsed(s)).toBe(true);
		writeSidebarCollapsed(s, false);
		expect(SIDEBAR_COLLAPSED_KEY in s.data).toBe(false);
		expect(readSidebarCollapsed(s)).toBe(false);
	});
	it('ignores a missing or throwing storage', () => {
		expect(() => writeSidebarCollapsed(undefined, true)).not.toThrow();
		expect(() => writeSidebarCollapsed(throwing(), true)).not.toThrow();
	});
});
