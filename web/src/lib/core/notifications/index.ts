import {createQuestionToasts, readQuestionPush} from './question-toasts';
import {createUpdateToasts, readUpdatePush} from './update-toasts';
import {
	browserNotifications,
	createAnsweredNotificationCloser,
} from './answered-notifications';

/** What the service worker posts to the page: the push as `{title, options}`. */
export type JSONNotification = {
	title: string;
	options: NotificationOptions;
};

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
 * never opened.) `/#` (no session id: a test notification sent with no
 * session open) is the main screen, so it clears the hash, which fires
 * `hashchange` and leaves the open session. Any other target is a real
 * navigation.
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
	// `URL.hash` is '' both for no fragment and for an empty one (`/#`).
	if (samePage && (target.hash || navigate.endsWith('#'))) {
		loc.hash = target.hash;
		return;
	}
	loc.assign(target.href);
}

const browserLocation = (): NavigationTarget => window.location;

/**
 * The foreground question toasts and slim bar (`question-toasts.ts`), kept on
 * this device in localStorage. `QuestionToasts.svelte` feeds it the shipmates
 * snapshots and the page's context.
 */
export const questionToasts = createQuestionToasts({
	storage: typeof localStorage !== 'undefined' ? localStorage : undefined,
});

/**
 * The foreground update toasts and the updates list (`update-toasts.ts`), kept
 * on this device in localStorage. `UpdateToast.svelte` shows the toast above
 * the composer; the slim bar (`NotificationToasts.svelte`) counts and lists
 * the folded ones.
 */
export const updateToasts = createUpdateToasts({
	storage: typeof localStorage !== 'undefined' ? localStorage : undefined,
	openTarget: (navigate) => openNotificationTarget(navigate, browserLocation()),
});

/**
 * Closes this device's system notification for a question answered anywhere
 * (`answered-notifications.ts`). `wherever.ts` feeds it every received
 * `shipmates_update` frame and every return to the page.
 */
export const answeredNotificationCloser = createAnsweredNotificationCloser({
	list: browserNotifications,
});

/**
 * A notification the service worker posted to this (visible, focused) page:
 * a question (`data.kind: 'question'`) goes to the question toasts, anything
 * else (`kind: 'update'`, or no kind from an older server) to the update
 * toasts.
 */
export function receivePushNotification(notification: JSONNotification): void {
	const question = readQuestionPush(notification);
	if (question) questionToasts.push(question);
	else updateToasts.push(readUpdatePush(notification));
}
