/**
 * The web client's timezone report (spec `assistant-session-and-channels`,
 * ADR 0015: a job without its own `tz` follows the user's CURRENT timezone).
 *
 * Sent on every connect (`wherever.ts`, on the server's `connected` frame). The
 * server makes it the user's current timezone when the assistant is active and
 * the zone differs (recorded), and ignores it otherwise, so it is safe to send
 * to any server (an older one simply drops an unknown message type).
 */
export interface TimezoneReportFrame {
	type: 'client_timezone';
	timezone: string;
}

const browserTimeZone = (): string | undefined =>
	Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The frame to send, or null when the browser does not know its zone. */
export function timezoneReportFrame(
	resolve: () => string | undefined = browserTimeZone,
): TimezoneReportFrame | null {
	let timezone: string | undefined;
	try {
		timezone = resolve();
	} catch {
		return null;
	}
	if (typeof timezone !== 'string' || !timezone) return null;
	return {type: 'client_timezone', timezone};
}
