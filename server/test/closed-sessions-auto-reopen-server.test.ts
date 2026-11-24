import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openShipmates, type Shipmates } from 'shipmates';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * A closed session reopens itself on new activity, end to end (ADR 0025,
 * session-auto-reopen.ts): a REAL server with the REAL @shipmates/pi extension
 * in its sessions, against the fake LLM.
 *
 * - a server session reopens on a web user message (its turn's `agent_start`
 *   and user `message_end`) and on a shipmates delivery that wakes it;
 * - a CLI-bridged session reopens on a forwarded `agent_start` alone, and on a
 *   forwarded user `message_end` alone;
 * - a closed session with an open inbox item created after its close reopens on
 *   the next shipmates change; one whose item is older stays closed;
 * - every reopen broadcasts `sessions_updated`;
 * - a reopen write that fails (the store went corrupt under the loaded set) is
 *   logged and the turn still streams.
 *
 * Isolation: `WHEREVER_STATE_DIR` is a temp dir of this file; shipmates' database
 * is this file's temp home (setup-isolate-env.ts sets SHIPMATES_STATE_DIR, which
 * the server inherits), created BEFORE the server starts. The real
 * `~/.wherever` (found through `os.userInfo()`, which ignores HOME) is asserted
 * untouched.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIPMATES_PI_DIR = fs.realpathSync(path.join(here, '..', 'node_modules', '@shipmates/pi'));
