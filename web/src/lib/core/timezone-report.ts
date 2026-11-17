/**
 * The web client's timezone report (spec `assistant-session-and-channels`,
 * ADR 0015: a job without its own `tz` follows the user's CURRENT timezone;
 * ADR 0019: a report is a signal that a DEVICE MOVED, not a reading of where
 * the user is).
 *
 * On every connect (`wherever.ts`, on the server's `connected` frame) the web
 * compares the browser's resolved zone with the last zone THIS browser reported
 * (remembered in localStorage under `TIMEZONE_REPORTED_KEY`) and sends a report
 * only when they differ; `first` marks the device's first report (nothing
 * remembered). The server applies a non-first report when it differs from the
 * current zone, and a first one only when the current zone was not set by
 * `assistant_set_timezone`; it ignores reports while the assistant is not
 * active.
 *
 * Compatibility: an older server ignores the unknown `first` field and applies
 * the report when it differs, exactly as before (it just hears fewer reports);
 * an older web sends no `first` and is read by the server as a non-first report.
 *
 * The device remembers a zone as soon as it is sent, whether or not the server
 * applied it: "reported" is about this device, and the server's own rule (not a
 * resend) decides what a report changes.
 */
export interface TimezoneReportFrame {
	type: 'client_timezone';
	timezone: string;
	/** True for this device's first report (no zone remembered). */
	first: boolean;
}

/** The localStorage key holding the last zone this browser reported. */
export const TIMEZONE_REPORTED_KEY = 'wherever-timezone-reported';

/** The slice of `Storage` the report needs (faked in tests). */
export type TimezoneReportStorage = Pick<Storage, 'getItem' | 'setItem'>;

const browserTimeZone = (): string | undefined =>
	Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The frame to send given the last zone this device reported (null = none),
 * or null when nothing is to be sent: the zone did not change, or the browser
 * does not know its zone.
 */
export function timezoneReportFrame(
	lastReported: string | null,
	resolve: () => string | undefined = browserTimeZone,
): TimezoneReportFrame | null {
	let timezone: string | undefined;
	try {
		timezone = resolve();
	} catch {
		return null;
	}
	if (typeof timezone !== 'string' || !timezone) return null;
	if (lastReported && timezone === lastReported) return null;
	return {type: 'client_timezone', timezone, first: !lastReported};
}

/**
 * Send this browser's zone when it moved since its last report, and remember
 * it. A storage that cannot be read reads as "nothing remembered", so the
 * report is a first one, which never overrides an explicit setting.
 */
export function reportTimezoneIfMoved(
	send: (frame: TimezoneReportFrame) => void,
	storage: TimezoneReportStorage | undefined = typeof localStorage !==
	'undefined'
		? localStorage
		: undefined,
	resolve: () => string | undefined = browserTimeZone,
): void {
	let last: string | null = null;
	try {
		last = storage?.getItem(TIMEZONE_REPORTED_KEY) ?? null;
	} catch {
		last = null;
	}
	const frame = timezoneReportFrame(last, resolve);
	if (!frame) return;
	send(frame);
	try {
		storage?.setItem(TIMEZONE_REPORTED_KEY, frame.timezone);
	} catch {
		// Not remembered: the next connect sends another first report.
	}
}
