import {describe, it, expect} from 'vitest';
import {get} from 'svelte/store';
import {
	createNotificationsService,
	openNotificationTarget,
	type NavigationTarget,
} from './index';

// The FOREGROUND click of an in-app notification (a push that arrived while the
// app was visible and focused, so the service worker posted it to the page
// instead of showing a system notification). Its `navigate` is `/#<sessionId>`
// (server/src/web-push.ts). The page opens a session on `hashchange`, which
// SvelteKit's `pushState` never fires, so the click must change the hash.

/** A fake `window.location` that records what a click does to it. */
function fakeLocation(href: string): NavigationTarget & {
	assigned: string[];
	hashSets: string[];
} {
	const url = new URL(href);
	const loc = {
		assigned: [] as string[],
		hashSets: [] as string[],
		get href() {
			return url.href;
		},
		get origin() {
			return url.origin;
		},
		get pathname() {
			return url.pathname;
		},
		get hash() {
			return url.hash;
		},
		set hash(v: string) {
			loc.hashSets.push(v);
			url.hash = v;
		},
		assign(to: string) {
			loc.assigned.push(to);
		},
	};
	return loc;
}

describe('openNotificationTarget', () => {
	it('a /#<sessionId> target on the app page sets the hash (fires hashchange)', () => {
		const loc = fakeLocation('https://me.example/#old-session');
		openNotificationTarget('/#abc-123', loc);
		expect(loc.hashSets).toEqual(['#abc-123']);
		expect(loc.assigned).toEqual([]);
	});

	it('works from the empty home page too', () => {
		const loc = fakeLocation('https://me.example/');
		openNotificationTarget('/#abc-123', loc);
		expect(loc.hash).toBe('#abc-123');
	});

	it('a bare #<sessionId> also stays in the page', () => {
		const loc = fakeLocation('https://me.example/');
		openNotificationTarget('#s1', loc);
		expect(loc.hashSets).toEqual(['#s1']);
	});

	it('a target on another page or origin is a real navigation', () => {
		const loc = fakeLocation('https://me.example/');
		openNotificationTarget('/other/#x', loc);
		openNotificationTarget('https://elsewhere.example/#x', loc);
		expect(loc.hashSets).toEqual([]);
		expect(loc.assigned).toEqual([
			'https://me.example/other/#x',
			'https://elsewhere.example/#x',
		]);
	});
});

describe('the in-app notification click', () => {
	it('opens the navigate target and removes the notification', () => {
		const loc = fakeLocation('https://me.example/#coding');
		const service = createNotificationsService(() => loc);
		service.add({
			type: 'push-notification',
			data: {
				title: 'code: Deploy finished',
				options: {body: 'all green', data: {navigate: '/#target-session'}},
			},
		});
		const [n] = get(service);
		service.onClick(n!.id);
		expect(loc.hash).toBe('#target-session');
		expect(get(service)).toEqual([]);
	});

	it('a notification without a target only closes', () => {
		const loc = fakeLocation('https://me.example/#coding');
		const service = createNotificationsService(() => loc);
		service.add({
			type: 'push-notification',
			data: {title: 'hi', options: {body: 'x'}},
		});
		service.onClick(get(service)[0]!.id);
		expect(loc.hashSets).toEqual([]);
		expect(loc.assigned).toEqual([]);
		expect(get(service)).toEqual([]);
	});
});
