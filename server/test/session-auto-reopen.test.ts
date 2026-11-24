import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openShipmates } from 'shipmates';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createAutoReopen, isReopenEvent, sessionsToReopenForInbox } from '../src/session-auto-reopen.js';
import { closeSessions, getClosedEntry, isSessionClosed, readClosedSet } from '../src/session-closed.js';
import { ShipmatesService } from '../src/shipmates-service.js';

/**
 * A closed session reopens itself on new activity (session-auto-reopen.ts,
 * ADR 0025), in process: which events are triggers, the stateless inbox rule
 * (`createdAt > closedAt`, on ONE clock), no disk read per event, and a failing
 * reopen write that is logged and never thrown. The end-to-end wiring is in
 * `closed-sessions-auto-reopen-server.test.ts`.
 *
 * Isolation: `WHEREVER_STATE_DIR` and shipmates' state dir are temp dirs of each
 * test (setup-isolate-env.ts already points SHIPMATES_STATE_DIR into a temp home).
 */

const ev = (e: Record<string, unknown>) => e as unknown as AgentSessionEvent;
const AGENT_START = ev({ type: 'agent_start' });
const USER_END = ev({ type: 'message_end', message: { role: 'user', content: 'hi' } });
const DELIVERY = ev({ type: 'message_end', message: { role: 'custom', customType: 'shipmates', content: 'x' } });
const DELIVERY_ENTRY = ev({ type: 'entry_appended', entry: { type: 'custom_message', customType: 'shipmates', content: 'x' } });

const quiet = { error: vi.fn() };
const cleanups: Array<() => void> = [];
const savedStateDir = process.env.WHEREVER_STATE_DIR;
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  if (savedStateDir === undefined) delete process.env.WHEREVER_STATE_DIR;
  else process.env.WHEREVER_STATE_DIR = savedStateDir;
  vi.restoreAllMocks();
  quiet.error.mockClear();
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useStateDir(): string {
  const dir = tmpDir('wherever-reopen-state-');
  process.env.WHEREVER_STATE_DIR = dir;
  return dir;
}

describe('which agent events reopen', () => {
  it('agent_start, a user message_end and a shipmates delivery (message or entry); nothing else', () => {
    expect(isReopenEvent(AGENT_START)).toBe(true);
    expect(isReopenEvent(USER_END)).toBe(true);
    expect(isReopenEvent(DELIVERY)).toBe(true);
    expect(isReopenEvent(DELIVERY_ENTRY)).toBe(true);

    expect(isReopenEvent(ev({ type: 'message_end', message: { role: 'assistant', content: [] } }))).toBe(false);
    expect(isReopenEvent(ev({ type: 'message_end', message: { role: 'custom', customType: 'other' } }))).toBe(false);
    expect(isReopenEvent(ev({ type: 'entry_appended', entry: { type: 'custom_message', customType: 'other' } }))).toBe(false);
    expect(isReopenEvent(ev({ type: 'agent_end' }))).toBe(false);
    expect(isReopenEvent(ev({ type: 'message_update', message: { role: 'assistant' } }))).toBe(false);
    // A `!command` in a CLI terminal emits only tool events: not a trigger, by design.
    expect(isReopenEvent(ev({ type: 'tool_execution_start', toolName: 'bash' }))).toBe(false);
    expect(isReopenEvent(ev({ type: 'tool_execution_end', toolName: 'bash' }))).toBe(false);
  });
});

describe('the inbox rule', () => {
  it('reopens a closed session with an item created after its close, once; never one created before', () => {
    const closedAt = new Map([
      ['/s/a.jsonl', 100],
      ['/s/b.jsonl', 100],
    ]);
    const at = (f: string) => closedAt.get(f);
    expect(
      sessionsToReopenForInbox(
        [
          { sessionFile: '/s/a.jsonl', createdAt: 101 },
          { sessionFile: '/s/a.jsonl', createdAt: 150 },
          { sessionFile: '/s/b.jsonl', createdAt: 99 },
          { sessionFile: '/s/b.jsonl', createdAt: 100 },
          { sessionFile: '/s/open.jsonl', createdAt: 500 },
        ],
        at,
      ),
    ).toEqual(['/s/a.jsonl']);
  });
});

