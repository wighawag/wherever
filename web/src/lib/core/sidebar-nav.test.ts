import {describe, it, expect} from 'vitest';
import {
	activeTab,
	openSessionDot,
	tapTab,
	type SidebarNav,
} from './sidebar-nav';

const nav = (view: SidebarNav['view'], searchReadOnly = false): SidebarNav => ({
	view,
	searchReadOnly,
});

describe('activeTab', () => {
	it('is none on the main list', () => {
		expect(activeTab(nav('main'))).toBe(null);
	});
	it('names the view for inbox, search and read-only', () => {
		expect(activeTab(nav('inbox'))).toBe('inbox');
		expect(activeTab(nav('search'))).toBe('search');
		expect(activeTab(nav('readonly'))).toBe('readonly');
	});
	it('is search for a search opened from the read-only page', () => {
		expect(activeTab(nav('search', true))).toBe('search');
	});
});

describe('tapTab', () => {
	it('opens an inactive tab from the main list', () => {
		expect(tapTab(nav('main'), 'inbox')).toEqual({
			view: 'inbox',
			searchReadOnly: false,
			fetchReadOnly: false,
		});
		expect(tapTab(nav('main'), 'search')).toEqual({
			view: 'search',
			searchReadOnly: false,
			fetchReadOnly: false,
		});
	});
	it('fetches the read-only list when opening the read-only tab', () => {
		expect(tapTab(nav('main'), 'readonly')).toEqual({
			view: 'readonly',
			searchReadOnly: false,
			fetchReadOnly: true,
		});
	});
	it('returns to the main list when the active tab is tapped', () => {
		for (const view of ['inbox', 'search', 'readonly'] as const) {
			expect(tapTab(nav(view), view)).toEqual({
				view: 'main',
				searchReadOnly: false,
				fetchReadOnly: false,
			});
		}
	});
	it('returns to the read-only page from a read-only search', () => {
		expect(tapTab(nav('search', true), 'search')).toEqual({
			view: 'readonly',
			searchReadOnly: false,
			fetchReadOnly: false,
		});
	});
	it('the search tab searches the main sessions even from the read-only page', () => {
		expect(tapTab(nav('readonly'), 'search')).toEqual({
			view: 'search',
			searchReadOnly: false,
			fetchReadOnly: false,
		});
	});
	it('switches between tabs directly', () => {
		expect(tapTab(nav('inbox'), 'readonly').view).toBe('readonly');
		expect(tapTab(nav('search', true), 'readonly')).toEqual({
			view: 'readonly',
			searchReadOnly: false,
			fetchReadOnly: true,
		});
		expect(tapTab(nav('search', true), 'inbox').view).toBe('inbox');
	});
});

describe('openSessionDot', () => {
	it('uses the listing entry when the open session is listed', () => {
		expect(
			openSessionDot({
				listed: {isWorking: false, isActive: true, closed: false},
				streaming: false,
				presence: undefined,
			}),
		).toBe('idle');
		expect(
			openSessionDot({
				listed: {isWorking: false, isActive: true, closed: true},
				streaming: false,
				presence: undefined,
			}),
		).toBe('closed');
	});
	it('is running while this client streams, even before the listing catches up', () => {
		expect(
			openSessionDot({
				listed: {isWorking: false, isActive: true, closed: false},
				streaming: true,
				presence: undefined,
			}),
		).toBe('running');
		expect(
			openSessionDot({listed: undefined, streaming: true, presence: undefined}),
		).toBe('running');
	});
	it('is loaded-idle for an open session not in the listing yet', () => {
		expect(
			openSessionDot({
				listed: undefined,
				streaming: false,
				presence: undefined,
			}),
		).toBe('idle');
	});
	it('shows the presence states first', () => {
		expect(
			openSessionDot({
				listed: {isWorking: true, isActive: true, closed: true},
				streaming: true,
				presence: {state: 'waiting-for-human'},
			}),
		).toBe('waiting-for-human');
		expect(
			openSessionDot({
				listed: undefined,
				streaming: false,
				presence: {state: 'waiting-for-session'},
			}),
		).toBe('waiting-for-session');
	});
});
