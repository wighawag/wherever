import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AssistantController,
  ASSISTANT_POINTER_FILE,
  type AssistantPoolPort,
} from '../src/assistant-controller.ts';

/**
 * The assistant controller against an injected POOL FAKE (no agent, no LLM):
 * which session is the current assistant session, how a reset retires the old
 * one (abort once, clear + record the queue), what moves the pointer, and that
 * the pointer survives a restart (state dir) and an idle eviction (the next send
 * reloads it). The assistant folder and the state dir are temp dirs; the real
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-assistant-ctl-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'assistant');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(folder, 'jobs'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, folder, stateDir };
}

interface FakeSession {
  file: string;
  id: string;
  cwd: string;
  resident: boolean;
  streaming: boolean;
  steering: string[];
  followUp: string[];
}

/** A pool fake that records every call, and fires `onSessionCreated` like the real pool. */
class FakePool implements AssistantPoolPort {
  sessions = new Map<string, FakeSession>();
  calls: string[] = [];
  pinned = new Set<string>();
  sent: Array<{ file: string; text: string; streamingBehavior?: string }> = [];
  onSessionCreated?: (file: string, cwd: string) => void;
  private n = 0;
  constructor(private root: string) {}

  /** A session that exists on disk (so it survives eviction). */
  addOnDisk(cwd: string, resident = true): FakeSession {
    const s = this.make(cwd, resident);
    fs.writeFileSync(s.file, '{}\n');
    return s;
  }

  private make(cwd: string, resident: boolean): FakeSession {
    this.n += 1;
    const s: FakeSession = {
      file: path.join(this.root, `s${this.n}.jsonl`),
      id: `id-${this.n}`,
      cwd,
      resident,
      streaming: false,
      steering: [],
      followUp: [],
    };
    this.sessions.set(s.file, s);
    return s;
  }

  async createNewSession(cwd: string, _m?: string, _g?: boolean, _r?: boolean, _v?: 'private' | 'public', forceNew?: boolean) {
    this.calls.push(`create:${cwd}:${forceNew ? 'forceNew' : 'reuse'}`);
    const s = this.make(cwd, true);
    this.onSessionCreated?.(s.file, cwd);
    return { tracked: { sessionId: s.id, sessionFile: s.file, cwd } as any, sessionFile: s.file };
  }
  async loadSession(file: string) {
    this.calls.push(`load:${path.basename(file)}`);
    const s = this.sessions.get(file);
    // Resident: handed back as is (like the real pool). Otherwise it needs the file.
    if (!s || (!s.resident && !fs.existsSync(file))) return { tracked: null as any, error: 'Session file not found' };
    s.resident = true;
    return { tracked: { sessionId: s.id, sessionFile: s.file, cwd: s.cwd } as any };
  }
  getSession(file: string) {
    const s = this.sessions.get(file);
    return s && s.resident ? ({ sessionId: s.id, sessionFile: s.file, cwd: s.cwd } as any) : null;
  }
  isStreaming(file: string) {
    return !!this.sessions.get(file)?.resident && !!this.sessions.get(file)?.streaming;
  }
  async abortSession(file: string) {
    this.calls.push(`abort:${path.basename(file)}`);
    const s = this.sessions.get(file);
    if (s) s.streaming = false;
  }
  clearQueuedMessages(file: string) {
    const s = this.sessions.get(file);
    if (!s || !s.resident) return null;
    this.calls.push(`clear:${path.basename(file)}`);
    const out = { steering: s.steering, followUp: s.followUp };
    s.steering = [];
    s.followUp = [];
    return out;
  }
  async sendUserMessage(file: string, text: string, streamingBehavior?: 'steer' | 'followUp') {
    // Like the real pool: a non-resident session silently drops the send.
    if (!this.sessions.get(file)?.resident) return;
    this.sent.push({ file, text, streamingBehavior });
  }
  pinSession(file: string) {
    this.pinned.add(file);
  }
  unpinSession(file: string) {
    this.pinned.delete(file);
  }
  /** Idle eviction: the entry leaves the pool, the file stays on disk. */
  evict(file: string) {
    const s = this.sessions.get(file);
    if (s) s.resident = false;
  }
}

function make(opts?: { root?: string; folder?: string; stateDir?: string; pool?: FakePool }) {
  const d = opts?.root ? { root: opts.root, folder: opts.folder!, stateDir: opts.stateDir! } : dirs();
  const pool = opts?.pool ?? new FakePool(d.root);
  const changes: number[] = [];
  const ctl = new AssistantController({ pool, folder: d.folder, stateDir: d.stateDir, onChange: () => changes.push(1) });
  pool.onSessionCreated = (file, cwd) => void ctl.handleSessionCreated(file, cwd);
  return { ...d, pool, ctl, changes };
}

