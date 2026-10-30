import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { SessionPool } from '../src/session-pool.ts';
import { AssistantController } from '../src/assistant-controller.ts';
import { AssistantScheduler, type SchedulerClock } from '../src/assistant-scheduler.ts';
import { startFakeLlmServer, type FakeLlmServer } from './fake-llm-server.js';

/**
 * The scheduler against the REAL session pool and assistant controller, with
 * real pi agents talking to the fake LLM (ADR 0001). The clock is injected (no
 * real scheduler timer); the agents themselves run for real. Covers what only a
 * real pi can show: an inline job waits for `agent_settled` and arrives as its
 * own exchange (never folded into the running one), a `/skill:` job is
 * expanded, and an aborted settle that left a steer queued is cleared so inline
 * jobs fire again.
 *
 * PI_CODING_AGENT_DIR, WHEREVER_CONFIG_DIR and WHEREVER_STATE_DIR are temp
 * dirs, as are the assistant folder and the scheduler's state dir; the real
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

let root: string;
let fake: FakeLlmServer;
const savedEnv: Record<string, string | undefined> = {};
const stops: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  fake = await startFakeLlmServer({ kind: 'reply', text: 'ok' });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-scheduler-pool-')));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
    ['WHEREVER_STATE_DIR', 'wherever-state'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: { fake: { baseUrl: fake.url, api: 'anthropic-messages', apiKey: 'test-key', models: [{ id: 'fake-model' }] } },
    }),
  );
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }));
  const skillDir = path.join(agentDir, 'skills', 'schedule-probe');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: schedule-probe\ndescription: A probe skill for the scheduler test.\n---\n\nSCHEDULE-PROBE-BODY-4417\n',
  );
});

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  fake.setNext({ kind: 'reply', text: 'ok' });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fake.close();
  fs.rmSync(root, { recursive: true, force: true });
  expect(snapshot(REAL_WHEREVER_DIR)).toBe(realBefore);
});

const clock: SchedulerClock = { now: () => Date.parse('2026-06-01T10:00:00Z'), setTimeout: () => () => {} };

async function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(root, 'case-')));
  const folder = path.join(base, 'assistant');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(path.join(folder, 'jobs'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const pool = new SessionPool(300_000);
  pool.setAssistantFolder(folder);
  const controller = new AssistantController({ pool, folder, stateDir });
  pool.onSessionCreated = (f, cwd) => controller.handleSessionCreated(f, cwd);
  const scheduler = new AssistantScheduler({ folder, stateDir, pool, controller, clock, systemTimezone: 'UTC' });
  stops.push(async () => {
    scheduler.stop();
    await pool.disposeAll();
  });
  const cur = await controller.ensureCurrent();
  const events: Array<{ file: string; event: AgentSessionEvent; dest: string | null }> = [];
  pool.subscribeEvents((file, event, dest) => events.push({ file, event, dest }));
  await scheduler.start();
  const writeJobs = (jobs: unknown[]) => fs.writeFileSync(path.join(folder, 'schedule.json'), JSON.stringify({ jobs }));
  return { folder, stateDir, pool, controller, scheduler, file: cur.sessionFile, events, writeJobs };
}

function textOf(message: any): string {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
  return '';
}

/** The session's timeline: user messages (with their destination) and settles, in order. */
function timeline(events: Array<{ file: string; event: AgentSessionEvent; dest: string | null }>, file: string): string[] {
  const out: string[] = [];
  for (const { file: f, event, dest } of events) {
    if (f !== file) continue;
    if (event.type === 'agent_settled') out.push(`settled${(event as any).aborted ? ' (aborted)' : ''}`);
    if (event.type === 'message_end' && (event as any).message?.role === 'user') out.push(`user ${dest}: ${textOf((event as any).message)}`);
  }
  return out;
}

