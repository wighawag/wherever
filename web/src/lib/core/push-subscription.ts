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

/**
 * A push error for the settings UI: its NAME and message (a DOMException's
 * name is the useful part: Firefox's "Error retrieving push subscription." is
 * an AbortError), plus a short actionable hint for the two errors a user can
 * fix: AbortError (the browser's push service is disabled or unreachable) and
 * NotAllowedError or a denied permission (re-allow notifications).
 */
export function describePushError(err: unknown, permission?: string): string {
	let text: string;
	let name = '';
	if (err && typeof err === 'object' && 'message' in err) {
		const e = err as {name?: unknown; message?: unknown};
		name = typeof e.name === 'string' ? e.name : '';
		const message = String(e.message ?? '');
		text = name && name !== 'Error' ? `${name}: ${message}` : message;
	} else {
		text = String(err);
	}
	if (name === 'NotAllowedError' || permission === 'denied') {
		return `${text} Notifications are blocked for this site: re-allow them in the browser's site settings (the icon left of the address), then try again.`;
	}
	if (name === 'AbortError') {
		return `${text} The browser's push service is disabled or unreachable. On Firefox and LibreWolf, open about:config and check that dom.push.enabled and dom.push.connection.enabled are true (and that the browser can reach its push server).`;
	}
	return text;
}

/**
 * The settings toggle: subscribe (`want` true) or unsubscribe THIS device,
 * then RE-READ the real state, so the checkbox never shows a state the device
 * is not in (a failed subscribe used to leave it checked). When even the
 * re-read fails, the state is assumed unchanged (`!want`).
 */
export async function applyPushToggle(
	pm: DevicePushManager,
	deps: PushServerDeps,
	want: boolean,
	permission?: () => string | undefined,
): Promise<{subscribed: boolean; error: string}> {
	let error = '';
	try {
		if (want) await subscribeThisDevice(pm, deps);
		else await unsubscribeThisDevice(pm, deps);
	} catch (err) {
		error = describePushError(err, permission?.());
	}
	let subscribed = !want;
	try {
		subscribed = await isThisDeviceSubscribed(pm, deps);
	} catch (err) {
		if (!error) error = describePushError(err, permission?.());
	}
	return {subscribed, error};
}

/** One channel's result in `POST /push/test` (the dispatcher's delivery). */
export interface TestDelivery {
	channel: string;
	result: {ok: true; detail?: string} | {ok: false; error: string};
}

/**
 * "Send test notification": `POST /push/test` (token-gated), which goes through
 * the same notify path as `assistant_notify` (every channel), opening
 * `sessionId` (the session this device has open) or the main screen. Resolves
 * a one-line summary per channel; rejects with the server's error when the
 * notification reached nothing.
 */
export async function sendTestNotification(
	deps: PushServerDeps,
	sessionId: string | null,
): Promise<string> {
	const data = await ok(
		await deps.fetch(pushUrl(deps, '/push/test'), {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(sessionId ? {sessionId} : {}),
		}),
	);
	const deliveries: TestDelivery[] = Array.isArray(data?.deliveries)
		? data.deliveries
		: [];
	const sent = deliveries
		.filter((d) => d.result.ok)
		.map((d) =>
			d.result.ok && d.result.detail
				? `${d.channel} (${d.result.detail})`
				: d.channel,
		);
	const failed = deliveries
		.filter((d) => !d.result.ok)
		.map((d) => `${d.channel}: ${d.result.ok ? '' : d.result.error}`);
	let text = sent.length > 0 ? `Sent: ${sent.join(', ')}.` : 'Sent.';
	if (failed.length > 0) text += ` Not delivered: ${failed.join('; ')}.`;
	return text;
}
