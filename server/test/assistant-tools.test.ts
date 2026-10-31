import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { AssistantScheduler, type SchedulerClock, type SchedulerControllerPort, type SchedulerPoolPort } from '../src/assistant-scheduler.ts';
import {
  appendTimezoneLine,
  assistantNotActiveError,
  assistantSessionParts,
  createAssistantTools,
  createTimezoneLineExtension,
  isAssistantFolderCwd,
  setTimezone,
  WEB_TIMEZONE_SOURCE,
  type AssistantSessionHooks,
  type AssistantToolCaller,
} from '../src/assistant-tools.ts';
import { ASSISTANT_SCHEDULE_TOOL_TEXTS, timezoneLine } from '../src/assistant-tool-text.ts';
import { composeServerAgentParts } from '../src/session-pool.ts';
import { serverBuiltinExtensions } from '../src/builtin-extensions.ts';

/**
 * The assistant's schedule and timezone TOOLS (assistant-tools.ts) against a
 * REAL scheduler on temp assistant/state dirs (fake pool, controller and clock):
 * add stamps the calling session as origin and the job runs as the assistant,
 * list marks the caller's jobs and shows done and invalid entries, remove
 * removes, bad input is an `isError` that writes nothing, a timezone change
 * (tool or web report) moves a follows-the-user job and is pushed, and a
 * refused lock answers a clear lock-state error. Plus the timezone-line inline
 * extension and the "assistant off = byte-identical" composition. The real
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

class FakeClock implements SchedulerClock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  setTimeout() {
    return () => {};
  }
}

class FakePool implements SchedulerPoolPort {
  created: Array<{ cwd: string; forceNew?: boolean }> = [];
  sent: Array<{ file: string; text: string; origin?: string }> = [];
  private n = 0;
  constructor(private root: string) {}
  async createNewSession(cwd: string, _m?: string, _g?: boolean, _c?: boolean, _v?: 'private' | 'public', forceNew?: boolean) {
    this.created.push({ cwd, forceNew });
    this.n += 1;
    return { tracked: { sessionFile: path.join(this.root, `job-${this.n}.jsonl`), sessionId: `job-${this.n}`, cwd } };
  }
  async sendUserMessage(file: string, text: string, _b?: 'steer' | 'followUp', _c?: boolean, origin?: string) {
    this.sent.push({ file, text, origin });
  }
  getSession() {
    return { type: 'server' as const };
  }
  isStreaming() {
    return false;
  }
  getCliCapabilities() {
    return null;
  }
  getQueuedMessageCount() {
    return 0;
  }
  subscribeEvents() {
    return () => {};
  }
}

const controller: SchedulerControllerPort = {
  ensureCurrent: async () => ({ sessionFile: '/x/assistant.jsonl' }),
  send: async () => {},
  status: () => ({ currentSessionFile: '/x/assistant.jsonl' }),
  clearAfterAbort: () => null,
};

// 2026-06-01T10:00:00Z, a Monday.
const T0 = Date.parse('2026-06-01T10:00:00Z');

async function setup(opts: { systemTimezone?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-tools-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'assistant');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(folder, 'jobs'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const pool = new FakePool(root);
  const clock = new FakeClock(T0);
  const tzChanges: string[] = [];
  const scheduler = new AssistantScheduler({
    folder,
    stateDir,
    pool,
    controller,
    clock,
    systemTimezone: opts.systemTimezone ?? 'UTC',
    onTimezoneChange: (tz) => tzChanges.push(tz),
  });
  await scheduler.start();
  cleanups.push(() => scheduler.stop());
  const hooks: AssistantSessionHooks = { folder, access: () => ({ ok: true, backend: scheduler }) };
  const otherCwd = path.join(root, 'code');
  const caller: AssistantToolCaller = { sessionId: 'coding-session', cwd: otherCwd };
  const tools = byName(createAssistantTools(hooks, () => caller));
  return { root, folder, stateDir, pool, clock, scheduler, hooks, tools, caller, tzChanges, otherCwd };
}

type AnyTool = { name: string; execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: any; isError?: boolean }> };
function byName(list: unknown[]): Record<string, AnyTool> {
  return Object.fromEntries((list as AnyTool[]).map((t) => [t.name, t]));
}
const scheduleFile = (folder: string) => path.join(folder, 'schedule.json');
const readSchedule = (folder: string) => JSON.parse(fs.readFileSync(scheduleFile(folder), 'utf8'));

describe('assistant_schedule_add', () => {
  it('writes the job to the assistant schedule with the calling session stamped as origin', async () => {
    const { folder, tools, otherCwd } = await setup();
    const r = await tools.assistant_schedule_add!.execute('t1', {
      name: 'Morning brief',
      cron: '0 8 * * *',
      mode: 'inline',
      prompt: 'brief me on the news',
    });
    expect(r.isError).toBeUndefined();
    const { jobs } = readSchedule(folder);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: 'Morning brief',
      cron: '0 8 * * *',
      mode: 'inline',
      prompt: 'brief me on the news',
      enabled: true,
      originSessionId: 'coding-session',
      originCwd: otherCwd,
    });
    expect(jobs[0].tz).toBeUndefined();
    expect(r.content[0]!.text).toContain(jobs[0].id);
    expect(r.content[0]!.text).toContain('next run 2026-06-02T08:00:00.000Z');
  });

  it('runs the job AS THE ASSISTANT (isolated: in <assistantFolder>/jobs/), with the origin as context', async () => {
    const { folder, tools, pool, scheduler, otherCwd } = await setup();
    await tools.assistant_schedule_add!.execute('t1', { name: 'Check CI', at: 'now', mode: 'isolated', prompt: 'check CI and tell me' });
    await scheduler.idle();
    expect(pool.created).toEqual([{ cwd: path.join(folder, 'jobs'), forceNew: true }]);
    expect(pool.sent).toHaveLength(1);
    expect(pool.sent[0]!.text).toBe(`[schedule:Check CI] (from ${otherCwd}, session coding-session) check CI and tell me`);
    expect(pool.sent[0]!.origin).toMatch(/^schedule:/);
  });

  it.each([
    ['no mode', { name: 'x', cron: '0 8 * * *', prompt: 'p' }],
    ['both cron and at', { name: 'x', cron: '0 8 * * *', at: 'now', mode: 'inline', prompt: 'p' }],
    ['neither cron nor at', { name: 'x', mode: 'inline', prompt: 'p' }],
    ['a bad cron', { name: 'x', cron: '61 8 * * *', mode: 'inline', prompt: 'p' }],
    ['a bad at', { name: 'x', at: 'tomorrowish', mode: 'inline', prompt: 'p' }],
    ['an unknown tz', { name: 'x', cron: '0 8 * * *', tz: 'Mars/Olympus', mode: 'inline', prompt: 'p' }],
    ['an empty name', { name: '', cron: '0 8 * * *', mode: 'inline', prompt: 'p' }],
    ['a ! prompt', { name: 'x', at: 'now', mode: 'isolated', prompt: '!rm -rf ~' }],
  ])('bad input (%s) is an isError result and writes nothing', async (_label, params) => {
    const { folder, tools, pool, scheduler } = await setup();
    const r = await tools.assistant_schedule_add!.execute('t1', params);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^assistant_schedule_add: /);
    await scheduler.idle();
    expect(fs.existsSync(scheduleFile(folder))).toBe(false);
    expect(pool.sent).toHaveLength(0);
  });

  it('an unreadable schedule.json is an isError result and is left as is', async () => {
    const { folder, tools } = await setup();
    fs.writeFileSync(scheduleFile(folder), '{ not json');
    const r = await tools.assistant_schedule_add!.execute('t1', { name: 'x', cron: '0 8 * * *', mode: 'inline', prompt: 'p' });
    expect(r.isError).toBe(true);
    expect(fs.readFileSync(scheduleFile(folder), 'utf8')).toBe('{ not json');
  });
});

describe('assistant_schedule_list / assistant_schedule_remove', () => {
  it("marks the caller's jobs and shows done and invalid entries with last / next run", async () => {
    const { folder, scheduler, stateDir } = await setup();
    fs.writeFileSync(
      scheduleFile(folder),
      JSON.stringify({
        jobs: [
          { id: 'mine', name: 'Mine', cron: '0 8 * * *', mode: 'inline', prompt: 'p', enabled: true, originSessionId: 'coding-session' },
          { id: 'theirs', name: 'Theirs', cron: '0 9 * * *', mode: 'inline', prompt: 'p', enabled: true, originSessionId: 'other' },
          { id: 'once', name: 'Once', at: '2026-06-01T09:30:00Z', mode: 'isolated', prompt: 'p', enabled: true },
          { id: 'broken', name: 'Broken', mode: 'inline', prompt: 'p', enabled: true },
        ],
      }),
    );
    // A completed one-shot: its run is in the log.
    fs.writeFileSync(
      path.join(stateDir, 'assistant-runs.jsonl'),
      JSON.stringify({ jobId: 'once', time: '2026-06-01T09:30:01Z', scheduledFor: '2026-06-01T09:30:00.000Z', mode: 'isolated', outcome: 'fired' }) + '\n',
    );
    // The run log is loaded at start: restart the scheduler on the same dirs.
    scheduler.stop();
    const restarted = new AssistantScheduler({ folder, stateDir, pool: new FakePool(folder), controller, clock: new FakeClock(T0), systemTimezone: 'UTC' });
    await restarted.start();
    cleanups.push(() => restarted.stop());
    const list = byName(
      createAssistantTools({ folder, access: () => ({ ok: true, backend: restarted }) }, () => ({ sessionId: 'coding-session', cwd: '/c' })),
    ).assistant_schedule_list!;

    const r = await list.execute('t', {});
    expect(r.isError).toBeUndefined();
    const text = r.content[0]!.text;
    expect(text).toContain("User's current timezone: UTC");
    expect(text).toMatch(/\[yours\] mine "Mine"/);
    expect(text).toMatch(/- theirs "Theirs"/);
    expect(text).not.toMatch(/\[yours\] theirs/);
    expect(text).toMatch(/once "Once".*done.*last fired/);
    expect(text).toMatch(/Invalid entries, never run \(1\):\n- entry #3 broken "Broken": exactly one of "cron"/);
    expect(text).toContain('next 2026-06-02T08:00:00.000Z');
    const details = r.details as { jobs: Array<{ job: { id: string }; mine: boolean; state: string }>; invalid: Array<{ id: string }> };
    expect(details.jobs.map((j) => [j.job.id, j.mine, j.state])).toEqual([
      ['mine', true, 'waiting'],
      ['theirs', false, 'waiting'],
      ['once', false, 'done'],
    ]);
    expect(details.invalid.map((i) => i.id)).toEqual(['broken']);
  });

  it('remove removes the job; an unknown id is an isError result', async () => {
    const { folder, tools } = await setup();
    const added = await tools.assistant_schedule_add!.execute('t', { name: 'x', cron: '0 8 * * *', mode: 'inline', prompt: 'p' });
    const id = (added.details as { job: { id: string } }).job.id;
    const unknown = await tools.assistant_schedule_remove!.execute('t', { id: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(readSchedule(folder).jobs).toHaveLength(1);
    const removed = await tools.assistant_schedule_remove!.execute('t', { id });
    expect(removed.isError).toBeUndefined();
    expect(readSchedule(folder).jobs).toEqual([]);
  });
});

describe('assistant_set_timezone and the web report', () => {
  it('a timezone change moves a follows-the-user job (not a pinned one), is recorded and calls onTimezoneChange', async () => {
    const { tools, scheduler, stateDir, tzChanges } = await setup();
    await tools.assistant_schedule_add!.execute('t', { name: 'follows', cron: '0 8 * * *', mode: 'inline', prompt: 'p' });
    await tools.assistant_schedule_add!.execute('t', { name: 'pinned', cron: '0 18 * * *', tz: 'America/New_York', mode: 'inline', prompt: 'p' });
    const nextOf = (name: string) => scheduler.list().jobs.find((j) => j.job.name === name)!.next;
    expect(nextOf('follows')).toBe('2026-06-02T08:00:00.000Z');
    const pinnedBefore = nextOf('pinned');

    const r = await tools.assistant_set_timezone!.execute('t', { timezone: 'Asia/Tokyo' });
    expect(r.isError).toBeUndefined();
    expect(scheduler.getUserTimezone()).toBe('Asia/Tokyo');
    // 08:00 in Tokyo (UTC+9) = 23:00 UTC; at T0 (19:00 Tokyo) the next is tomorrow's.
    expect(nextOf('follows')).toBe('2026-06-01T23:00:00.000Z');
    expect(nextOf('pinned')).toBe(pinnedBefore);
    expect(tzChanges).toEqual(['Asia/Tokyo']);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'assistant-timezone.json'), 'utf8'));
    expect(state.history.at(-1)).toMatchObject({ timezone: 'Asia/Tokyo', source: 'assistant_set_timezone' });

    // The web's report (another zone) goes through the same setter.
    expect(setTimezone(scheduler, { timezone: 'Europe/Paris' }, WEB_TIMEZONE_SOURCE).ok).toBe(true);
    expect(nextOf('follows')).toBe('2026-06-02T06:00:00.000Z');
    expect(tzChanges).toEqual(['Asia/Tokyo', 'Europe/Paris']);
    // Unchanged: nothing recorded, nothing pushed.
    expect(setTimezone(scheduler, { timezone: 'Europe/Paris' }, WEB_TIMEZONE_SOURCE)).toMatchObject({ ok: true, details: { changed: false } });
    expect(tzChanges).toHaveLength(2);
  });

  it('an unknown zone is an isError result and writes nothing', async () => {
    const { tools, stateDir, tzChanges } = await setup();
    const file = path.join(stateDir, 'assistant-timezone.json');
    const before = fs.readFileSync(file, 'utf8');
    for (const timezone of ['Mars/Olympus', '', 42]) {
      const r = await tools.assistant_set_timezone!.execute('t', { timezone });
      expect(r.isError).toBe(true);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(tzChanges).toEqual([]);
  });
});

describe('lock held by another server', () => {
  it('every tool answers a clear lock-state error and touches nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-tools-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const lock = { state: 'refused', message: 'assistant folder /a is in use by another wherever server on this host (pid 42).' };
    const hooks: AssistantSessionHooks = { folder: path.join(root, 'assistant'), access: () => ({ ok: false, error: assistantNotActiveError(lock) }) };
    const tools = createAssistantTools(hooks, () => ({ sessionId: 's', cwd: root })) as unknown as AnyTool[];
    for (const t of tools) {
      const r = await t.execute('t', { name: 'x', at: 'now', mode: 'isolated', prompt: 'p', id: 'x', timezone: 'UTC' });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('NOT active on this server (folder lock refused)');
      expect(r.content[0]!.text).toContain('pid 42');
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('the tool text', () => {
  it('registers the four tools with the shared text', async () => {
    const { tools } = await setup();
    for (const text of ASSISTANT_SCHEDULE_TOOL_TEXTS) {
      const t = tools[text.name] as unknown as Record<string, unknown>;
      expect(t).toBeDefined();
      expect(t.description).toBe(text.description);
      expect(t.promptSnippet).toBe(text.promptSnippet);
      expect(t.promptGuidelines).toEqual(text.promptGuidelines);
    }
    expect(Object.keys(tools)).toEqual(ASSISTANT_SCHEDULE_TOOL_TEXTS.map((t) => t.name));
  });
});

/** Run an inline extension's `before_agent_start` handler against a prompt. */
function runBeforeAgentStart(ext: InlineExtension, systemPrompt: string): { systemPrompt?: string } | undefined {
  let handler: ((e: unknown) => unknown) | undefined;
  (ext.factory as (pi: unknown) => void)({
    on: (name: string, h: (e: unknown) => unknown) => {
      if (name === 'before_agent_start') handler = h;
    },
  });
  return handler!({ type: 'before_agent_start', systemPrompt }) as { systemPrompt?: string } | undefined;
}

