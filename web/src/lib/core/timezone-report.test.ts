import {describe, it, expect} from 'vitest';
import {
	reportTimezoneIfMoved,
	timezoneReportFrame,
	TIMEZONE_REPORTED_KEY,
	type TimezoneReportFrame,
	type TimezoneReportStorage,
} from './timezone-report';

// ADR 0019: a web report is a signal that a DEVICE MOVED. The web remembers, on
// the device, the last zone it reported and sends a report only when the
// browser's zone differs from it, marking the device's first report. The server
// decides what an accepted report changes (a first one never overrides an
// explicit `assistant_set_timezone`).

function memoryStorage(
	initial: Record<string, string> = {},
): TimezoneReportStorage & {data: Record<string, string>} {
	const data = {...initial};
	return {
		data,
		getItem: (k) => (k in data ? data[k]! : null),
		setItem: (k, v) => {
			data[k] = v;
		},
	};
}

describe('timezoneReportFrame', () => {
	it("is a first report carrying the browser's zone when nothing is remembered", () => {
		expect(timezoneReportFrame(null, () => 'Europe/Paris')).toEqual({
			type: 'client_timezone',
			timezone: 'Europe/Paris',
			first: true,
		});
	});

	it('is a non-first report when the zone differs from the remembered one', () => {
		expect(timezoneReportFrame('Europe/Paris', () => 'Asia/Tokyo')).toEqual({
			type: 'client_timezone',
			timezone: 'Asia/Tokyo',
			first: false,
		});
	});

	it('sends nothing when the zone did not change', () => {
		expect(
			timezoneReportFrame('Europe/Paris', () => 'Europe/Paris'),
		).toBeNull();
	});

	it('defaults to Intl.DateTimeFormat().resolvedOptions().timeZone', () => {
		expect(timezoneReportFrame(null)).toEqual({
			type: 'client_timezone',
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			first: true,
		});
	});

	it('sends nothing when the zone is unknown or Intl throws', () => {
		expect(timezoneReportFrame(null, () => '')).toBeNull();
		expect(timezoneReportFrame(null, () => undefined)).toBeNull();
		expect(
			timezoneReportFrame(null, () => {
				throw new Error('no Intl');
			}),
		).toBeNull();
	});
});

describe('reportTimezoneIfMoved', () => {
	it('reconnecting a device whose zone did not change sends no report', () => {
		const storage = memoryStorage();
		const sent: TimezoneReportFrame[] = [];
		const send = (f: TimezoneReportFrame) => sent.push(f);
		for (let i = 0; i < 5; i++)
			reportTimezoneIfMoved(send, storage, () => 'Europe/Paris');
		expect(sent).toEqual([
			{type: 'client_timezone', timezone: 'Europe/Paris', first: true},
		]);
		expect(storage.data[TIMEZONE_REPORTED_KEY]).toBe('Europe/Paris');
	});

	it('a device that moved reports once, as a non-first report', () => {
		const storage = memoryStorage({[TIMEZONE_REPORTED_KEY]: 'Europe/Paris'});
		const sent: TimezoneReportFrame[] = [];
		const send = (f: TimezoneReportFrame) => sent.push(f);
		reportTimezoneIfMoved(send, storage, () => 'Asia/Tokyo');
		reportTimezoneIfMoved(send, storage, () => 'Asia/Tokyo');
		expect(sent).toEqual([
			{type: 'client_timezone', timezone: 'Asia/Tokyo', first: false},
		]);
		expect(storage.data[TIMEZONE_REPORTED_KEY]).toBe('Asia/Tokyo');
	});

	it('two devices in different zones that never move stop reporting after their first report (no alternation)', () => {
		const paris = memoryStorage();
		const tokyo = memoryStorage();
		const sent: TimezoneReportFrame[] = [];
		const send = (f: TimezoneReportFrame) => sent.push(f);
		for (let i = 0; i < 4; i++) {
			reportTimezoneIfMoved(send, paris, () => 'Europe/Paris');
			reportTimezoneIfMoved(send, tokyo, () => 'Asia/Tokyo');
		}
		expect(sent).toEqual([
			{type: 'client_timezone', timezone: 'Europe/Paris', first: true},
			{type: 'client_timezone', timezone: 'Asia/Tokyo', first: true},
		]);
	});

	it('an unusable storage still reports, always as a first report (which never overrides an explicit setting)', () => {
		const broken: TimezoneReportStorage = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			},
		};
		const sent: TimezoneReportFrame[] = [];
		reportTimezoneIfMoved(
			(f) => sent.push(f),
			broken,
			() => 'Europe/Paris',
		);
		reportTimezoneIfMoved(
			(f) => sent.push(f),
			undefined,
			() => 'Europe/Paris',
		);
		expect(sent).toEqual([
			{type: 'client_timezone', timezone: 'Europe/Paris', first: true},
			{type: 'client_timezone', timezone: 'Europe/Paris', first: true},
		]);
	});
});
