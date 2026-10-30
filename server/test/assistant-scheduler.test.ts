import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AssistantScheduler,
  formatScheduledPrompt,
  type SchedulerClock,
  type SchedulerControllerPort,
  type SchedulerPoolPort,
} from '../src/assistant-scheduler.ts';

/**
 * The scheduler's firing loop against an injected CLOCK (no real timers), a
 * POOL fake and a CONTROLLER fake: inline jobs wait for a settled, empty
 * assistant session (never merging into a running exchange), an aborted settle
 * clears the leftover queue, isolated jobs start at once in `jobs/`, a CLI
 * session without `agent_settled` falls back to `agent_end`, malformed entries
 * and `!` prompts never start a turn, hand edits are picked up, and restart
 * catch-up follows the grace window. Temp assistant/state dirs; the real
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

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-scheduler-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'assistant');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(folder, 'jobs'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, folder, stateDir };
}

class FakeClock implements SchedulerClock {
  timers: Array<{ ms: number; cancelled: boolean }> = [];
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  setTimeout(_fn: () => void, ms: number) {
    const rec = { ms, cancelled: false };
    this.timers.push(rec);
    return () => {
      rec.cancelled = true;
    };
  }
}

interface FakeSession {
  type: 'server' | 'cli';
  streaming: boolean;
  queued: number;
  caps: string[];
}

type Listener = Parameters<SchedulerPoolPort['subscribeEvents']>[0];

class FakePool implements SchedulerPoolPort {
  sessions = new Map<string, FakeSession>();
  created: Array<{ cwd: string; forceNew?: boolean }> = [];
  sent: Array<{ file: string; text: string; origin?: string }> = [];
  listeners = new Set<Listener>();
  private n = 0;
  constructor(private root: string) {}
  add(file: string, s: Partial<FakeSession> = {}): FakeSession {
    const full: FakeSession = { type: 'server', streaming: false, queued: 0, caps: [], ...s };
    this.sessions.set(file, full);
    return full;
  }
  async createNewSession(cwd: string, _m?: string, _g?: boolean, _c?: boolean, _v?: 'private' | 'public', forceNew?: boolean) {
    this.created.push({ cwd, forceNew });
    this.n += 1;
    const sessionFile = path.join(this.root, `job-${this.n}.jsonl`);
    this.add(sessionFile);
    return { tracked: { sessionFile, sessionId: `job-${this.n}`, cwd } };
  }
  async sendUserMessage(file: string, text: string, _b?: 'steer' | 'followUp', _c?: boolean, origin?: string) {
    this.sent.push({ file, text, origin });
  }
  getSession(file: string) {
    return this.sessions.get(file) ?? null;
  }
  isStreaming(file: string) {
    return this.sessions.get(file)?.streaming ?? false;
  }
  getCliCapabilities(file: string) {
    const s = this.sessions.get(file);
    return s?.type === 'cli' ? s.caps : null;
  }
  getQueuedMessageCount(file: string) {
    const s = this.sessions.get(file);
    return s && s.type === 'server' ? s.queued : null;
  }
  subscribeEvents(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(file: string, event: { type: string; [k: string]: unknown }) {
    for (const l of this.listeners) l(file, event, null);
  }
}

/** A controller fake: one current session; `send` starts a "run" the test ends with events. */
class FakeController implements SchedulerControllerPort {
  sends: Array<{ text: string; origin: string }> = [];
  cleared: string[] = [];
  constructor(
    private pool: FakePool,
    public current: string,
  ) {}
  async ensureCurrent() {
    if (!this.pool.sessions.has(this.current)) this.pool.add(this.current);
    return { sessionFile: this.current };
  }
  async send(text: string, origin: string) {
    this.sends.push({ text, origin });
    const s = this.pool.sessions.get(this.current)!;
    s.streaming = true; // the run starts; the test settles it
    this.pool.emit(this.current, { type: 'agent_start' });
  }
  status() {
    return { currentSessionFile: this.current };
  }
  clearAfterAbort(file: string) {
    this.cleared.push(file);
    const s = this.pool.sessions.get(file);
    if (s) s.queued = 0;
    return null;
  }
}

const T0 = Date.parse('2026-06-01T10:00:00Z');

