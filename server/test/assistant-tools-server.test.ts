import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness, type TestClient } from './harness.js';
import { timezoneLine } from '../src/assistant-tool-text.ts';

/**
 * The assistant tools and the timezone line against the REAL server (real pi,
 * fake LLM):
 *  - `assistantFolder` unset: no `assistant_*` tool reaches the model, no
 *    timezone line, and the web's `client_timezone` report writes nothing;
 *  - active: a NON-assistant session's `assistant_schedule_add` lands in the
 *    assistant's `schedule.json` with its origin and runs as the assistant (an
 *    isolated job in `jobs/`); the assistant folder's turns carry the timezone
 *    line; a web report and `assistant_set_timezone` both change it, push
 *    `assistant_info_changed` to CLI bridges and `assistant_status` to the web,
 *    and the next assistant turn carries the new line;
 *  - lock held by another server: the tools answer a lock-state error.
 *
 * Isolation: `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR`
 * point at temp dirs, and the real ~/.wherever is asserted untouched.
 */

const REAL_WHEREVER_DIR = path.join(os.homedir(), '.wherever');
function snapshotDir(dir: string): string {
  if (!fs.existsSync(dir)) return 'ABSENT';
  const entries: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        entries.push(`${prefix}${name}/`);
        walk(full, `${prefix}${name}/`);
      } else if (st.isFile()) {
        const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
        entries.push(`${prefix}${name}:${h}`);
      }
    }
  };
  walk(dir, '');
  return entries.join('\n');
}
const realBefore = snapshotDir(REAL_WHEREVER_DIR);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(() => {
  expect(snapshotDir(REAL_WHEREVER_DIR)).toBe(realBefore);
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-tools-srv-')));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function dirsFor(root: string, name: string) {
  const configDir = path.join(root, `${name}-config`);
  const stateDir = path.join(root, `${name}-state`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { configDir, stateDir };
}

async function boot(root: string, name: string, config: Record<string, unknown>): Promise<Harness> {
  const { configDir, stateDir } = dirsFor(root, name);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  // A fixed system zone, so the reports below are always a change.
  const h = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir, WHEREVER_STATE_DIR: stateDir, TZ: 'UTC' } });
  cleanups.push(() => h.cleanup());
  return h;
}

async function client(h: Harness): Promise<TestClient> {
  const c = await h.connect(crypto.randomUUID());
  await c.waitForType('connected');
  return c;
}

async function assistantStatus(port: number): Promise<any> {
  return (await (await fetch(`http://127.0.0.1:${port}/config`)).json()).assistant;
}

