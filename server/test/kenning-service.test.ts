import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openKenning, type Kenning } from 'kenning';
import {
  KENNING_NOTIFIED_FILE,
  KenningService,
  kenningNotification,
  kenningStateDir,
  sessionIdOf,
  type KenningNotification,
  type KenningSnapshot,
} from '../src/kenning-service.ts';

/**
 * wherever's kenning host half (kenning-service.ts): the inbox and presence
 * snapshot pushed to dashboards, the web answer as a human act, and blocking
 * items pushed ONCE (recorded in wherever's state dir), a channel reply
 * answering the item it notified. Against the REAL kenning core on a temp
 * state dir; no pi.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const quiet = { log() {}, warn() {}, error() {} };

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-kenning-svc-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, kenningDir: path.join(root, 'kenning'), stateDir: path.join(root, 'wherever-state') };
}

function service(d: ReturnType<typeof dirs>, extra: Partial<ConstructorParameters<typeof KenningService>[0]> = {}) {
  const updates: KenningSnapshot[] = [];
  const svc = new KenningService({
    enabled: true,
    whereverStateDir: d.stateDir,
    kenningStateDir: d.kenningDir,
    onUpdate: (s) => updates.push(s),
    throttleMs: 0,
    pollMs: 20,
    openPollMs: 20,
    log: quiet,
    ...extra,
  });
  cleanups.push(() => svc.stop());
  return { svc, updates };
}

function db(d: ReturnType<typeof dirs>): Kenning {
  const k = openKenning({ stateDir: d.kenningDir });
  cleanups.push(() => k.close());
  return k;
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const SESSION = (root: string) => path.join(root, 'sessions', '2026-11-18T10-00-00-000Z_0b7c5e7a-1111-4222-8333-944455556666.jsonl');

describe('KenningService', () => {
  it('stays off (and writes nothing) until kenning\'s database exists, then opens it', async () => {
    const d = dirs();
    const { svc, updates } = service(d);
    svc.start();
    expect(svc.available).toBe(false);
    expect(svc.snapshot()).toEqual({ available: false, inbox: [], presence: [] });
    expect(fs.existsSync(d.kenningDir)).toBe(false);
    expect(svc.answer('h_x', 'yes', 'web')).toMatchObject({ ok: false });

    const k = db(d); // kenning-pi (or the CLI) creates it
    k.register({ sessionFile: SESSION(d.root), sessionId: '0b7c5e7a-1111-4222-8333-944455556666', cwd: '/home/u/lane' });
    await until(() => svc.available && updates.length > 0);
    expect(updates.at(-1)!.available).toBe(true);
    expect(fs.existsSync(path.join(d.stateDir, KENNING_NOTIFIED_FILE))).toBe(false);
  });

  it('`enabled: false` never opens it', () => {
    const d = dirs();
    db(d);
    const { svc } = service(d, { enabled: false });
    svc.start();
    expect(svc.available).toBe(false);
  });

  it('pushes the inbox and presence on every change, keyed by the normalized session file', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file + '/../' + path.basename(file), sessionId: null, cwd: '/home/u/push-lane' });
    const { svc, updates } = service(d);
    svc.start();
    await until(() => updates.length > 0);
    expect(updates.at(-1)!.presence).toEqual([
      { sessionFile: path.resolve(file + '/../' + path.basename(file)), sessionId: null, roles: [], state: 'idle', status: null, waitingOn: null },
    ]);

    k.claimRole(file + '/../' + path.basename(file), 'tree/push');
    k.update(file + '/../' + path.basename(file), { status: 'rebasing onto main', state: 'running' });
    const item = k.humanAsk({ from: file + '/../' + path.basename(file), question: 'Publish 0.3.0?', options: ['yes', 'no'], blocking: true });
    await until(() => updates.at(-1)!.inbox.length === 1 && updates.at(-1)!.presence[0]?.status === 'rebasing onto main');
    const last = updates.at(-1)!;
    expect(last.presence[0]).toMatchObject({ roles: ['tree/push'], state: 'running', status: 'rebasing onto main' });
    expect(last.inbox[0]).toMatchObject({
      id: item.id,
      question: 'Publish 0.3.0?',
      options: ['yes', 'no'],
      blocking: true,
      sessionFile: path.resolve(file),
      sessionId: '0b7c5e7a-1111-4222-8333-944455556666', // from the file name: the presence had none
      from: 'tree/push',
    });
    // An unchanged database sends nothing more.
    const n = updates.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(updates.length).toBe(n);
  });

  it('a web answer is the human\'s: the asker receives it with origin human and channel web', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, cwd: '/home/u/lane' });
    const item = k.humanAsk({ from: file, question: 'Delete the old branch?' });
    const { svc } = service(d);
    svc.start();
    await svc.ready();
    expect(svc.answer(item.id, '  ', 'web')).toMatchObject({ ok: false });
    expect(svc.answer(item.id, 'yes, delete it', 'web')).toEqual({ ok: true });
    expect(k.item(item.id)).toMatchObject({ state: 'answered', answer: 'yes, delete it', answerChannel: 'web' });
    const delivered = k.pendingFor(file);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ origin: 'human', text: 'yes, delete it', relay: { channel: 'web', itemId: item.id } });
    expect(svc.answer(item.id, 'again', 'web')).toMatchObject({ ok: false });
  });

  it('pushes each BLOCKING item once, across restarts, and a reply to its message answers it', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, sessionId: 'sid-1', cwd: '/home/u/lane' });
    const blocking = k.humanAsk({ from: file, question: 'Approve the MIT license?', blocking: true });
    k.humanAsk({ from: file, question: 'Not urgent: which name do you prefer?' });

    const pushed: KenningNotification[] = [];
    const notifier = async (n: KenningNotification) => {
      pushed.push(n);
      return { delivered: true, refs: [`telegram:42:${100 + pushed.length}`] };
    };
    const first = service(d);
    first.svc.start();
    await first.svc.ready();
    first.svc.setNotifier(notifier);
    await until(() => fs.existsSync(path.join(d.stateDir, KENNING_NOTIFIED_FILE)));
    expect(pushed).toEqual([
      { itemId: blocking.id, title: 'Question for you', body: expect.stringContaining('Approve the MIT license?'), source: 'lane', navigate: 'sid-1' },
    ]);
    // More changes do not push it again.
    k.update(file, { status: 'waiting' });
    await new Promise((r) => setTimeout(r, 100));
    expect(pushed).toHaveLength(1);
    first.svc.stop();

    // A restart remembers it (the record is in wherever's state dir).
    const second = service(d);
    second.svc.start();
    await second.svc.ready();
    second.svc.setNotifier(notifier);
    await new Promise((r) => setTimeout(r, 100));
    expect(pushed).toHaveLength(1);

    expect(second.svc.answerFromReply('telegram:42:999', 'yes', 'telegram')).toEqual({ handled: false });
    expect(second.svc.answerFromReply('telegram:42:101', 'yes, MIT', 'telegram')).toEqual({ handled: true, reply: '✅ Answered: Approve the MIT license?' });
    expect(k.item(blocking.id)).toMatchObject({ state: 'answered', answer: 'yes, MIT', answerChannel: 'telegram' });
    expect(second.svc.answerFromReply('telegram:42:101', 'no', 'telegram')).toEqual({ handled: true, reply: 'That question was already answered (or withdrawn).' });
  });

  it('an item no channel delivered is not spent: retried (throttled) until one delivers, then recorded', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, cwd: '/home/u/lane' });
    k.humanAsk({ from: file, question: 'q?', blocking: true });
    let calls = 0;
    let deliver = false;
    const { svc } = service(d, { notifyRetryMs: 300 });
    svc.start();
    await svc.ready();
    svc.setNotifier(async () => {
      calls += 1;
      if (!deliver) throw new Error('Telegram is not paired yet');
      return { delivered: true, refs: [] };
    });
    await until(() => calls === 1);
    // Changes inside the retry window do not retry it.
    k.update(file, { status: 'x' });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1);
    expect(fs.existsSync(path.join(d.stateDir, KENNING_NOTIFIED_FILE))).toBe(false);
    // The user pairs Telegram; the next change after the window delivers it, once.
    deliver = true;
    await new Promise((r) => setTimeout(r, 300));
    k.update(file, { status: 'y' });
    await until(() => fs.existsSync(path.join(d.stateDir, KENNING_NOTIFIED_FILE)));
    expect(calls).toBe(2);
    k.update(file, { status: 'z' });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(2);
  });

  it("computes kenning's state dir exactly as kenning does, without loading it", async () => {
    const { defaultStateDir } = await import('kenning');
    const saved = { K: process.env.KENNING_STATE_DIR, X: process.env.XDG_STATE_HOME };
    const set = (key: string, v: string | undefined) => (v === undefined ? delete process.env[key] : (process.env[key] = v));
    try {
      for (const [k, x] of [['/k', '/x'], [undefined, '/x'], [undefined, undefined]] as const) {
        set('KENNING_STATE_DIR', k);
        set('XDG_STATE_HOME', x);
        expect(kenningStateDir()).toBe(defaultStateDir());
      }
    } finally {
      set('KENNING_STATE_DIR', saved.K);
      set('XDG_STATE_HOME', saved.X);
    }
  });

  it('builds the notification and the session id from pure parts', () => {
    expect(sessionIdOf('/s/2026-11-18T10-00-00-000Z_0b7c5e7a-1111-4222-8333-944455556666.jsonl', null)).toBe('0b7c5e7a-1111-4222-8333-944455556666');
    expect(sessionIdOf('/s/other.jsonl', null)).toBeNull();
    const n = kenningNotification(
      { id: 'h_1', session: '/s/other.jsonl', question: 'Which?', options: ['a', 'b'], blocking: true, onBehalfOf: [], state: 'open', answer: null, answerChannel: null, createdAt: 0 },
      null,
    );
    expect(n).toEqual({ itemId: 'h_1', title: 'Question for you', body: 'Which?\nOptions: a / b\nAnswer in the wherever inbox, or reply to this message on Telegram.', source: 'other', navigate: '' });
  });
});