function setup(opts: { jobs?: unknown[]; now?: number; graceMs?: number; tz?: string } = {}) {
  const d = dirs();
  if (opts.jobs) writeJobs(d.folder, opts.jobs);
  const pool = new FakePool(d.root);
  const current = path.join(d.root, 'assistant-session.jsonl');
  pool.add(current);
  const controller = new FakeController(pool, current);
  const clock = new FakeClock(opts.now ?? T0);
  const make = () =>
    new AssistantScheduler({
      folder: d.folder,
      stateDir: d.stateDir,
      pool,
      controller,
      clock,
      graceMs: opts.graceMs,
      systemTimezone: opts.tz ?? 'UTC',
    });
  const scheduler = make();
  cleanups.push(() => scheduler.stop());
  return { ...d, pool, controller, clock, current, scheduler, make };
}

function writeJobs(folder: string, jobs: unknown[]) {
  fs.writeFileSync(path.join(folder, 'schedule.json'), JSON.stringify({ jobs }, null, 2));
}

function runLog(stateDir: string): any[] {
  try {
    return fs.readFileSync(path.join(stateDir, 'assistant-runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const inline = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), at: 'now', mode: 'inline', prompt: `do ${id}`, enabled: true, ...extra });
const settle = (pool: FakePool, file: string, aborted = false) => {
  pool.sessions.get(file)!.streaming = false;
  pool.emit(file, { type: 'agent_end' });
  pool.emit(file, { type: 'agent_settled', aborted });
};

describe('AssistantScheduler: nothing before start', () => {
  it('constructing it writes nothing and arms no timer', () => {
    const { stateDir, clock, folder } = setup({ jobs: [inline('a')] });
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(fs.readdirSync(folder).sort()).toEqual(['jobs', 'schedule.json']);
    expect(clock.timers).toEqual([]);
  });

  it('start initialises the timezone state and arms the (injected) timer', async () => {
    const { scheduler, stateDir, clock } = setup({ tz: 'Europe/Paris' });
    await scheduler.start();
    expect(scheduler.getUserTimezone()).toBe('Europe/Paris');
    expect(fs.readdirSync(stateDir)).toEqual(['assistant-timezone.json']);
    expect(clock.timers.filter((t) => !t.cancelled)).toHaveLength(1);
    scheduler.stop();
    expect(clock.timers.every((t) => t.cancelled)).toBe(true);
  });
});

describe('AssistantScheduler: inline', () => {
  it('sends with the schedule origin and the [schedule:<name>] prefix', async () => {
    const { scheduler, controller, stateDir, current } = setup({
      jobs: [inline('a', { originCwd: '/work/repo', originSessionId: 'sess-1' })],
    });
    await scheduler.start();
    await scheduler.idle();
    expect(controller.sends).toEqual([{ text: '[schedule:A] (from /work/repo, session sess-1) do a', origin: 'schedule:a' }]);
    const log = runLog(stateDir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ jobId: 'a', mode: 'inline', outcome: 'fired', sessionFile: current });
    // A completed one-shot stays in the file and is reported done.
    expect(scheduler.list().jobs[0].state).toBe('done');
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(stateDir), 'assistant', 'schedule.json'), 'utf8')).jobs).toHaveLength(1);
  });

  it('a `/` prompt goes without the prefix (so expansion still applies)', () => {
    expect(formatScheduledPrompt({ id: 'x', name: 'X', at: 'now', mode: 'inline', prompt: '/skill:brief today', enabled: true, originCwd: '/a' })).toBe(
      '/skill:brief today',
    );
    expect(formatScheduledPrompt({ id: 'x', name: 'X', at: 'now', mode: 'inline', prompt: 'hi', enabled: true })).toBe('[schedule:X] hi');
  });

  it('waits for SETTLED (not agent_end) with nothing queued, and never merges into a running exchange', async () => {
    const { scheduler, controller, pool, current } = setup();
    await scheduler.start();
    // The user is mid-exchange.
    pool.sessions.get(current)!.streaming = true;
    pool.emit(current, { type: 'agent_start' });
    writeJobs(path.dirname(scheduler.store.filePath), [inline('a'), inline('b')]);
    await scheduler.tick();
    await scheduler.idle();
    expect(controller.sends).toEqual([]);
    // agent_end is not settled: pi may still chain a follow-up.
    pool.sessions.get(current)!.streaming = false;
    pool.emit(current, { type: 'agent_end' });
    await scheduler.idle();
    expect(controller.sends).toEqual([]);
    // Settled, but a steer is still queued: not empty.
    pool.sessions.get(current)!.queued = 1;
    pool.emit(current, { type: 'agent_settled', aborted: false });
    await scheduler.idle();
    expect(controller.sends).toEqual([]);
    pool.sessions.get(current)!.queued = 0;
    pool.emit(current, { type: 'agent_settled', aborted: false });
    await scheduler.idle();
    expect(controller.sends.map((s) => s.origin)).toEqual(['schedule:a']);
    // b waits for a's own settle: one job per exchange.
    await scheduler.tick();
    await scheduler.idle();
    expect(controller.sends.map((s) => s.origin)).toEqual(['schedule:a']);
    settle(pool, current);
    await scheduler.idle();
    expect(controller.sends.map((s) => s.origin)).toEqual(['schedule:a', 'schedule:b']);
  });

  it('after an ABORTED settle with a queued message, the controller clears it and inline jobs fire', async () => {
    const { scheduler, controller, pool, current } = setup();
    await scheduler.start();
    pool.sessions.get(current)!.streaming = true;
    pool.emit(current, { type: 'agent_start' });
    writeJobs(path.dirname(scheduler.store.filePath), [inline('a')]);
    await scheduler.tick();
    // Abort: pi still holds the queued steer.
    pool.sessions.get(current)!.queued = 1;
    settle(pool, current, true);
    await scheduler.idle();
    expect(controller.cleared).toEqual([current]);
    expect(controller.sends.map((s) => s.origin)).toEqual(['schedule:a']);
  });

  it('a CLI-bridge session without the agent_settled capability settles on agent_end', async () => {
    const { scheduler, controller, pool, current } = setup();
    pool.add(current, { type: 'cli', caps: [] });
    await scheduler.start();
    pool.sessions.get(current)!.streaming = true;
    pool.emit(current, { type: 'agent_start' });
    writeJobs(path.dirname(scheduler.store.filePath), [inline('a')]);
    await scheduler.tick();
    expect(controller.sends).toEqual([]);
    pool.sessions.get(current)!.streaming = false;
    pool.emit(current, { type: 'agent_end' });
    await scheduler.idle();
    expect(controller.sends.map((s) => s.origin)).toEqual(['schedule:a']);
  });

  it('a CLI-bridge session WITH agent_settled waits for it, not agent_end', async () => {
    const { scheduler, controller, pool, current } = setup();
    pool.add(current, { type: 'cli', caps: ['agent_settled', 'cli_request'] });
    await scheduler.start();
    pool.sessions.get(current)!.streaming = true;
    pool.emit(current, { type: 'agent_start' });
    writeJobs(path.dirname(scheduler.store.filePath), [inline('a')]);
    await scheduler.tick();
    pool.sessions.get(current)!.streaming = false;
    pool.emit(current, { type: 'agent_end' });
    await scheduler.idle();
    expect(controller.sends).toEqual([]);
    pool.emit(current, { type: 'agent_settled', aborted: false });
    await scheduler.idle();
    expect(controller.sends.map((s) => s.origin)).toEqual(['schedule:a']);
  });
});