async function until(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function newSession(c: TestClient, cwd: string): Promise<{ sessionId: string; sessionFile: string }> {
  c.send({ type: 'session_new', cwd, forceNew: true });
  const created = await c.waitFor((m) => m.type === 'session_created' && m.cwd === cwd);
  return { sessionId: created.sessionId, sessionFile: created.sessionFile };
}

/** Send one message and wait for the turn's final reply; returns the requests this turn made. */
async function turn(h: Harness, c: TestClient, sessionId: string, text: string, reply: string): Promise<Array<Record<string, any>>> {
  const before = h.fake.requests().length;
  h.setNext({ kind: 'reply', text: reply });
  c.send({ type: 'message', message: text, sessionId });
  await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant' && m.content === reply, 30_000);
  return h.fake.requests().slice(before);
}

/** One turn in which the model calls `toolName` exactly once, then replies `reply`. */
async function toolTurn(h: Harness, c: TestClient, sessionId: string, toolName: string, input: Record<string, unknown>, reply: string) {
  h.fake.queue({ kind: 'tool-call', toolName, input, toolCallId: `toolu_${crypto.randomUUID().slice(0, 8)}` });
  return turn(h, c, sessionId, `please use ${toolName}`, reply);
}

const toolNames = (req: Record<string, any>): string[] => (req.tools ?? []).map((t: { name: string }) => t.name);
const systemOf = (req: Record<string, any>): string => JSON.stringify(req.system ?? '');
const ASSISTANT_TOOLS = ['assistant_schedule_add', 'assistant_schedule_list', 'assistant_schedule_remove', 'assistant_set_timezone'];

describe('assistant tools (real server)', () => {
  it('assistantFolder unset: no assistant tools, no timezone line, and the web timezone report writes nothing', async () => {
    const root = tmp();
    const { stateDir } = dirsFor(root, 'off');
    fs.writeFileSync(path.join(stateDir, 'keep.txt'), 'pre-existing');
    const before = snapshotDir(stateDir);
    const h = await boot(root, 'off', {});
    const c = await client(h);
    c.send({ type: 'client_timezone', timezone: 'Pacific/Auckland' });
    const s = await newSession(c, c.workspace);
    const [req] = await turn(h, c, s.sessionId, 'hello', 'hi');
    expect(toolNames(req!)).toEqual(expect.arrayContaining(['attach_file', 'say']));
    for (const name of ASSISTANT_TOOLS) expect(toolNames(req!)).not.toContain(name);
    expect(systemOf(req!)).not.toContain("User's current timezone");
    const status = await assistantStatus(h.port);
    expect(status).toEqual({ configured: false, folder: null, active: false, lock: null });
    await h.stop();
    expect(snapshotDir(stateDir)).toBe(before);
  }, 90_000);

  it('active: any session schedules for the assistant; the timezone follows the web and the tool, is pushed, and reaches the next assistant turn', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const h = await boot(root, 'on', { assistantFolder: folder });
    const stateDir = path.join(root, 'on-state');
    expect(await assistantStatus(h.port)).toMatchObject({ active: true, timezone: 'UTC' });

    // A terminal pi attached over the bridge: it is pushed every timezone change.
    const cli = await client(h);
    const cliFile = path.join(root, 'cli.jsonl');
    cli.send({ type: 'cli_register', sessionFile: cliFile, cwd: root, model: 'fake:fake-model', isStreaming: false, isNew: false });
    await h.waitForActive(cliFile);
    const infoId = crypto.randomUUID();
    cli.send({ type: 'cli_request', id: infoId, op: 'assistant_info' });
    const info = await cli.waitFor((m) => m.type === 'cli_response' && m.id === infoId);
    expect(info.result).toEqual({ assistantFolder: folder, timezone: 'UTC' });

    const web = await client(h);

    // A coding session elsewhere: it has the tools but no timezone line.
    const coding = await newSession(web, web.workspace);
    const addReqs = await toolTurn(
      h,
      web,
      coding.sessionId,
      'assistant_schedule_add',
      { name: 'Check CI', at: 'now', mode: 'isolated', prompt: 'check CI and tell me' },
      'scheduled',
    );
    expect(toolNames(addReqs[0]!)).toEqual(expect.arrayContaining(ASSISTANT_TOOLS));
    expect(systemOf(addReqs[0]!)).not.toContain("User's current timezone");
    const { jobs } = JSON.parse(fs.readFileSync(path.join(folder, 'schedule.json'), 'utf8'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: 'Check CI',
      at: 'now',
      mode: 'isolated',
      enabled: true,
      originSessionId: coding.sessionId,
      originCwd: web.workspace,
    });
    // It runs as the assistant: an isolated session in jobs/, recorded in the run log.
    const runs = path.join(stateDir, 'assistant-runs.jsonl');
    await until(() => fs.existsSync(runs));
    const run = JSON.parse(fs.readFileSync(runs, 'utf8').trim().split('\n')[0]!);
    expect(run).toMatchObject({ jobId: jobs[0].id, mode: 'isolated', outcome: 'fired' });
    await until(() =>
      h.fake.requests().some((r) =>
        JSON.stringify(r.messages).includes(`[schedule:Check CI] (from ${web.workspace}, session ${coding.sessionId}) check CI and tell me`),
      ),
    );
    const jobReq = h.fake.requests().find((r) => JSON.stringify(r.messages).includes('[schedule:Check CI]'))!;
    // The job session is in jobs/, so it carries the timezone line.
    expect(systemOf(jobReq)).toContain(timezoneLine('UTC'));

    // The assistant session (its own viewer: a web client views one session at a
    // time): its turns carry the line.
    const viewer = await client(h);
    const assistantSession = await newSession(viewer, folder);
    let [req] = await turn(h, viewer, assistantSession.sessionId, 'hello assistant', 'hello');
    expect(systemOf(req!)).toContain(timezoneLine('UTC'));

    // The web reports another zone on connect: it becomes current, pushed to both sides.
    const phone = await client(h);
    phone.send({ type: 'client_timezone', timezone: 'Pacific/Auckland' });
    await cli.waitFor((m) => m.type === 'assistant_info_changed' && m.timezone === 'Pacific/Auckland');
    await web.waitFor((m) => m.type === 'assistant_status' && m.timezone === 'Pacific/Auckland');
    expect(await assistantStatus(h.port)).toMatchObject({ timezone: 'Pacific/Auckland' });
    [req] = await turn(h, viewer, assistantSession.sessionId, 'where am I', 'NZ');
    expect(systemOf(req!)).toContain(timezoneLine('Pacific/Auckland'));
    expect(systemOf(req!)).not.toContain(timezoneLine('UTC'));

    // assistant_set_timezone from the coding session: same path.
    await toolTurn(h, web, coding.sessionId, 'assistant_set_timezone', { timezone: 'Asia/Tokyo' }, 'tz set');
    await cli.waitFor((m) => m.type === 'assistant_info_changed' && m.timezone === 'Asia/Tokyo');
    expect(await assistantStatus(h.port)).toMatchObject({ timezone: 'Asia/Tokyo' });
    [req] = await turn(h, viewer, assistantSession.sessionId, 'and now', 'Tokyo');
    expect(systemOf(req!)).toContain(timezoneLine('Asia/Tokyo'));

    // A bogus report is ignored.
    phone.send({ type: 'client_timezone', timezone: 'Mars/Olympus' });
    await new Promise((r) => setTimeout(r, 200));
    const tzState = JSON.parse(fs.readFileSync(path.join(stateDir, 'assistant-timezone.json'), 'utf8'));
    expect(tzState.timezone).toBe('Asia/Tokyo');
    expect(tzState.history.map((e: { source: string }) => e.source)).toEqual(['system', 'web', 'assistant_set_timezone']);
  }, 180_000);

  it('lock held by another server: the tools answer a clear lock-state error', async () => {
    const root = tmp();
    const folder = path.join(root, 'assistant');
    const first = await boot(root, 'first', { assistantFolder: folder });
    expect((await assistantStatus(first.port)).active).toBe(true);
    const second = await boot(root, 'second', { assistantFolder: folder });
    expect((await assistantStatus(second.port)).lock.state).toBe('refused');
    const c = await client(second);
    const s = await newSession(c, c.workspace);
    const reqs = await toolTurn(second, c, s.sessionId, 'assistant_schedule_list', {}, 'listed');
    expect(toolNames(reqs[0]!)).toEqual(expect.arrayContaining(ASSISTANT_TOOLS));
    const followUp = JSON.stringify(reqs[1]!.messages);
    expect(followUp).toContain('NOT active on this server (folder lock refused)');
    expect(followUp).toContain('in use by another wherever server');
    expect(fs.existsSync(path.join(folder, 'schedule.json'))).toBe(false);
  }, 120_000);
});