const pointerOnDisk = (stateDir: string) =>
  JSON.parse(fs.readFileSync(path.join(stateDir, ASSISTANT_POINTER_FILE), 'utf8'));

describe('AssistantController: the current-session pointer', () => {
  it('with no pointer yet, opening creates a session in the folder and points at it', async () => {
    const { ctl, pool, folder, stateDir, changes } = make();
    expect(ctl.status()).toEqual({ currentSessionId: null, currentSessionFile: null });

    const cur = await ctl.ensureCurrent();
    expect(pool.calls).toEqual([`create:${folder}:forceNew`]);
    expect(cur.cwd).toBe(folder);
    expect(ctl.status()).toEqual({ currentSessionId: cur.sessionId, currentSessionFile: cur.sessionFile });
    expect(pointerOnDisk(stateDir)).toMatchObject({ folder, sessionFile: cur.sessionFile, sessionId: cur.sessionId });
    expect(changes.length).toBeGreaterThan(0);

    // Opening again returns the same session, no second create.
    const again = await ctl.ensureCurrent();
    expect(again.sessionFile).toBe(cur.sessionFile);
    expect(pool.calls.filter((c) => c.startsWith('create')).length).toBe(1);
  });

  it('pins the current session and unpins the previous one when the pointer moves', async () => {
    const { ctl, pool } = make();
    const first = await ctl.ensureCurrent();
    expect([...pool.pinned]).toEqual([first.sessionFile]);
    const second = await ctl.reset();
    expect([...pool.pinned]).toEqual([second.sessionFile]);
  });

  it('a session created in the folder moves the pointer; jobs/ and elsewhere never do', async () => {
    const { ctl, pool, folder, root } = make();
    const cur = await ctl.ensureCurrent();

    await pool.createNewSession(path.join(folder, 'jobs'), undefined, undefined, undefined, undefined, true);
    await ctl.idle();
    expect(ctl.status().currentSessionFile).toBe(cur.sessionFile);

    await pool.createNewSession(path.join(root, 'elsewhere'));
    await ctl.idle();
    expect(ctl.status().currentSessionFile).toBe(cur.sessionFile);

    // A trailing slash / unnormalised path is still the folder itself.
    const r = await pool.createNewSession(folder + '/', undefined, undefined, undefined, undefined, true);
    await ctl.idle();
    expect(ctl.status().currentSessionFile).toBe(r.sessionFile);
  });
});

describe('AssistantController: reset', () => {
  it('aborts a running turn exactly once, clears and records the queue, creates forceNew, moves the pointer', async () => {
    const { ctl, pool, folder, stateDir } = make();
    const old = await ctl.ensureCurrent();
    const s = pool.sessions.get(old.sessionFile)!;
    s.streaming = true;
    s.steering = ['steer me'];
    s.followUp = ['later 1', 'later 2'];
    pool.calls.length = 0;

    const next = await ctl.reset();
    await ctl.idle();

    expect(pool.calls).toEqual([
      `abort:${path.basename(old.sessionFile)}`,
      `clear:${path.basename(old.sessionFile)}`,
      `create:${folder}:forceNew`,
    ]);
    expect(next.sessionFile).not.toBe(old.sessionFile);
    expect(ctl.status().currentSessionFile).toBe(next.sessionFile);
    expect(pointerOnDisk(stateDir).sessionFile).toBe(next.sessionFile);
    const dropped = ctl.droppedMessages();
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      sessionFile: old.sessionFile,
      steering: ['steer me'],
      followUp: ['later 1', 'later 2'],
      reason: 'reset',
    });
  });

  it('an idle old session is not aborted, and an empty queue records nothing', async () => {
    const { ctl, pool } = make();
    await ctl.ensureCurrent();
    pool.calls.length = 0;
    await ctl.reset();
    await ctl.idle();
    expect(pool.calls.some((c) => c.startsWith('abort'))).toBe(false);
    expect(ctl.droppedMessages()).toEqual([]);
  });

  it('a web /new in the folder (a session_new, forceNew) is a reset: the old turn is aborted once', async () => {
    const { ctl, pool, folder } = make();
    const old = await ctl.ensureCurrent();
    const s = pool.sessions.get(old.sessionFile)!;
    s.streaming = true;
    s.followUp = ['queued'];
    pool.calls.length = 0;

    // What the server's session_new handler does.
    const r = await pool.createNewSession(folder, undefined, undefined, undefined, undefined, true);
    await ctl.idle();

    expect(ctl.status().currentSessionFile).toBe(r.sessionFile);
    expect(pool.calls.filter((c) => c.startsWith('abort'))).toEqual([`abort:${path.basename(old.sessionFile)}`]);
    expect(ctl.droppedMessages()[0]).toMatchObject({ sessionFile: old.sessionFile, followUp: ['queued'] });
  });

  it('two resets in a row each retire their own predecessor once', async () => {
    const { ctl, pool } = make();
    const a = await ctl.ensureCurrent();
    pool.sessions.get(a.sessionFile)!.streaming = true;
    const [b, c] = await Promise.all([ctl.reset(), ctl.reset()]);
    await ctl.idle();
    expect(b.sessionFile).not.toBe(c.sessionFile);
    expect(ctl.status().currentSessionFile).toBe(c.sessionFile);
    expect(pool.calls.filter((x) => x.startsWith('abort'))).toEqual([`abort:${path.basename(a.sessionFile)}`]);
  });

  it('a late callback for one of its own creations never moves the pointer back', async () => {
    const { ctl, pool } = make();
    const late: Array<[string, string]> = [];
    pool.onSessionCreated = (file, cwd) => void late.push([file, cwd]);
    await ctl.ensureCurrent();
    await ctl.reset();
    const last = await ctl.reset();
    for (const [file, cwd] of late) await ctl.handleSessionCreated(file, cwd);
    expect(ctl.status().currentSessionFile).toBe(last.sessionFile);
  });

  it('a throwing abort does not wedge the reset', async () => {
    const { ctl, pool } = make();
    const a = await ctl.ensureCurrent();
    pool.sessions.get(a.sessionFile)!.streaming = true;
    pool.abortSession = async () => {
      throw new Error('boom');
    };
    const b = await ctl.reset();
    expect(ctl.status().currentSessionFile).toBe(b.sessionFile);
  });
});

