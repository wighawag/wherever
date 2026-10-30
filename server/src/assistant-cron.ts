/**
 * Time arithmetic for the assistant scheduler (spec `assistant-session-and-channels`,
 * ADR 0015): a minimal 5-field cron parser, next/previous occurrence in an IANA
 * timezone, and the `at` (one-shot) parser. Pure: no clock, no timers, no I/O.
 *
 * WHY a hand-written parser, not a cron library (decision, recorded here): a
 * new runtime dependency changes `pnpm-lock.yaml` and therefore the Nix
 * `pnpmDepsHash` every consumer build checks (ADR 0008), for ~200 lines of
 * well-understood code. And the timezone semantics the scheduler needs are its
 * own anyway: the zone is supplied per evaluation (a follows-the-user job is
 * re-evaluated in the user's CURRENT zone, which changes when they travel), and
 * the DST rules below are chosen so the local-to-instant mapping is MONOTONE,
 * which is what lets the search stop at the first candidate. Alternatives
 * considered: `croner` (zero-dep, timezone-aware, maintained) and `cron-parser`
 * (pulls in luxon). Revisit if the syntax ever needs more than the 5 fields.
 *
 * Syntax: `minute hour day-of-month month day-of-week`, each field a comma list
 * of `*`, `n`, `a-b`, optionally with `/step` (`*\/15`, `1-30/2`, `5/10`).
 * Months and weekdays accept three-letter English names; weekday 0 and 7 are
 * Sunday. Macros: `@yearly` / `@annually`, `@monthly`, `@weekly`, `@daily` /
 * `@midnight`, `@hourly`. Day-of-month and day-of-week follow Vixie cron: when
 * BOTH are restricted (neither starts with `*`) a day matches if EITHER does,
 * otherwise both must match.
 *
 * DST (decision): a local time that does not exist (the spring-forward gap)
 * fires at the instant the gap ends, once; a local time that occurs twice (the
 * fall-back overlap) fires at its FIRST occurrence only. So "30 2 * * *" still
 * runs on the spring-forward day (at 03:00 local), and nothing runs twice on the
 * fall-back day. The cost: a sub-hourly job does not repeat during the repeated
 * hour. Alternative: Temporal's "compatible" (shift a gap time forward by the
 * gap length), rejected because it is not monotone (02:30 would map AFTER 03:00).
 */

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

export interface CronSpec {
  readonly source: string;
  readonly minutes: readonly boolean[]; // 0..59
  readonly hours: readonly boolean[]; // 0..23
  readonly daysOfMonth: readonly boolean[]; // 1..31 (index 0 unused)
  readonly months: readonly boolean[]; // 1..12 (index 0 unused)
  readonly daysOfWeek: readonly boolean[]; // 0..6, Sunday = 0
  /** Vixie rule: day-of-month and day-of-week are OR-ed only when both are restricted. */
  readonly dayOr: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  namesBase?: number;
}

const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, namesBase: 1 },
  { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES, namesBase: 0 },
];

function parseValue(raw: string, def: FieldDef): number {
  const lower = raw.toLowerCase();
  if (def.names) {
    const i = def.names.indexOf(lower);
    if (i >= 0) return i + (def.namesBase ?? 0);
  }
  if (!/^\d+$/.test(raw)) throw new CronParseError(`${def.name}: "${raw}" is not a number`);
  const n = Number(raw);
  if (n < def.min || n > def.max) throw new CronParseError(`${def.name}: ${n} is outside ${def.min}-${def.max}`);
  return n;
}