describe('the timezone line', () => {
  it('appends to the prompt the event carries, reading the zone every turn', () => {
    let tz: string | null = 'Europe/Paris';
    const ext = createTimezoneLineExtension(() => tz);
    expect(runBeforeAgentStart(ext, 'BASE + another extension')).toEqual({
      systemPrompt: `BASE + another extension\n\n${timezoneLine('Europe/Paris')}`,
    });
    tz = 'Asia/Tokyo';
    expect(runBeforeAgentStart(ext, 'BASE')?.systemPrompt).toBe(appendTimezoneLine('BASE', 'Asia/Tokyo'));
    expect(timezoneLine('Asia/Tokyo')).toBe("User's current timezone: Asia/Tokyo");
    // Not active (no zone known): nothing appended.
    tz = null;
    expect(runBeforeAgentStart(ext, 'BASE')).toBeUndefined();
  });

  it('applies to the assistant folder and its jobs/ only', () => {
    const folder = '/home/u/assistant';
    expect(isAssistantFolderCwd('/home/u/assistant', folder)).toBe(true);
    expect(isAssistantFolderCwd('/home/u/assistant/', folder)).toBe(true);
    expect(isAssistantFolderCwd('/home/u/assistant/jobs', folder)).toBe(true);
    expect(isAssistantFolderCwd('/home/u/assistant/memory', folder)).toBe(false);
    expect(isAssistantFolderCwd('/home/u/code', folder)).toBe(false);
    expect(isAssistantFolderCwd('/home/u/assistant-other', folder)).toBe(false);

    const hooks: AssistantSessionHooks = { folder, access: () => ({ ok: false, error: 'off' }) };
    const caller = () => ({ sessionId: 's', cwd: '/x' });
    expect(assistantSessionParts(hooks, '/home/u/code', caller).extensionFactories).toEqual([]);
    expect(assistantSessionParts(hooks, '/home/u/code', caller).customTools).toHaveLength(4);
    expect(assistantSessionParts(hooks, folder, caller).extensionFactories).toHaveLength(1);
    expect(assistantSessionParts(hooks, path.join(folder, 'jobs'), caller).extensionFactories).toHaveLength(1);
    expect(assistantSessionParts(undefined, folder, caller)).toEqual({ customTools: [], extensionFactories: [] });
  });
});