describe('AssistantScheduler: isolated', () => {
  it('starts at once in a fresh jobs/ session while the assistant is busy, and records the mapping', async () => {
    const { scheduler, controller, pool, current, folder, stateDir, make } = setup();
    await scheduler.start();
    pool.sessions.get(current)!.streaming = true;
    pool.emit(current, { type: 'agent_start' });
    writeJobs(folder, [{ id: 'heavy', name: 'Heavy', at: 'now', mode: 'isolated', prompt: 'crunch', enabled: true, originCwd: '/x' }]);
    await scheduler.tick();
    await scheduler.idle();
    expect(controller.sends).toEqual([]); // the assistant session is untouched
    expect(pool.created).toEqual([{ cwd: path.join(folder, 'jobs'), forceNew: true }]);
    const jobFile = pool.sent[0].file;
    expect(pool.sent).toEqual([{ file: jobFile, text: '[schedule:Heavy] (from /x) crunch', origin: 'schedule:heavy' }]);
    expect(scheduler.jobForSession(jobFile)).toBe('heavy');
    expect(runLog(stateDir)[0]).toMatchObject({ jobId: 'heavy', mode: 'isolated', outcome: 'fired', sessionFile: jobFile });
    // Survives a restart (the mapping is in the run log).
    scheduler.stop();
    const again = make();
    cleanups.push(() => again.stop());
    await again.start();
    expect(again.jobForSession(jobFile)).toBe('heavy');
    expect(pool.created).toHaveLength(1); // done: not started again
  });

  it('several isolated jobs run in parallel', async () => {
    const { scheduler, pool, folder } = setup();
    writeJobs(folder, ['a', 'b', 'c'].map((id) => ({ id, name: id, at: 'now', mode: 'isolated', prompt: id, enabled: true })));
    await scheduler.start();
    await scheduler.idle();
    expect(new Set(pool.sent.map((s) => s.file)).size).toBe(3);
  });
});

