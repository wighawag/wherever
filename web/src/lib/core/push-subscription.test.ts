import {describe, it, expect} from 'vitest';
import {
	isThisDeviceSubscribed,
	pushSupported,
	subscribeThisDevice,
	unsubscribeThisDevice,
	urlB64ToUint8Array,
	type DevicePushManager,
	type DevicePushSubscription,
	type PushServerDeps,
} from './push-subscription';

// The settings toggle's logic: subscribe THIS device with the server's VAPID key
// and register it on the token-gated /push/subscription; unsubscribe it again.

const KEY =
	'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';

function fakeSub(
	endpoint: string,
	key: Uint8Array | null,
): DevicePushSubscription & {unsubscribed: boolean} {
	const s = {
		endpoint,
		unsubscribed: false,
		options: {applicationServerKey: key ? key.slice().buffer : null},
		toJSON: () => ({endpoint, keys: {p256dh: 'p', auth: 'a'}}),
		unsubscribe: async () => {
			s.unsubscribed = true;
			return true;
		},
	};
	return s;
}

function fakeManager(initial: DevicePushSubscription | null) {
	let current = initial;
	const subscribed: Uint8Array[] = [];
	const pm: DevicePushManager = {
		getSubscription: async () => current,
		subscribe: async ({applicationServerKey}) => {
			subscribed.push(applicationServerKey);
			current = fakeSub('https://push.example/new', applicationServerKey);
			return current;
		},
	};
	return {pm, subscribed, current: () => current};
}

function fakeServer(answers: Record<string, unknown> = {}) {
	const calls: Array<{url: string; method: string; body?: unknown}> = [];
	const deps: PushServerDeps = {
		baseUrl: 'https://me.example',
		token: 'sekret',
		fetch: async (url, init) => {
			const method = init?.method ?? 'GET';
			calls.push({
				url,
				method,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			const path = new URL(url).pathname;
			const body = answers[`${method} ${path}`] ?? {};
			return new Response(JSON.stringify(body), {status: 200});
		},
	};
	return {deps, calls};
}

describe('subscribeThisDevice', () => {
	it('subscribes with the server key and registers the subscription, token attached', async () => {
		const {pm, subscribed} = fakeManager(null);
		const {deps, calls} = fakeServer({
			'GET /push/vapid-public-key': {publicKey: KEY},
		});
		await subscribeThisDevice(pm, deps);
		expect(subscribed).toEqual([urlB64ToUint8Array(KEY)]);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			'GET https://me.example/push/vapid-public-key?token=sekret',
			'POST https://me.example/push/subscription?token=sekret',
		]);
		expect(calls[1]!.body).toEqual({
			endpoint: 'https://push.example/new',
			keys: {p256dh: 'p', auth: 'a'},
		});
	});

	it('re-registers an existing subscription for the same key without resubscribing', async () => {
		const existing = fakeSub(
			'https://push.example/old',
			urlB64ToUint8Array(KEY),
		);
		const {pm, subscribed} = fakeManager(existing);
		const {deps, calls} = fakeServer({
			'GET /push/vapid-public-key': {publicKey: KEY},
		});
		await subscribeThisDevice(pm, deps);
		expect(subscribed).toEqual([]);
		expect(existing.unsubscribed).toBe(false);
		expect(calls[1]!.body).toMatchObject({
			endpoint: 'https://push.example/old',
		});
	});

	it('replaces a subscription made for another key', async () => {
		const stale = fakeSub(
			'https://push.example/old',
			new Uint8Array([1, 2, 3]),
		);
		const {pm, subscribed} = fakeManager(stale);
		const {deps} = fakeServer({'GET /push/vapid-public-key': {publicKey: KEY}});
		await subscribeThisDevice(pm, deps);
		expect(stale.unsubscribed).toBe(true);
		expect(subscribed).toHaveLength(1);
	});

	it('surfaces the server error', async () => {
		const {pm} = fakeManager(null);
		const deps: PushServerDeps = {
			baseUrl: '',
			token: '',
			fetch: async () =>
				new Response(JSON.stringify({error: 'Unauthorized'}), {status: 401}),
		};
		await expect(subscribeThisDevice(pm, deps)).rejects.toThrow('Unauthorized');
	});
});

describe('unsubscribeThisDevice and the device state', () => {
	it('removes the subscription from the server, then from the browser', async () => {
		const sub = fakeSub('https://push.example/x', null);
		const {pm} = fakeManager(sub);
		const {deps, calls} = fakeServer();
		await unsubscribeThisDevice(pm, deps);
		expect(calls).toEqual([
			{
				url: 'https://me.example/push/subscription?token=sekret',
				method: 'DELETE',
				body: {endpoint: 'https://push.example/x'},
			},
		]);
		expect(sub.unsubscribed).toBe(true);
	});

	it('is subscribed only when the browser holds a subscription the server knows', async () => {
		const {deps, calls} = fakeServer({
			'GET /push/subscription': {subscribed: true},
		});
		expect(await isThisDeviceSubscribed(fakeManager(null).pm, deps)).toBe(
			false,
		);
		expect(calls).toEqual([]);
		const sub = fakeSub('https://push.example/a b', null);
		expect(await isThisDeviceSubscribed(fakeManager(sub).pm, deps)).toBe(true);
		expect(calls[0]!.url).toBe(
			'https://me.example/push/subscription?endpoint=https%3A%2F%2Fpush.example%2Fa+b&token=sekret',
		);
		const {deps: no} = fakeServer({
			'GET /push/subscription': {subscribed: false},
		});
		expect(await isThisDeviceSubscribed(fakeManager(sub).pm, no)).toBe(false);
	});

	it('detects support', () => {
		expect(pushSupported({})).toBe(false);
		expect(
			pushSupported({
				navigator: {serviceWorker: {}},
				PushManager: 1,
				Notification: 1,
			}),
		).toBe(true);
		expect(
			pushSupported({navigator: {}, PushManager: 1, Notification: 1}),
		).toBe(false);
	});
});
