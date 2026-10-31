import {get, writable} from 'svelte/store';
type JSONNotification = {
	title: string;
	options: NotificationOptions;
};

export type PushNotification = {
	type: 'push-notification';
	data: JSONNotification;
};
export type NotificationToAdd = PushNotification;

export type Notification = NotificationToAdd & {id: number};

/** The slice of `window.location` a notification click drives (faked in tests). */
export interface NavigationTarget {
	readonly href: string;
	readonly origin: string;
	readonly pathname: string;
	hash: string;
	assign(url: string): void;
}

/**
 * Open a notification's `navigate` target from the page (the FOREGROUND click;
 * a click on a system notification is the service worker's
 * `notificationclick`). The assistant's pushes target `/#<sessionId>`
 * (server/src/web-push.ts), and the page opens a session on `hashchange`, so a
 * target on THIS page sets `location.hash`, which fires it. (It used SvelteKit's
 * `pushState`, which changes the URL without firing `hashchange`, so the session
 * never opened.) Any other target is a real navigation.
 */
export function openNotificationTarget(
	navigate: string,
	loc: NavigationTarget,
): void {
	let target: URL;
	try {
		target = new URL(navigate, loc.href);
	} catch {
		return;
	}
	const samePage =
		target.origin === loc.origin &&
		(target.pathname === loc.pathname || target.pathname === '/');
	if (samePage && target.hash) {
		loc.hash = target.hash;
		return;
	}
	loc.assign(target.href);
}

const browserLocation = (): NavigationTarget => window.location;

export function createNotificationsService(
	location: () => NavigationTarget = browserLocation,
) {
	let lastId = 1;
	const store = writable<Notification[]>([]);

	function add(notification: NotificationToAdd) {
		store.update((notifications) => [
			...notifications,
			{...notification, id: ++lastId},
		]);
	}

	function remove(id: number) {
		store.update((notifications) =>
			notifications.filter((notification) => notification.id !== id),
		);
	}

	function onClick(id: number) {
		const notification = get(store).find((v) => v.id == id);
		remove(id);
		if (notification?.type === 'push-notification') {
			const navigate = notification.data.options.data?.navigate;
			if (typeof navigate === 'string' && navigate) {
				openNotificationTarget(navigate, location());
			}
		}
	}
	return {subscribe: store.subscribe, add, remove, onClick};
}

export const notifications = createNotificationsService();