async function until(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const settles = (events: Array<{ file: string; event: AgentSessionEvent }>, file: string) =>
  events.filter((e) => e.file === file && e.event.type === 'agent_settled').length;

describe('AssistantScheduler with the real pool', () => {
  it('an inline job waits for the running exchange to SETTLE and arrives as its own exchange', async () => {
    const { pool, scheduler, file, events, writeJobs } = await setup();
    fake.setNext({ kind: 'slow-reply', text: 'a slowly streamed answer', charDelayMs: 20 });
    void pool.sendUserMessage(file, 'hello from the web', undefined, false, 'none').catch(() => {});
    await until(() => events.some((e) => e.file === file && e.event.type === 'message_update'));
    writeJobs([{ id: 'j1', name: 'Brief', at: 'now', mode: 'inline', prompt: 'brief me', enabled: true }]);
    await scheduler.tick();
    expect(timeline(events, file)).toEqual(['user none: hello from the web']); // not merged into the running exchange
    fake.setNext({ kind: 'reply', text: 'ok' });
    await until(() => settles(events, file) >= 2);
    await scheduler.idle();
    expect(timeline(events, file)).toEqual([
      'user none: hello from the web',
      'settled',
      'user schedule:j1: [schedule:Brief] brief me',
      'settled',
    ]);
  }, 60_000);

  it('a `/skill:` job goes without the prefix and is expanded', async () => {
    const { scheduler, file, events, writeJobs } = await setup();
    writeJobs([{ id: 'sk', name: 'Skill', at: 'now', mode: 'inline', prompt: '/skill:schedule-probe and this', enabled: true }]);
    await scheduler.tick();
    await until(() => settles(events, file) >= 1);
    await scheduler.idle();
    const body = fake.requests().at(-1)!;
    const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user');
    const text = textOf(lastUser);
    expect(text).toContain('<skill name="schedule-probe"');
    expect(text).toContain('SCHEDULE-PROBE-BODY-4417');
    expect(text).toContain('and this');
    expect(text).not.toContain('[schedule:');
  }, 60_000);

  it('after an aborted settle with a steer still queued, the queue is cleared and inline jobs fire', async () => {
    const { pool, controller, scheduler, file, events, writeJobs } = await setup();
    fake.setNext({ kind: 'slow-reply', text: 'a long reply that will be aborted midway', charDelayMs: 40 });
    void pool.sendUserMessage(file, 'first', undefined, false, 'none').catch(() => {});
    await until(() => events.some((e) => e.file === file && e.event.type === 'message_update'));
    await pool.sendUserMessage(file, 'queued steer', 'steer', false, 'telegram');
    writeJobs([{ id: 'j2', name: 'After', at: 'now', mode: 'inline', prompt: 'after the abort', enabled: true }]);
    await scheduler.tick();
    fake.setNext({ kind: 'reply', text: 'ok' });
    await pool.abortSession(file);
    await until(() => settles(events, file) >= 2);
    await scheduler.idle();
    expect(pool.getQueuedMessageCount(file)).toBe(0);
    expect(controller.droppedMessages()).toEqual([
      expect.objectContaining({ sessionFile: file, reason: 'aborted', steering: ['queued steer'], followUp: [] }),
    ]);
    expect(timeline(events, file)).toEqual(['user none: first', 'settled (aborted)', 'user schedule:j2: [schedule:After] after the abort', 'settled']);
  }, 60_000);

  it('an isolated job starts at once in jobs/ while the assistant is busy', async () => {
    const { pool, folder, scheduler, file, events, writeJobs } = await setup();
    fake.setNext({ kind: 'slow-reply', text: 'busy busy busy busy', charDelayMs: 30 });
    void pool.sendUserMessage(file, 'keep busy', undefined, false, 'none').catch(() => {});
    await until(() => events.some((e) => e.file === file && e.event.type === 'message_update'));
    writeJobs([{ id: 'iso', name: 'Iso', at: 'now', mode: 'isolated', prompt: 'side work', enabled: true }]);
    await scheduler.tick();
    await until(() => events.some((e) => e.file !== file && e.event.type === 'message_end' && (e.event as any).message?.role === 'user'));
    expect(pool.isStreaming(file)).toBe(true); // the assistant is still mid-reply
    const jobEvent = events.find((e) => e.file !== file && e.event.type === 'message_end' && (e.event as any).message?.role === 'user')!;
    expect(pool.getSession(jobEvent.file)!.cwd).toBe(path.join(folder, 'jobs'));
    expect(jobEvent.dest).toBe('schedule:iso');
    expect(scheduler.jobForSession(jobEvent.file)).toBe('iso');
    expect(timeline(events, file)).toEqual(['user none: keep busy']);
  }, 60_000);
});