describe('createAutoReopen', () => {
  it('reopens on each trigger, calls onReopened, and never touches a session that is not closed', () => {
    const closed = new Set(['/s/a.jsonl']);
    const reopened: string[][] = [];
    const r = createAutoReopen({
      isClosed: (f) => closed.has(f),
      closedAt: () => undefined,
      noneClosed: () => closed.size === 0,
      reopen: (files) => {
        const hit = files.filter((f) => closed.delete(f));
        return hit;
      },
      onReopened: (files) => reopened.push(files),
      log: quiet,
    });
    r.onEvent('/s/open.jsonl', AGENT_START);
    r.onEvent('/s/a.jsonl', ev({ type: 'agent_end' }));
    expect(reopened).toEqual([]);
    for (const e of [AGENT_START, USER_END, DELIVERY, DELIVERY_ENTRY]) {
      closed.add('/s/a.jsonl');
      r.onEvent('/s/a.jsonl', e);
      expect(closed.has('/s/a.jsonl')).toBe(false);
    }
    expect(reopened).toEqual([['/s/a.jsonl'], ['/s/a.jsonl'], ['/s/a.jsonl'], ['/s/a.jsonl']]);
  });

  it('a reopen write that throws is logged, never thrown, and the next trigger tries again', () => {
    let fail = true;
    const onReopened = vi.fn();
    const r = createAutoReopen({
      isClosed: () => true,
      reopen: (files) => {
        if (fail) throw new Error('disk full');
        return files;
      },
      onReopened,
      log: quiet,
    });
    expect(() => r.onEvent('/s/a.jsonl', AGENT_START)).not.toThrow();
    expect(quiet.error).toHaveBeenCalledWith(expect.stringMatching(/could not reopen.*disk full/));
    expect(onReopened).not.toHaveBeenCalled();
    fail = false;
    r.onEvent('/s/a.jsonl', USER_END);
    expect(onReopened).toHaveBeenCalledWith(['/s/a.jsonl']);
  });

  it('a throwing inbox read or onReopened is logged, never thrown', () => {
    const r = createAutoReopen({
      isClosed: () => true,
      closedAt: () => 0,
      noneClosed: () => false,
      reopen: (files) => files,
      onReopened: () => {
        throw new Error('broadcast failed');
      },
      log: quiet,
    });
    expect(() =>
      r.onInbox(() => {
        throw new Error('db locked');
      }),
    ).not.toThrow();
    expect(() => r.onInbox(() => [{ sessionFile: '/s/a.jsonl', createdAt: 1 }])).not.toThrow();
    expect(() => r.onEvent('/s/a.jsonl', AGENT_START)).not.toThrow();
    expect(quiet.error).toHaveBeenCalledWith(expect.stringMatching(/db locked/));
    expect(quiet.error).toHaveBeenCalledWith(expect.stringMatching(/broadcast failed/));
  });

  it('does not read the inbox while nothing is closed', () => {
    const inbox = vi.fn(() => []);
    const r = createAutoReopen({ noneClosed: () => true, onReopened: () => {}, log: quiet });
    r.onInbox(inbox);
    expect(inbox).not.toHaveBeenCalled();
  });
});

