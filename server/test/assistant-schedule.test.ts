import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RunLog,
  ScheduleFileError,
  ScheduleStore,
  ScheduleValidationError,
  UserTimezone,
  effectiveTimeZone,
  planJob,
  validateSchedule,
  type RunEntry,
  type ValidJob,
} from '../src/assistant-schedule.ts';

/**
 * The schedule's pure parts and its store: validation, the next-run planner
 * (entry, timezone, run log, now; injected clock, no timers), follows-the-user
 * vs pinned timezones, the restart grace rule, the write queue with its
 * conflict retry, and the user's timezone state. Temp dirs only; the real
 * ~/.wherever is asserted untouched.
 */

const REAL_WHEREVER_DIR = path.join(os.homedir(), '.wherever');
const snapshot = (d: string) => {
  try {
    return fs.readdirSync(d).sort().map((n) => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`).join(',');
  } catch {
    return 'ABSENT';
  }
};
const realBefore = snapshot(REAL_WHEREVER_DIR);
afterAll(() => {
  expect(snapshot(REAL_WHEREVER_DIR)).toBe(realBefore);
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-schedule-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const Z = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const GRACE = { graceMs: HOUR };

function job(fields: Record<string, unknown>): ValidJob {
  const v = validateSchedule(JSON.stringify({ jobs: [{ id: 'j', name: 'J', mode: 'inline', prompt: 'p', enabled: true, ...fields }] }));
  expect(v.invalid).toEqual([]);
  return v.valid[0];
}

function run(scheduledFor: string, outcome: RunEntry['outcome'] = 'fired'): RunEntry {
  return { jobId: 'j', time: scheduledFor, scheduledFor, mode: 'inline', outcome };
}

describe('validateSchedule', () => {
  it('keeps valid entries and lists malformed ones without stopping the rest', () => {
    const v = validateSchedule(
      JSON.stringify({
        jobs: [
          { id: 'ok', name: 'Ok', cron: '0 8 * * *', mode: 'inline', prompt: 'brief me', enabled: true },
          { id: 'both', name: 'B', cron: '0 8 * * *', at: 'now', mode: 'inline', prompt: 'x', enabled: true },
          { id: 'badcron', name: 'C', cron: '99 * * * *', mode: 'isolated', prompt: 'x', enabled: true },
          { id: 'badtz', name: 'T', at: 'now', tz: 'Mars/Base', mode: 'inline', prompt: 'x', enabled: true },
          { id: 'badmode', name: 'M', at: 'now', mode: 'shell', prompt: 'x', enabled: 'yes' },
          'not an object',
          { id: 'ok', name: 'Dup', at: 'now', mode: 'inline', prompt: 'x', enabled: true },
          { id: 'at', name: 'A', at: '2026-05-01T09:00', mode: 'isolated', prompt: 'x', enabled: false, extra: 1 },
        ],
      }),
    );
    expect(v.fileError).toBeNull();
    expect(v.valid.map((x) => x.job.id)).toEqual(['ok', 'at']);
    expect(v.invalid.map((x) => [x.index, x.id])).toEqual([
      [1, 'both'],
      [2, 'badcron'],
      [3, 'badtz'],
      [4, 'badmode'],
      [5, null],
      [6, 'ok'],
    ]);
    expect(v.invalid[3].errors.join(' ')).toMatch(/mode.*enabled/);
  });

  it('a missing file is empty; a wrong shape is a file error', () => {
    expect(validateSchedule(null)).toEqual({ valid: [], invalid: [], fileError: null });
    expect(validateSchedule('{').fileError).toMatch(/JSON/);
    expect(validateSchedule('[]').fileError).toMatch(/object/);
    expect(validateSchedule('{"jobs":3}').fileError).toMatch(/array/);
  });
});

describe('planJob (pure next-run derivation)', () => {
  it('cron: waiting from `since`, then from the newest run entry', () => {
    const j = job({ cron: '0 8 * * *' });
    expect(planJob(j, 'UTC', [], Z('2026-01-01T07:00:00Z'), { ...GRACE, since: Z('2026-01-01T06:00:00Z') })).toEqual({
      state: 'waiting',
      next: Z('2026-01-01T08:00:00Z'),
    });
    expect(planJob(j, 'UTC', [run('2026-01-01T08:00:00.000Z')], Z('2026-01-01T09:00:00Z'), GRACE)).toEqual({
      state: 'waiting',
      next: Z('2026-01-02T08:00:00Z'),
    });
    // No run, no since: counts from now (no backfill).
    expect(planJob(j, 'UTC', [], Z('2026-01-01T09:00:00Z'), GRACE).state).toBe('waiting');
  });

  it('cron: due at its time, for the latest occurrence', () => {
    const j = job({ cron: '*/10 * * * *' });
    const p = planJob(j, 'UTC', [run('2026-01-01T08:00:00.000Z')], Z('2026-01-01T08:35:00Z'), GRACE);
    expect(p).toEqual({ state: 'due', next: Z('2026-01-01T08:30:00Z'), scheduledFor: Z('2026-01-01T08:30:00Z') });
  });

  it('restart grace: fire once inside the window, skip outside', () => {
    const daily = job({ cron: '0 8 * * *' });
    const last = [run('2026-01-01T08:00:00.000Z')];
    // Down from before 08:00 on the 2nd, back at 08:40: inside 1 h.
    expect(planJob(daily, 'UTC', last, Z('2026-01-02T08:40:00Z'), GRACE).state).toBe('due');
    // Back at 10:30: 2.5 h late, skipped.
    const missed = planJob(daily, 'UTC', last, Z('2026-01-02T10:30:00Z'), GRACE);
    expect(missed).toEqual({ state: 'missed', next: Z('2026-01-02T08:00:00Z'), scheduledFor: Z('2026-01-02T08:00:00Z') });
    // Once the skip is recorded, the job waits for the next day.
    expect(planJob(daily, 'UTC', [...last, run('2026-01-02T08:00:00.000Z', 'skipped')], Z('2026-01-02T10:30:00Z'), GRACE)).toEqual({
      state: 'waiting',
      next: Z('2026-01-03T08:00:00Z'),
    });
    // Down for a week: only the latest missed run counts, and it is outside.
    expect(planJob(daily, 'UTC', last, Z('2026-01-08T12:00:00Z'), GRACE).state).toBe('missed');
    // A configurable window.
    expect(planJob(daily, 'UTC', last, Z('2026-01-02T10:30:00Z'), { graceMs: 3 * HOUR }).state).toBe('due');
  });

  it('one-shot: waiting, due inside the window, missed outside, done after any run', () => {
    const j = job({ at: '2026-01-01T09:00:00Z' });
    expect(planJob(j, 'UTC', [], Z('2026-01-01T08:00:00Z'), GRACE)).toEqual({ state: 'waiting', next: Z('2026-01-01T09:00:00Z') });
    expect(planJob(j, 'UTC', [], Z('2026-01-01T09:30:00Z'), GRACE).state).toBe('due');
    expect(planJob(j, 'UTC', [], Z('2026-01-01T11:00:00Z'), GRACE).state).toBe('missed');
    expect(planJob(j, 'UTC', [run('2026-01-01T09:00:00.000Z', 'skipped')], Z('2026-01-01T11:00:00Z'), GRACE)).toEqual({ state: 'done', next: null });
    expect(planJob(j, 'UTC', [run('2026-01-01T09:00:00.000Z')], Z('2026-01-01T09:01:00Z'), GRACE).state).toBe('done');
  });

  it('`at: "now"` is due as soon as it is seen, then done', () => {
    const j = job({ at: 'now' });
    expect(planJob(j, 'UTC', [], Z('2026-01-01T08:00:00Z'), { ...GRACE, since: Z('2026-01-01T07:59:00Z') })).toEqual({
      state: 'due',
      next: Z('2026-01-01T08:00:00Z'),
      scheduledFor: Z('2026-01-01T07:59:00Z'),
    });
    expect(planJob(j, 'UTC', [run('2026-01-01T07:59:00.000Z')], Z('2026-01-01T08:00:00Z'), GRACE).state).toBe('done');
  });

  it('disabled jobs never fire', () => {
    expect(planJob(job({ at: 'now', enabled: false }), 'UTC', [], 0, GRACE)).toEqual({ state: 'disabled', next: null });
  });

  it('an offset-less `at` is read in the effective timezone, and moves with the user', () => {
    const j = job({ at: '2026-05-01T09:00' });
    const now = Z('2026-04-01T00:00:00Z');
    expect(planJob(j, effectiveTimeZone(j.job, 'Europe/Paris'), [], now, GRACE).next).toBe(Z('2026-05-01T07:00:00Z'));
    expect(planJob(j, effectiveTimeZone(j.job, 'America/New_York'), [], now, GRACE).next).toBe(Z('2026-05-01T13:00:00Z'));
    // An explicit offset never moves.
    const fixed = job({ at: '2026-05-01T09:00+02:00' });
    expect(planJob(fixed, 'America/New_York', [], now, GRACE).next).toBe(Z('2026-05-01T07:00:00Z'));
  });

  it('follows the user vs pinned `tz`, across a user timezone change and a DST transition', () => {
    const follows = job({ cron: '0 8 * * *' });
    const pinned = job({ cron: '0 8 * * *', tz: 'Europe/Paris' });
    const since = { ...GRACE, since: Z('2026-03-27T12:00:00Z') };
    const now = Z('2026-03-27T12:00:00Z');
    // The user is in Paris: both run at 08:00 Paris (CET, 07:00Z).
    expect(planJob(follows, effectiveTimeZone(follows.job, 'Europe/Paris'), [], now, since).next).toBe(Z('2026-03-28T07:00:00Z'));
    expect(planJob(pinned, effectiveTimeZone(pinned.job, 'Europe/Paris'), [], now, since).next).toBe(Z('2026-03-28T07:00:00Z'));
    // The user flies to New York: the follows-the-user job moves to 08:00 there, the pinned one does not.
    expect(planJob(follows, effectiveTimeZone(follows.job, 'America/New_York'), [], now, since).next).toBe(Z('2026-03-28T12:00:00Z'));
    expect(planJob(pinned, effectiveTimeZone(pinned.job, 'America/New_York'), [], now, since).next).toBe(Z('2026-03-28T07:00:00Z'));
    // Over the Paris spring-forward night it stays 08:00 local (now CEST, 06:00Z).
    expect(planJob(pinned, 'Europe/Paris', [run('2026-03-28T07:00:00.000Z')], Z('2026-03-28T08:00:00Z'), GRACE).next).toBe(
      Z('2026-03-29T06:00:00Z'),
    );
  });
});

describe('ScheduleStore', () => {
  it('adds and removes through atomic writes, keeping unknown keys and other entries', async () => {
    const folder = tmp();
    const file = path.join(folder, 'schedule.json');
    fs.writeFileSync(file, JSON.stringify({ note: 'mine', jobs: [{ id: 'hand', name: 'H', at: 'now', mode: 'inline', prompt: 'x', enabled: false, custom: true }] }));
    const store = new ScheduleStore(folder);
    const added = await store.addJob({ name: 'Brief', cron: '0 8 * * *', mode: 'inline', prompt: 'brief me', enabled: true });
    expect(added.id).toMatch(/^job-/);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(doc.note).toBe('mine');
    expect(doc.jobs[0]).toEqual({ id: 'hand', name: 'H', at: 'now', mode: 'inline', prompt: 'x', enabled: false, custom: true });
    expect(doc.jobs[1].id).toBe(added.id);
    expect(await store.removeJob('hand')).toBe(true);
    expect(await store.removeJob('nope')).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).jobs.map((j: any) => j.id)).toEqual([added.id]);
    expect(fs.readdirSync(folder)).toEqual(['schedule.json']); // no temp file left behind
  });

  it('refuses invalid input and duplicate ids, writing nothing', async () => {
    const folder = tmp();
    const store = new ScheduleStore(folder);
    await expect(store.addJob({ name: 'X', mode: 'inline', prompt: 'p', enabled: true } as any)).rejects.toBeInstanceOf(ScheduleValidationError);
    expect(fs.existsSync(path.join(folder, 'schedule.json'))).toBe(false);
    await store.addJob({ id: 'a', name: 'A', at: 'now', mode: 'inline', prompt: 'p', enabled: true });
    const before = fs.readFileSync(path.join(folder, 'schedule.json'), 'utf8');
    await expect(store.addJob({ id: 'a', name: 'A2', at: 'now', mode: 'inline', prompt: 'p', enabled: true })).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(folder, 'schedule.json'), 'utf8')).toBe(before);
  });

  it('never clobbers an unreadable file', async () => {
    const folder = tmp();
    fs.writeFileSync(path.join(folder, 'schedule.json'), '{ "jobs": [ half-typed');
    const store = new ScheduleStore(folder);
    await expect(store.addJob({ name: 'A', at: 'now', mode: 'inline', prompt: 'p', enabled: true })).rejects.toBeInstanceOf(ScheduleFileError);
    expect(fs.readFileSync(path.join(folder, 'schedule.json'), 'utf8')).toBe('{ "jobs": [ half-typed');
  });

  it('a concurrent on-disk edit is not clobbered: the write re-reads and retries', async () => {
    const folder = tmp();
    const file = path.join(folder, 'schedule.json');
    fs.writeFileSync(file, JSON.stringify({ jobs: [] }));
    const attempts: number[] = [];
    const store = new ScheduleStore(folder, {
      beforeCommit: (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) {
          // A hand edit lands between the store's read and its rename.
          fs.writeFileSync(file, JSON.stringify({ jobs: [{ id: 'hand', name: 'H', at: 'now', mode: 'isolated', prompt: 'x', enabled: true }] }));
        }
      },
    });
    await store.addJob({ id: 'tool', name: 'T', at: 'now', mode: 'inline', prompt: 'y', enabled: true });
    expect(attempts).toEqual([1, 2]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).jobs.map((j: any) => j.id)).toEqual(['hand', 'tool']);
  });

  it('serialises concurrent writes through one queue', async () => {
    const folder = tmp();
    const store = new ScheduleStore(folder);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.addJob({ id: `j${i}`, name: `J${i}`, at: 'now', mode: 'inline', prompt: 'p', enabled: true })),
    );
    expect(store.read().valid.map((v) => v.job.id)).toEqual(Array.from({ length: 10 }, (_, i) => `j${i}`));
  });
});

describe('RunLog and UserTimezone', () => {
  it('the run log is append-only and survives a restart (a torn line is skipped)', () => {
    const stateDir = tmp();
    const log = new RunLog(stateDir);
    log.append({ jobId: 'a', time: 't', scheduledFor: '2026-01-01T00:00:00.000Z', mode: 'inline', outcome: 'fired', sessionFile: '/s' });
    fs.appendFileSync(path.join(stateDir, 'assistant-runs.jsonl'), '{"jobId":"b","ti');
    const again = new RunLog(stateDir);
    expect(again.forJob('a')).toHaveLength(1);
    expect(again.forJob('b')).toHaveLength(0);
  });

  it('the user timezone starts at the system zone, validates, and records every change', () => {
    const stateDir = tmp();
    const tz = new UserTimezone(stateDir, 'Europe/Paris');
    expect(tz.get()).toBe('Europe/Paris');
    expect(() => tz.set('Nowhere/Land', 'test')).toThrow(/IANA/);
    expect(tz.set('Europe/Paris', 'test')).toBe(false);
    expect(tz.set('Asia/Tokyo', 'web')).toBe(true);
    const reloaded = new UserTimezone(stateDir, 'UTC');
    expect(reloaded.get()).toBe('Asia/Tokyo');
    expect(reloaded.history().map((h) => [h.timezone, h.source])).toEqual([
      ['Europe/Paris', 'system'],
      ['Asia/Tokyo', 'web'],
    ]);
  });
});