const REAL_WHEREVER_DIR = path.join(os.userInfo().homedir, '.wherever');
const snapshotDir = (d: string) => {
  try {
    return fs
      .readdirSync(d)
      .sort()
      .map((n) => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`)
      .join(',');
  } catch {
    return 'ABSENT';
  }
};
const realBefore = snapshotDir(REAL_WHEREVER_DIR);

let h: Harness;
let shipmates: Shipmates;
let stateDir: string;

beforeAll(async () => {
  expect(process.env.SHIPMATES_STATE_DIR?.startsWith(os.tmpdir())).toBe(true);
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-reopen-state-'));
  shipmates = openShipmates();
  h = await startHarness({ env: { SHIPMATES_POLL_MS: '100', WHEREVER_STATE_DIR: stateDir } });
  const settings = path.join(h.agentDir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), extensions: [SHIPMATES_PI_DIR] }));
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
  shipmates?.close();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  expect(snapshotDir(REAL_WHEREVER_DIR)).toBe(realBefore);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${h.port}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function close(sessionFile: string): Promise<void> {
  const r = await api('/sessions/close', { sessionFile, closed: true });
  expect(r.status).toBe(200);
  expect(r.body.sessions).toEqual([path.resolve(sessionFile)]);
}

const storedClosed = (): string[] => {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'closed-sessions.json'), 'utf8')).closed.map((s: any) => s.sessionFile);
  } catch {
    return [];
  }
};

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}

/** A `sessions_updated` that arrives after `mark` (the client's message count then). */
const sessionsUpdatedAfter = (c: TestClient, mark: number) =>
  c.waitFor((m) => m.type === 'sessions_updated' && c.messages.indexOf(m) >= mark, 10_000);

/** Wait until the fake model saw no new request for a while (shipmates wakes can trail a test). */
async function quiet(): Promise<void> {
  for (let n = -1, since = Date.now(); Date.now() - since < 1500; await sleep(100)) {
    if (h.fake.requests().length !== n) {
      n = h.fake.requests().length;
      since = Date.now();
    }
  }
}

async function newSession(c: TestClient, name: string): Promise<{ sessionId: string; sessionFile: string }> {
  // Each in its own folder: a second live session in one folder opens read-only.
  const cwd = path.join(h.workspace, name);
  fs.mkdirSync(cwd, { recursive: true });
  const mark = c.messages.length;
  c.send({ type: 'session_new', cwd });
  const created = await c.waitFor((m) => m.type === 'session_created' && c.messages.indexOf(m) >= mark, 30_000);
  return { sessionId: created.sessionId as string, sessionFile: created.sessionFile as string };
}

/** One full web turn, so the transcript exists on disk. */
async function turn(c: TestClient, sessionId: string, text: string, reply: string): Promise<void> {
  const mark = c.messages.length;
  h.fake.queue({ kind: 'reply', text: reply });
  c.send({ type: 'message', sessionId, message: text });
  await c.waitFor((m) => m.type === 'agent_end' && m.sessionId === sessionId && c.messages.indexOf(m) >= mark, 30_000);
}

describe('a closed server session reopens itself', () => {
  it('on a web user message, broadcasting sessions_updated', async () => {
    const web = await h.connect();
    const s = await newSession(web, 'web-message');
    await turn(web, s.sessionId, 'first', 'one');
    await quiet();
    await close(s.sessionFile);
    expect(storedClosed()).toContain(s.sessionFile);

    const mark = web.messages.length;
    await turn(web, s.sessionId, 'I am back', 'welcome back');
    await sessionsUpdatedAfter(web, mark);
    expect(storedClosed()).not.toContain(s.sessionFile);
    web.close();
  }, 90_000);

  it('on a shipmates delivery that wakes it', async () => {
    // `shipmates: '1'`: a client that renders shipmates cards gets `shipmates_delivery` frames.
    const web = await h.connect(undefined, { shipmates: '1' });
    const s = await newSession(web, 'delivery');
    await turn(web, s.sessionId, 'first', 'one');
    await until(() => shipmates.isLive(s.sessionFile));
    await quiet();
    await close(s.sessionFile);

    const mark = web.messages.length;
    h.fake.queue({ kind: 'reply', text: 'got it' });
    shipmates.send({ from: null, to: s.sessionFile, text: 'the build is green, carry on' });
    await web.waitFor((m) => m.type === 'shipmates_delivery' && m.sessionId === s.sessionId, 30_000);
    await sessionsUpdatedAfter(web, mark);
    expect(storedClosed()).not.toContain(s.sessionFile);
    web.close();
  }, 90_000);

  it('a reopen write that fails is logged and never breaks the turn', async () => {
    const web = await h.connect();
    const s = await newSession(web, 'corrupt');
    await turn(web, s.sessionId, 'first', 'one');
    await quiet();
    await close(s.sessionFile);
    // The server's in-memory set still says closed; the file under it is now unreadable.
    const store = path.join(stateDir, 'closed-sessions.json');
    const good = fs.readFileSync(store, 'utf8');
    fs.writeFileSync(store, '{not json');
    try {
      const mark = web.messages.length;
      h.fake.queue({ kind: 'reply', text: 'still streaming' });
      web.send({ type: 'message', sessionId: s.sessionId, message: 'hello?' });
      const end = await web.waitFor((m) => m.type === 'agent_end' && m.sessionId === s.sessionId && web.messages.indexOf(m) >= mark, 30_000);
      expect(end).toBeTruthy();
      expect(web.messages.slice(mark).some((m) => m.type === 'message_end' && (m as any).role === 'assistant')).toBe(true);
      await until(() => /could not reopen closed session/.test(h.output()));
      expect(fs.readFileSync(store, 'utf8')).toBe('{not json');
    } finally {
      fs.writeFileSync(store, good);
    }
    web.close();
  }, 90_000);
});

describe('a closed CLI-bridged session reopens itself', () => {
  it('on a forwarded agent_start alone, and on a forwarded user message_end alone', async () => {
    const web = await h.connect();
    await web.waitForType('connected');
    const dir = path.join(h.agentDir, 'sessions', '--cli--');
    fs.mkdirSync(dir, { recursive: true });
    const sessionFile = path.join(dir, 'cli-reopen.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'cli-reopen', cwd: h.workspace, timestamp: new Date().toISOString() }) + '\n');
    const cli = await h.connect();
    await cli.waitForType('connected');
    cli.send({ type: 'cli_register', sessionFile, cwd: h.workspace, model: 'fake:fake-model' });
    await h.waitForActive(sessionFile);

    await close(sessionFile);
    let mark = web.messages.length;
    cli.send({ type: 'cli_event', event: { type: 'agent_start' } });
    await sessionsUpdatedAfter(web, mark);
    await until(() => !storedClosed().includes(sessionFile));
    cli.send({ type: 'cli_event', event: { type: 'agent_end' } });

    await sleep(2100); // past the sessions_updated throttle window
    await close(sessionFile);
    mark = web.messages.length;
    cli.send({ type: 'cli_event', event: { type: 'message_end', message: { role: 'user', content: 'typed in the terminal', timestamp: Date.now() } } });
    await sessionsUpdatedAfter(web, mark);
    await until(() => !storedClosed().includes(sessionFile));

    // Tool events (what a `!command` emits) do not reopen it.
    await close(sessionFile);
    cli.send({ type: 'cli_event', event: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } } });
    cli.send({ type: 'cli_event', event: { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: {}, isError: false } });
    await sleep(500);
    expect(storedClosed()).toContain(sessionFile);
    await api('/sessions/close', { sessionFile, closed: false });
    cli.close();
    web.close();
  }, 60_000);
});

describe('a closed session with a newer inbox item reopens itself', () => {
  it('on the next shipmates change; one whose item predates the close stays closed', async () => {
    const web = await h.connect();
    const dir = path.join(h.agentDir, 'sessions', '--inbox--');
    fs.mkdirSync(dir, { recursive: true });
    const older = path.join(dir, 'older.jsonl');
    const newer = path.join(dir, 'newer.jsonl');
    for (const f of [older, newer]) {
      fs.writeFileSync(f, JSON.stringify({ type: 'session', id: path.basename(f, '.jsonl'), cwd: h.workspace, timestamp: new Date().toISOString() }) + '\n');
      shipmates.register({ sessionFile: f, cwd: h.workspace });
    }
    // Real clocks on both sides (the server's Date.now and shipmates'): space the steps.
    shipmates.humanAsk({ from: older, question: 'Asked before the close?' });
    await sleep(20);
    await close(older);
    await close(newer);
    await sleep(20);
    // A change with only the older item open: nothing reopens.
    shipmates.update(older, { status: 'poke' });
    await sleep(800);
    expect(storedClosed()).toEqual(expect.arrayContaining([older, newer]));

    const mark = web.messages.length;
    shipmates.humanAsk({ from: newer, question: 'Asked after the close?' });
    await until(() => !storedClosed().includes(newer));
    await sessionsUpdatedAfter(web, mark);
    expect(storedClosed()).toContain(older);
    const listed = (await api('/sessions')).body.folders.flatMap((f: any) => f.sessions);
    expect(listed.find((s: any) => s.path === newer)?.closed).toBeUndefined();
    expect(listed.find((s: any) => s.path === older)?.closed).toBe(true);
    web.close();
  }, 60_000);
});