describe('against the real store', () => {
  it('checks membership in memory: no disk read per agent event; only a hit writes', () => {
    const dir = useStateDir();
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    closeSessions([a], { now: 1 });
    expect(isSessionClosed(a)).toBe(true); // the in-memory set is loaded
    const onReopened = vi.fn();
    const r = createAutoReopen({ onReopened, log: quiet });

    const reads = vi.spyOn(fs, 'readFileSync');
    const stats = vi.spyOn(fs, 'statSync');
    const exists = vi.spyOn(fs, 'existsSync');
    for (let i = 0; i < 50; i++) {
      r.onEvent(b, AGENT_START);
      r.onEvent(b, USER_END);
      r.onEvent(a, ev({ type: 'message_update', message: { role: 'assistant' } }));
      r.onEvent(a, ev({ type: 'agent_end' }));
    }
    expect(reads).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(onReopened).not.toHaveBeenCalled();

    r.onEvent(a, AGENT_START);
    expect(onReopened).toHaveBeenCalledWith([a]);
    expect(isSessionClosed(a)).toBe(false);
    expect(getClosedEntry(a)).toBeUndefined();
  });

  it('a corrupt store under a loaded set: the reopen fails, is logged, and the event is not thrown', () => {
    const dir = useStateDir();
    const a = path.join(dir, 'a.jsonl');
    closeSessions([a], { now: 1 });
    expect(readClosedSet().has(a)).toBe(true);
    fs.writeFileSync(path.join(dir, 'closed-sessions.json'), '{not json');
    const onReopened = vi.fn();
    const r = createAutoReopen({ onReopened, log: quiet });
    expect(() => r.onEvent(a, AGENT_START)).not.toThrow();
    expect(quiet.error).toHaveBeenCalledWith(expect.stringMatching(/could not reopen/));
    expect(onReopened).not.toHaveBeenCalled();
    // Never overwritten as empty.
    expect(fs.readFileSync(path.join(dir, 'closed-sessions.json'), 'utf8')).toBe('{not json');
  });

  it('with ShipmatesService on an injected shipmates clock, closedAt on the same clock', async () => {
    const stateDir = useStateDir();
    const shipmatesDir = path.join(tmpDir('wherever-reopen-shipmates-'), 'shipmates');
    let clock = 1_000_000;
    const now = () => clock;
    const k = openShipmates({ stateDir: shipmatesDir, now });
    cleanups.push(() => k.close());
    const sessions = path.join(stateDir, 'sessions');
    const before = path.join(sessions, 'before.jsonl');
    const after = path.join(sessions, 'after.jsonl');
    for (const f of [before, after]) k.register({ sessionFile: f, cwd: '/home/u/lane' });

    // `before` asks, THEN is closed; `after` is closed, then asks.
    clock = 1_000_100;
    k.humanAsk({ from: before, question: 'Old question?' });
    clock = 1_000_200;
    closeSessions([before, after], { now: clock });
    clock = 1_000_300;

    const reopened: string[][] = [];
    const r = createAutoReopen({ onReopened: (f) => reopened.push(f), log: quiet });
    const svc: ShipmatesService = new ShipmatesService({
      enabled: true,
      whereverStateDir: stateDir,
      shipmatesStateDir: shipmatesDir,
      onUpdate: () => {},
      onShipmatesChange: () => r.onInbox(() => svc.snapshot().inbox),
      throttleMs: 0,
      pollMs: 20,
      openPollMs: 20,
      shipmatesNow: now,
      log: { log() {}, warn() {}, error() {} },
    });
    cleanups.push(() => svc.stop());
    svc.start();
    await svc.ready();

    // A change with only the older item open: nothing reopens.
    k.update(before, { status: 'still here' });
    await new Promise((res) => setTimeout(res, 200));
    expect(reopened).toEqual([]);
    expect(isSessionClosed(before)).toBe(true);

    k.humanAsk({ from: after, question: 'New question?' });
    const end = Date.now() + 3000;
    while (reopened.length === 0 && Date.now() < end) await new Promise((res) => setTimeout(res, 10));
    expect(reopened).toEqual([[path.resolve(after)]]);
    expect(isSessionClosed(after)).toBe(false);
    // Stateless: the older item still does not reopen `before`, on any later change.
    expect(isSessionClosed(before)).toBe(true);
  });
});
