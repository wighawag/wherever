import { describe, it, expect } from 'vitest';
import {
  CronParseError,
  atToInstant,
  isValidTimeZone,
  nextCronRun,
  parseAtString,
  parseCron,
  prevCronRun,
  zonedToUtc,
} from '../src/assistant-cron.ts';

/**
 * The scheduler's time arithmetic, pure: the 5-field cron parser, next/previous
 * occurrence in an IANA zone (including both DST transitions), and `at` parsing.
 * Europe/Paris 2026: spring forward Mar 29 02:00 CET -> 03:00 CEST (01:00Z), fall
 * back Oct 25 03:00 CEST -> 02:00 CET (01:00Z).
 */

const Z = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('parseCron', () => {
  it('parses lists, ranges, steps, names and macros', () => {
    const s = parseCron('*/15 9-17 * jan-mar mon-fri');
    expect(s.minutes.flatMap((v, i) => (v ? [i] : []))).toEqual([0, 15, 30, 45]);
    expect(s.hours.flatMap((v, i) => (v ? [i] : []))).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(s.months.flatMap((v, i) => (v ? [i] : []))).toEqual([1, 2, 3]);
    expect(s.daysOfWeek.flatMap((v, i) => (v ? [i] : []))).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('5/20 * * * *').minutes.flatMap((v, i) => (v ? [i] : []))).toEqual([5, 25, 45]);
    expect(parseCron('0 0 * * 7').daysOfWeek[0]).toBe(true); // 7 = Sunday
    expect(parseCron('@daily').source).toBe('@daily');
    expect(nextCronRun(parseCron('@hourly'), 'UTC', Z('2026-01-01T10:10:00Z'))).toBe(Z('2026-01-01T11:00:00Z'));
  });

  it('rejects malformed expressions', () => {
    for (const bad of ['61 * * * *', '* * *', 'a b c d e', '5-1 * * * *', '*/0 * * * *', '* * 0 * *', '', '1,,2 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(CronParseError);
    }
  });

  it('ORs day-of-month and day-of-week only when both are restricted (Vixie)', () => {
    // 13th of the month OR a Friday. 2026-02-06 is a Friday, 2026-02-13 a Friday too.
    const or = parseCron('0 0 13 * 5');
    expect(iso(nextCronRun(or, 'UTC', Z('2026-02-01T00:00:00Z')))).toBe('2026-02-06T00:00:00.000Z');
    // `*` in day-of-month: only Fridays.
    const and = parseCron('0 0 * * 5');
    expect(iso(nextCronRun(and, 'UTC', Z('2026-02-07T00:00:00Z')))).toBe('2026-02-13T00:00:00.000Z');
  });
});

describe('nextCronRun / prevCronRun', () => {
  it('is strictly after / at-or-before', () => {
    const s = parseCron('0 8 * * *');
    expect(iso(nextCronRun(s, 'UTC', Z('2026-01-01T08:00:00Z')))).toBe('2026-01-02T08:00:00.000Z');
    expect(iso(prevCronRun(s, 'UTC', Z('2026-01-01T08:00:00Z')))).toBe('2026-01-01T08:00:00.000Z');
    expect(iso(prevCronRun(s, 'UTC', Z('2026-01-01T07:59:59Z')))).toBe('2025-12-31T08:00:00.000Z');
  });

  it('evaluates in the given zone: 8:00 stays 8:00 local across the spring-forward change', () => {
    const s = parseCron('0 8 * * *');
    expect(iso(nextCronRun(s, 'Europe/Paris', Z('2026-03-28T07:00:00Z')))).toBe('2026-03-29T06:00:00.000Z');
    expect(iso(prevCronRun(s, 'Europe/Paris', Z('2026-03-29T05:59:00Z')))).toBe('2026-03-28T07:00:00.000Z');
    expect(iso(nextCronRun(s, 'America/New_York', Z('2026-03-28T07:00:00Z')))).toBe('2026-03-28T12:00:00.000Z');
  });

  it('a local time in the spring-forward gap fires once, when the gap ends', () => {
    const s = parseCron('30 2 * * *');
    expect(iso(nextCronRun(s, 'Europe/Paris', Z('2026-03-28T01:30:00Z')))).toBe('2026-03-29T01:00:00.000Z'); // 03:00 CEST
    expect(iso(nextCronRun(s, 'Europe/Paris', Z('2026-03-29T01:00:00Z')))).toBe('2026-03-30T00:30:00.000Z');
    const every30 = parseCron('*/30 * * * *');
    // 02:00 and 02:30 do not exist: both collapse onto 03:00, which runs once.
    expect(iso(nextCronRun(every30, 'Europe/Paris', Z('2026-03-29T00:45:00Z')))).toBe('2026-03-29T01:00:00.000Z');
    expect(iso(nextCronRun(every30, 'Europe/Paris', Z('2026-03-29T01:00:00Z')))).toBe('2026-03-29T01:30:00.000Z');
  });

  it('a local time that occurs twice (fall-back) fires at its first occurrence only', () => {
    const s = parseCron('30 2 * * *');
    expect(iso(nextCronRun(s, 'Europe/Paris', Z('2026-10-24T12:00:00Z')))).toBe('2026-10-25T00:30:00.000Z'); // 02:30 CEST
    expect(iso(nextCronRun(s, 'Europe/Paris', Z('2026-10-25T00:30:00Z')))).toBe('2026-10-26T01:30:00.000Z'); // not 01:30Z on the 25th
    expect(iso(prevCronRun(s, 'Europe/Paris', Z('2026-10-25T02:00:00Z')))).toBe('2026-10-25T00:30:00.000Z');
  });

  it('returns null when the expression can never match', () => {
    expect(nextCronRun(parseCron('0 0 31 2 *'), 'UTC', Z('2026-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('zones and `at`', () => {
  it('validates IANA names', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(3)).toBe(false);
  });

  it('maps local times to instants (overlap = earlier)', () => {
    expect(iso(zonedToUtc('Europe/Paris', 2026, 7, 1, 9, 0))).toBe('2026-07-01T07:00:00.000Z');
    expect(iso(zonedToUtc('Europe/Paris', 2026, 10, 25, 2, 30))).toBe('2026-10-25T00:30:00.000Z');
  });

  it('parses `at` with and without an offset', () => {
    const local = parseAtString('2026-05-01T09:00')!;
    expect(local.offsetMs).toBeNull();
    expect(iso(atToInstant(local, 'Europe/Paris'))).toBe('2026-05-01T07:00:00.000Z');
    expect(iso(atToInstant(local, 'Asia/Tokyo'))).toBe('2026-05-01T00:00:00.000Z');
    expect(iso(atToInstant(parseAtString('2026-05-01T09:00:00Z')!, 'Europe/Paris'))).toBe('2026-05-01T09:00:00.000Z');
    expect(iso(atToInstant(parseAtString('2026-05-01T09:00:00.5+02:00')!, 'UTC'))).toBe('2026-05-01T07:00:00.500Z');
    expect(iso(atToInstant(parseAtString('2026-05-01 09:00-0330')!, 'UTC'))).toBe('2026-05-01T12:30:00.000Z');
    for (const bad of ['2026-02-30T09:00', 'tomorrow', '2026-05-01', '2026-05-01T25:00', '2026-05-01T09:00+25:00']) {
      expect(parseAtString(bad), bad).toBeNull();
    }
  });
});
