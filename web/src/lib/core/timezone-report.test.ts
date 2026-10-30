import {describe, it, expect} from 'vitest';
import {timezoneReportFrame} from './timezone-report';

// On every connect the web reports its timezone to the server (the assistant's
// "times follow the user", ADR 0015). The frame is built here so the transport
// can stay dumb; the server decides whether it matters (assistant active, zone
// changed) and ignores it otherwise.
describe('timezoneReportFrame', () => {
	it("carries the browser's resolved IANA zone", () => {
		expect(timezoneReportFrame(() => 'Europe/Paris')).toEqual({
			type: 'client_timezone',
			timezone: 'Europe/Paris',
		});
	});

	it('defaults to Intl.DateTimeFormat().resolvedOptions().timeZone', () => {
		expect(timezoneReportFrame()).toEqual({
			type: 'client_timezone',
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
	});

	it('sends nothing when the zone is unknown or Intl throws', () => {
		expect(timezoneReportFrame(() => '')).toBeNull();
		expect(timezoneReportFrame(() => undefined)).toBeNull();
		expect(
			timezoneReportFrame(() => {
				throw new Error('no Intl');
			}),
		).toBeNull();
	});
});
