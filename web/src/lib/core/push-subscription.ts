/**
 * THIS device's Web Push subscription to the wherever assistant (server
 * `web-push.ts`, ADR 0017): the settings toggle subscribes or unsubscribes it
 * with `PushManager.subscribe` and the server's VAPID public key, and registers
 * it on the server's token-gated `/push/subscription`.
 *
 * Framework-free with every browser object injected, so it is unit-tested with
 * fakes. Replaces the template's `push-notifications` module, which was built for
 * `push-notification-server`'s signer-based `/register` and was never used.
 */

/** The slice of `PushSubscription` used here. */
export interface DevicePushSubscription {
	endpoint: string;
	options?: {applicationServerKey?: ArrayBuffer | null};
	toJSON(): unknown;
	unsubscribe(): Promise<boolean>;
}

/** The slice of `PushManager` used here. */
export interface DevicePushManager {
	getSubscription(): Promise<DevicePushSubscription | null>;
	subscribe(options: {
		userVisibleOnly: boolean;
		applicationServerKey: Uint8Array;
	}): Promise<DevicePushSubscription>;
}

export interface PushServerDeps {
	baseUrl: string;
	token: string;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/** True when this browser can receive Web Push at all (service worker + PushManager + Notification). */
export function pushSupported(g: any = globalThis): boolean {
	return (
		!!g.navigator &&
		'serviceWorker' in g.navigator &&
		'PushManager' in g &&
		'Notification' in g
	);
}

export function urlB64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(base64);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
	return out;
}

function pushUrl(deps: PushServerDeps, path: string, query = ''): string {
	const params = new URLSearchParams(query);
	if (deps.token) params.set('token', deps.token);
	const qs = params.toString();
	return `${deps.baseUrl}${path}${qs ? `?${qs}` : ''}`;
}

async function ok(res: Response): Promise<any> {
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
	return data;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
	if (!a) return false;
	const x = new Uint8Array(a);
	return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** Whether THIS device is subscribed: it holds a subscription AND the server has it. */
export async function isThisDeviceSubscribed(
	pm: DevicePushManager,
	deps: PushServerDeps,
): Promise<boolean> {
	const sub = await pm.getSubscription();
	if (!sub) return false;
	const data = await ok(
		await deps.fetch(
			pushUrl(
				deps,
				'/push/subscription',
				`endpoint=${encodeURIComponent(sub.endpoint)}`,
			),
		),
	);
	return !!data.subscribed;
}

/**
 * Subscribe THIS device: fetch the server's VAPID key (the server generates it
 * on first use), subscribe (replacing a subscription made for another key), and
 * register it on the server.
 */
export async function subscribeThisDevice(
	pm: DevicePushManager,
	deps: PushServerDeps,
): Promise<void> {
	const {publicKey} = await ok(
		await deps.fetch(pushUrl(deps, '/push/vapid-public-key')),
	);
	if (typeof publicKey !== 'string' || !publicKey)
		throw new Error('the server sent no VAPID public key');
	const key = urlB64ToUint8Array(publicKey);
	let sub = await pm.getSubscription();
	if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
		await sub.unsubscribe();
		sub = null;
	}
	if (!sub) {
		sub = await pm.subscribe({
			userVisibleOnly: true,
			applicationServerKey: key,
		});
	}
	await ok(
		await deps.fetch(pushUrl(deps, '/push/subscription'), {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(sub.toJSON()),
		}),
	);
}

/** Unsubscribe THIS device: remove it from the server, then drop the browser subscription. */
export async function unsubscribeThisDevice(
	pm: DevicePushManager,
	deps: PushServerDeps,
): Promise<void> {
	const sub = await pm.getSubscription();
	if (!sub) return;
	await ok(
		await deps.fetch(pushUrl(deps, '/push/subscription'), {
			method: 'DELETE',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({endpoint: sub.endpoint}),
		}),
	);
	await sub.unsubscribe();
}