describe('AssistantController: restart and idle eviction', () => {
  it('the pointer survives a restart (read back from the state dir)', async () => {
    const first = make();
    const cur = await first.ctl.ensureCurrent();
    fs.writeFileSync(cur.sessionFile, '{}\n'); // the conversation has started, so the file exists

    const pool2 = new FakePool(first.root);
    pool2.sessions.set(cur.sessionFile, { ...first.pool.sessions.get(cur.sessionFile)!, resident: false });
    const second = make({ root: first.root, folder: first.folder, stateDir: first.stateDir, pool: pool2 });
    expect(second.ctl.status()).toEqual({ currentSessionId: cur.sessionId, currentSessionFile: cur.sessionFile });
    expect((await second.ctl.ensureCurrent()).sessionFile).toBe(cur.sessionFile);
    expect(pool2.calls.some((c) => c.startsWith('create'))).toBe(false);
  });

  it('a pointer recorded for another assistant folder is ignored', async () => {
    const first = make();
    const cur = await first.ctl.ensureCurrent();
    fs.writeFileSync(cur.sessionFile, '{}\n');
    const otherFolder = path.join(first.root, 'other-assistant');
    fs.mkdirSync(otherFolder);
    const second = make({ root: first.root, folder: otherFolder, stateDir: first.stateDir });
    expect(second.ctl.status().currentSessionFile).toBeNull();
  });

  it('send reloads an idle-evicted pointer session before delivering', async () => {
    const { ctl, pool } = make();
    const cur = await ctl.ensureCurrent();
    fs.writeFileSync(cur.sessionFile, '{}\n');
    pool.evict(cur.sessionFile);
    pool.calls.length = 0;

    await ctl.send('hello', 'telegram');
    expect(pool.calls).toEqual([`load:${path.basename(cur.sessionFile)}`]);
    expect(pool.sent).toEqual([{ file: cur.sessionFile, text: 'hello', streamingBehavior: undefined }]);
  });

  it('send into a running turn steers it', async () => {
    const { ctl, pool } = make();
    const cur = await ctl.ensureCurrent();
    fs.writeFileSync(cur.sessionFile, '{}\n');
    pool.sessions.get(cur.sessionFile)!.streaming = true;
    await ctl.send('also this', 'telegram');
    expect(pool.sent.at(-1)).toEqual({ file: cur.sessionFile, text: 'also this', streamingBehavior: 'steer' });
  });

  it('an evicted pointer whose session was never written gets a fresh session on send', async () => {
    const { ctl, pool } = make();
    const cur = await ctl.ensureCurrent();
    pool.evict(cur.sessionFile); // no conversation yet, so pi never wrote the file
    await ctl.send('hi', 'schedule:j1');
    const now = ctl.status().currentSessionFile!;
    expect(now).not.toBe(cur.sessionFile);
    expect(pool.sent).toEqual([{ file: now, text: 'hi', streamingBehavior: undefined }]);
  });
});