describe('composeServerAgentParts (what buildServerAgent registers)', () => {
  const conversationExtension: InlineExtension = { name: 'conv', factory: () => {} };
  const extra: InlineExtension = { name: 'extra', factory: () => {} };
  const caller = () => ({ sessionId: 's', cwd: '/x' });

  it('assistantFolder unset: exactly the pre-assistant extension list and tools', () => {
    for (const cwd of ['/home/u/code', '/home/u/assistant', '/home/u/assistant/jobs']) {
      const parts = composeServerAgentParts({ cwd, conversationExtension, extraExtensionFactories: [extra], assistant: undefined, caller });
      expect(parts.extensionFactories).toEqual([...serverBuiltinExtensions, conversationExtension, extra]);
      parts.extensionFactories.forEach((f, i) => expect(f).toBe([...serverBuiltinExtensions, conversationExtension, extra][i]));
      expect(parts.customTools.map((t) => t.name)).toEqual(['attach_file', 'say']);
    }
  });

  it('assistantFolder set: the tools in every session, the timezone line only in the folder', () => {
    const hooks: AssistantSessionHooks = { folder: '/home/u/assistant', access: () => ({ ok: false, error: 'off' }) };
    const elsewhere = composeServerAgentParts({ cwd: '/home/u/code', conversationExtension, extraExtensionFactories: [], assistant: hooks, caller });
    expect(elsewhere.customTools.map((t) => t.name)).toEqual(['attach_file', 'say', ...ASSISTANT_SCHEDULE_TOOL_TEXTS.map((t) => t.name)]);
    expect(elsewhere.extensionFactories).toEqual([...serverBuiltinExtensions, conversationExtension]);
    const inFolder = composeServerAgentParts({ cwd: '/home/u/assistant', conversationExtension, extraExtensionFactories: [], assistant: hooks, caller });
    expect(inFolder.extensionFactories.map((f) => f.name)).toEqual([
      ...serverBuiltinExtensions.map((f) => f.name),
      'conv',
      'wherever-assistant-timezone',
    ]);
  });
});