describe('AssistantScheduler: validation, refusal, edits', () => {
  it('a malformed entry is listed invalid without a turn while valid ones fire', async () => {
    const { scheduler, controller, folder } = setup();
    writeJobs(folder, [{ id: 'broken', name: 'B', cron: 'every morning', mode: 'inline', prompt: 'x', enabled: true }, inline('a')]);
    await scheduler.start();
    await scheduler.idle();
    expect(controller.sends.map((s) => s.origin)).toEqual(['schedule:a']);
    const listing = scheduler.list();
    expect(listing.invalid.map((i) => i.id)).toEqual(['broken']);
    expect(listing.invalid[0].errors[0]).toMatch(/cron/);
  });

  it('refuses `!` / `!!` prompts as a failed run, never reaching the pool', async () => {
    const { scheduler, controller, pool, folder, stateDir } = setup();
    writeJobs(folder, [
      inline('bang', { prompt: '!rm -rf ~' }),
      { id: 'bang2', name: 'B2', at: 'now', mode: 'isolated', prompt: '  !!sudo reboot', enabled: true },
    ]);
    await scheduler.start();
    await scheduler.idle();
    expect(controller.sends).toEqual([]);
    expect(pool.sent).toEqual([]);
    expect(pool.created).toEqual([]);
    expect(runLog(stateDir).map((e) => [e.jobId, e.outcome])).toEqual([
      ['bang', 'refused'],
      ['bang2', 'refused'],
    ]);
    expect(scheduler.list().jobs.map((j) => j.state)).toEqual(['done', 'done']);
  });

  it('picks up hand edits on the next tick, and a disabled job never fires', async () => {
    const { scheduler, controller, folder } = setup();
    await scheduler.start();
    writeJobs(folder, [inline('a', { enabled: false })]);
    await scheduler.tick();
    await scheduler.idle();
    expect(controller.sends).toEqual([]);
    writeJobs(folder, [inline('a')]);
    await scheduler.tick();
    await scheduler.idle();
    expect(controller.sends.map((s) => s.origin)).toEqual(['schedule:a']);
  });

  it('addJob writes through the store and fires an `at: "now"` job at once', async () => {
    const { scheduler, controller, folder } = setup();
    await scheduler.start();
    const job = await scheduler.addJob({ name: 'Now', at: 'now', mode: 'inline', prompt: 'go', enabled: true, originSessionId: 's9' });
    await scheduler.idle();
    expect(controller.sends).toEqual([{ text: '[schedule:Now] (session s9) go', origin: `schedule:${job.id}` }]);
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'schedule.json'), 'utf8')).jobs[0].id).toBe(job.id);
  });
});