function parseField(field: string, def: FieldDef): boolean[] {
  const out = new Array<boolean>(def.max + 1).fill(false);
  if (field === '') throw new CronParseError(`${def.name}: empty field`);
  for (const part of field.split(',')) {
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new CronParseError(`${def.name}: "${part}" has more than one "/"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new CronParseError(`${def.name}: bad step "${stepPart}"`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = def.min;
      hi = def.max;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (more !== undefined) throw new CronParseError(`${def.name}: bad range "${rangePart}"`);
      lo = parseValue(a, def);
      hi = parseValue(b, def);
      if (lo > hi) throw new CronParseError(`${def.name}: range "${rangePart}" runs backwards`);
    } else {
      lo = parseValue(rangePart, def);
      // `5/10` means from 5 to the end, every 10.
      hi = stepPart !== undefined ? def.max : lo;
    }
    for (let v = lo; v <= hi; v += step) out[v] = true;
  }
  return out;
}

/** Parse a 5-field cron expression (or a macro). Throws `CronParseError`. */
export function parseCron(expr: string): CronSpec {
  if (typeof expr !== 'string') throw new CronParseError('cron must be a string');
  const trimmed = expr.trim();
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) throw new CronParseError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  const [mi, h, dom, mon, dow] = fields.map((f, i) => parseField(f, FIELDS[i]));
  const daysOfWeek = dow.slice(0, 7);
  if (dow[7]) daysOfWeek[0] = true;
  return {
    source: trimmed,
    minutes: mi,
    hours: h,
    daysOfMonth: dom,
    months: mon,
    daysOfWeek,
    dayOr: !fields[2].startsWith('*') && !fields[4].startsWith('*'),
  };
}

// ---------------------------------------------------------------------------
// Timezones

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True when `tz` is an IANA zone name this runtime knows (e.g. `Europe/Paris`, `UTC`). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** The system timezone (what a fresh server assumes the user is in). */
export function systemTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface WallClock {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock time in `tz` at instant `ms`. */
export function wallClock(tz: string, ms: number): WallClock {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** UTC offset of `tz` at instant `ms`, in ms (east positive). */
function offsetAt(tz: string, ms: number): number {
  const w = wallClock(tz, ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The instant at which `tz` shows the given local time. An overlap (fall-back)
 * resolves to the EARLIER instant; a gap (spring-forward) resolves to the
 * instant the gap ends. See the module JSDoc.
 */
export function zonedToUtc(tz: string, year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offBefore = offsetAt(tz, guess - DAY);
  const offAfter = offsetAt(tz, guess + DAY);
  const candidates: number[] = [];
  for (const off of offBefore === offAfter ? [offBefore] : [offBefore, offAfter]) {
    const t = guess - off;
    if (offsetAt(tz, t) === off) candidates.push(t);
  }
  if (candidates.length > 0) return Math.min(...candidates);
  // No exact match: the local time is in a gap. Find the first instant whose
  // offset is the post-transition one, between the two readings.
  const lo0 = guess - Math.max(offBefore, offAfter);
  const hi0 = guess - Math.min(offBefore, offAfter);
  let lo = Math.min(lo0, hi0);
  let hi = Math.max(lo0, hi0);
  const offLo = offsetAt(tz, lo);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (mid <= lo || mid >= hi) break;
    if (offsetAt(tz, mid) === offLo) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ---------------------------------------------------------------------------
// Occurrences

/** How far the occurrence search looks before giving up ("30 2 31 2 *" never matches). */
const SEARCH_DAYS = 366 * 30;

function civilAddDays(y: number, m: number, d: number, n: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function dayMatches(spec: CronSpec, y: number, m: number, d: number): boolean {
  if (!spec.months[m]) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = spec.daysOfMonth[d] === true;
  const dowOk = spec.daysOfWeek[dow] === true;
  return spec.dayOr ? domOk || dowOk : domOk && dowOk;
}

function hoursOf(spec: CronSpec): number[] {
  const out: number[] = [];
  for (let h = 0; h < 24; h++) if (spec.hours[h]) out.push(h);
  return out;
}

function minutesOf(spec: CronSpec): number[] {
  const out: number[] = [];
  for (let m = 0; m < 60; m++) if (spec.minutes[m]) out.push(m);
  return out;
}

/** The first occurrence STRICTLY after `afterMs`, evaluated in `tz`; null when none within the search horizon. */
export function nextCronRun(spec: CronSpec, tz: string, afterMs: number): number | null {
  const start = wallClock(tz, afterMs);
  const hours = hoursOf(spec);
  const minutes = minutesOf(spec);
  let [y, m, d] = [start.year, start.month, start.day];
  // The day before too: a gap or overlap near midnight can map a local time of
  // the previous day past `afterMs`. Cheap, and the mapping is monotone.
  [y, m, d] = civilAddDays(y, m, d, -1);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    if (dayMatches(spec, y, m, d)) {
      // On the first two days, skip hours that cannot be after `afterMs` (2 h of
      // slack covers any DST shift).
      const minHour = i === 1 ? start.hour - 2 : i === 0 ? 22 : -1;
      for (const h of hours) {
        if (h < minHour) continue;
        for (const mi of minutes) {
          const t = zonedToUtc(tz, y, m, d, h, mi);
          if (t > afterMs) return t;
        }
      }
    }
    [y, m, d] = civilAddDays(y, m, d, 1);
  }
  return null;
}

/** The last occurrence at or before `atOrBeforeMs`, evaluated in `tz`; null when none within the search horizon. */
export function prevCronRun(spec: CronSpec, tz: string, atOrBeforeMs: number): number | null {
  const start = wallClock(tz, atOrBeforeMs);
  const hours = hoursOf(spec).reverse();
  const minutes = minutesOf(spec).reverse();
  let [y, m, d] = civilAddDays(start.year, start.month, start.day, 1);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    if (dayMatches(spec, y, m, d)) {
      const maxHour = i === 1 ? start.hour + 2 : i === 0 ? 1 : 24;
      for (const h of hours) {
        if (h > maxHour) continue;
        for (const mi of minutes) {
          const t = zonedToUtc(tz, y, m, d, h, mi);
          if (t <= atOrBeforeMs) return t;
        }
      }
    }
    [y, m, d] = civilAddDays(y, m, d, -1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// `at`

const AT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

export interface ParsedAt {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** Explicit UTC offset in ms, or null when the string carries none (read in the job's timezone). */
  offsetMs: number | null;
}

/** Parse an ISO 8601 date-time (`at`). Null when malformed. `"now"` is NOT handled here. */
export function parseAtString(at: string): ParsedAt | null {
  const m = AT_RE.exec(at.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const second = m[6] ? Number(m[6]) : 0;
  const millisecond = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  let offsetMs: number | null = null;
  const z = m[8];
  if (z) {
    if (z.toUpperCase() === 'Z') offsetMs = 0;
    else {
      const sign = z[0] === '-' ? -1 : 1;
      const digits = z.slice(1).replace(':', '');
      const oh = Number(digits.slice(0, 2));
      const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
      if (oh > 23 || om > 59) return null;
      offsetMs = sign * (oh * HOUR + om * 60_000);
    }
  }
  return { year, month, day, hour, minute, second, millisecond, offsetMs };
}

/** The instant an `at` names: its own offset when it carries one, else read as local time in `tz`. */
export function atToInstant(at: ParsedAt, tz: string): number {
  if (at.offsetMs !== null) {
    return Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second, at.millisecond) - at.offsetMs;
  }
  return zonedToUtc(tz, at.year, at.month, at.day, at.hour, at.minute, at.second) + at.millisecond;
}