describe('AssistantScheduler: cron timing, restart grace, timezones', () => {
  const daily = (extra: Record<string, unknown> = {}) => ({ id: 'brief', name: 'Brief', cron: '0 8 * * *', mode: 'inline', prompt: 'brief me', enabled: true, ...extra });

  it('fires a recurring job when its time comes (injected clock), not before', async () => {
    const { scheduler, controller, clock, folder } = setup({ now: Date.parse('2026-06-01T07:00:00Z') });
    writeJobs(folder, [daily()]);
    await scheduler.start();
    await scheduler.idle();
    expect(controller.sends).toEqual([]);
    expect(scheduler.list().jobs[0].next).toBe('2026-06-01T08:00:00.000Z');
    // The timer is armed for the due time.
    expect(clock.timers.at(-1)!.ms).toBe(30_000);
    clock.t = Date.parse('2026-06-01T08:00:10Z');
    await scheduler.tick();
    await scheduler.idle();
    expect(controller.sends.map((s) => s.origin)).toEqual(['schedule:brief']);
    expect(scheduler.list().jobs[0].next).toBe('2026-06-02T08:00:00.000Z');
  });

  it('restart: fires ONCE inside the grace window, skips (recorded) outside, one-shot done', async () => {
    const { folder, stateDir, pool, controller, current } = setup();
    writeJobs(folder, [
      { id: 'every10', name: 'E', cron: '*/10 * * * *', mode: 'inline', prompt: 'tick', enabled: true },
      daily(),
      { id: 'late', name: 'L', at: '2026-06-02T09:00:00Z', mode: 'isolated', prompt: 'x', enabled: true },
      { id: 'soon', name: 'S', at: '2026-06-02T10:00:00Z', mode: 'isolated', prompt: 'y', enabled: true },
    ]);
    // Last runs before the server went down.
    fs.writeFileSync(
      path.join(stateDir, 'assistant-runs.jsonl'),
      [
        { jobId: 'every10', time: '', scheduledFor: '2026-06-02T09:50:00.000Z', mode: 'inline', outcome: 'fired' },
        { jobId: 'brief', time: '', scheduledFor: '2026-06-01T08:00:00.000Z', mode: 'inline', outcome: 'fired' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
    // Back up at 10:35: every10 missed 10:00..10:30 (fire once), brief missed 08:00 (2.5 h: skip),
    // `late` was due at 09:00 (outside: skip, done), `soon` at 10:00 (inside: fire, done).
    const clock = new FakeClock(Date.parse('2026-06-02T10:35:00Z'));
    const s = new AssistantScheduler({ folder, stateDir, pool, controller, clock, systemTimezone: 'UTC' });
    cleanups.push(() => s.stop());
    await s.start();
    await s.idle();
    expect(controller.sends.map((x) => x.origin)).toEqual(['schedule:every10']);
    expect(pool.sent.map((x) => x.origin)).toEqual(['schedule:soon']);
    const log = runLog(stateDir).slice(2);
    expect(log.map((e) => [e.jobId, e.outcome, e.scheduledFor])).toEqual(
      expect.arrayContaining([
        ['every10', 'fired', '2026-06-02T10:30:00.000Z'],
        ['brief', 'skipped', '2026-06-02T08:00:00.000Z'],
        ['late', 'skipped', '2026-06-02T09:00:00.000Z'],
        ['soon', 'fired', '2026-06-02T10:00:00.000Z'],
      ]),
    );
    expect(log).toHaveLength(4);
    const states = Object.fromEntries(s.list().jobs.map((j) => [j.job.id, [j.state, j.next]]));
    expect(states.brief).toEqual(['waiting', '2026-06-03T08:00:00.000Z']);
    expect(states.late[0]).toBe('done');
    expect(states.soon[0]).toBe('done');
    // A second tick does not fire again.
    settle(pool, current);
    await s.tick();
    await s.idle();
    expect(controller.sends).toHaveLength(1);
  });

  it('a job with no run yet does not catch up on runs from before it was first seen', async () => {
    const { scheduler, controller, folder } = setup({ now: Date.parse('2026-06-01T08:30:00Z') });
    writeJobs(folder, [daily()]);
    await scheduler.start();
    await scheduler.idle();
    expect(controller.sends).toEqual([]);
    expect(scheduler.list().jobs[0].next).toBe('2026-06-02T08:00:00.000Z');
  });

  it('a follows-the-user job moves when the user timezone changes; a pinned one does not', async () => {
    const { scheduler, folder } = setup({ now: Date.parse('2026-06-01T00:00:00Z'), tz: 'Europe/Paris' });
    writeJobs(folder, [daily(), daily({ id: 'pinned', tz: 'Europe/Paris' })]);
    await scheduler.start();
    const next = () => Object.fromEntries(scheduler.list().jobs.map((j) => [j.job.id, [j.timezone, j.next]]));
    expect(next()).toEqual({
      brief: ['Europe/Paris', '2026-06-01T06:00:00.000Z'],
      pinned: ['Europe/Paris', '2026-06-01T06:00:00.000Z'],
    });
    expect(scheduler.setUserTimezone('America/New_York', 'test')).toBe(true);
    expect(next()).toEqual({
      brief: ['America/New_York', '2026-06-01T12:00:00.000Z'],
      pinned: ['Europe/Paris', '2026-06-01T06:00:00.000Z'],
    });
  });
});
