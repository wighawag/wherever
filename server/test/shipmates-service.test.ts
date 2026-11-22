import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openShipmates, type Shipmates } from 'shipmates';
import {
  SHIPMATES_NOTIFIED_FILE,
  ShipmatesService,
  shipmatesNotification,
  shipmatesStateDir,
  sessionIdOf,
  type ShipmatesNotification,
  type ShipmatesSnapshot,
} from '../src/shipmates-service.ts';

/**
 * wherever's shipmates host half (shipmates-service.ts): the inbox and presence
 * snapshot pushed to dashboards, the web answer as a human act, and blocking
 * items pushed ONCE (recorded in wherever's state dir), a channel reply
 * answering the item it notified. Against the REAL shipmates core on a temp
 * state dir; no pi.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const quiet = { log() {}, warn() {}, error() {} };

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-shipmates-svc-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, shipmatesDir: path.join(root, 'shipmates'), stateDir: path.join(root, 'wherever-state') };
}

function service(d: ReturnType<typeof dirs>, extra: Partial<ConstructorParameters<typeof ShipmatesService>[0]> = {}) {
  const updates: ShipmatesSnapshot[] = [];
  const svc = new ShipmatesService({
    enabled: true,
    whereverStateDir: d.stateDir,
    shipmatesStateDir: d.shipmatesDir,
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

function db(d: ReturnType<typeof dirs>): Shipmates {
  const k = openShipmates({ stateDir: d.shipmatesDir });
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

describe('ShipmatesService', () => {
  it('stays off (and writes nothing) until shipmates\'s database exists, then opens it', async () => {
    const d = dirs();
    const { svc, updates } = service(d);
    svc.start();
    expect(svc.available).toBe(false);
    expect(svc.snapshot()).toEqual({ available: false, inbox: [], presence: [], archives: [] });
    expect(fs.existsSync(d.shipmatesDir)).toBe(false);
    expect(svc.answer('h_x', 'yes', 'web')).toMatchObject({ ok: false });

    const k = db(d); // @shipmates/pi (or the CLI) creates it
    k.register({ sessionFile: SESSION(d.root), sessionId: '0b7c5e7a-1111-4222-8333-944455556666', cwd: '/home/u/lane' });
    await until(() => svc.available && updates.length > 0);
    expect(updates.at(-1)!.available).toBe(true);
    expect(fs.existsSync(path.join(d.stateDir, SHIPMATES_NOTIFIED_FILE))).toBe(false);
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

    const pushed: ShipmatesNotification[] = [];
    const notifier = async (n: ShipmatesNotification) => {
      pushed.push(n);
      return { delivered: true, refs: [`telegram:42:${100 + pushed.length}`] };
    };
    const first = service(d);
    first.svc.start();
    await first.svc.ready();
    first.svc.setNotifier(notifier);
    await until(() => fs.existsSync(path.join(d.stateDir, SHIPMATES_NOTIFIED_FILE)));
    expect(pushed).toEqual([
      { itemId: blocking.id, options: [], title: 'Question for you', body: expect.stringContaining('Approve the MIT license?'), source: 'lane', navigate: 'sid-1' },
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
    expect(fs.existsSync(path.join(d.stateDir, SHIPMATES_NOTIFIED_FILE))).toBe(false);
    // The user pairs Telegram; the next change after the window delivers it, once.
    deliver = true;
    await new Promise((r) => setTimeout(r, 300));
    k.update(file, { status: 'y' });
    await until(() => fs.existsSync(path.join(d.stateDir, SHIPMATES_NOTIFIED_FILE)));
    expect(calls).toBe(2);
    k.update(file, { status: 'z' });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(2);
  });

  it("computes shipmates' state dir exactly as shipmates does, without loading it", async () => {
    const { defaultStateDir } = await import('shipmates');
    const saved = { K: process.env.SHIPMATES_STATE_DIR, X: process.env.XDG_STATE_HOME };
    const set = (key: string, v: string | undefined) => (v === undefined ? delete process.env[key] : (process.env[key] = v));
    try {
      for (const [k, x] of [['/k', '/x'], [undefined, '/x'], [undefined, undefined]] as const) {
        set('SHIPMATES_STATE_DIR', k);
        set('XDG_STATE_HOME', x);
        expect(shipmatesStateDir()).toBe(defaultStateDir());
      }
    } finally {
      set('SHIPMATES_STATE_DIR', saved.K);
      set('XDG_STATE_HOME', saved.X);
    }
  });

  it('a cascaded delete hides the owner and its subtree as one batch, undoable; purged only once shipmates says the window passed', async () => {
    const d = dirs();
    const k = db(d);
    const owner = SESSION(d.root);
    const child = path.join(d.root, 'sessions', 'child.jsonl');
    const grandchild = path.join(d.root, 'sessions', 'grandchild.jsonl');
    k.recordOwnership({ session: child, owner, folder: '/w/a', via: 'host' });
    k.recordOwnership({ session: grandchild, owner: child, folder: '/w/b', via: 'host' });
    let kNow = Date.now();
    const { svc, updates } = service(d, { shipmatesNow: () => kNow });
    svc.start();
    await svc.ready();
    expect(svc.ownsSessions(owner)).toBe(true);
    expect(svc.ownsSessions(grandchild)).toBe(false);
    expect(svc.ownerOf(grandchild)).toBe(child);

    const a = svc.deleteCascade(owner)!;
    expect(a.sessions).toEqual([owner, child, grandchild]);
    expect(svc.isArchived(grandchild)).toBe(true);
    await until(() => updates.at(-1)?.archives.length === 1);
    // Within the window nothing is deleted, whatever the host asks.
    const removed: string[] = [];
    expect(svc.purgeExpired((f) => removed.push(f))).toBe(0);

    expect(svc.undoDelete(a.batch)).toEqual({ ok: true, sessions: [owner, child, grandchild] });
    expect(svc.isArchived(child)).toBe(false);
    await until(() => updates.at(-1)?.archives.length === 0);

    // Deleted again, then 8 days pass (shipmates' clock): purged, and the batch forgotten.
    kNow = Date.now() - 8 * 86_400_000;
    const b = svc.deleteCascade(owner)!;
    kNow = Date.now();
    expect(b.undoUntil).toBeLessThan(Date.now());
    expect(svc.purgeExpired((f) => removed.push(f))).toBe(3);
    expect(removed.sort()).toEqual([owner, child, grandchild].sort());
    expect(svc.snapshot().archives).toEqual([]);
    // Recorded in wherever's state dir, so a restart still knows the batch until then.
    expect(fs.existsSync(path.join(d.stateDir, 'shipmates-archives.json'))).toBe(true);
  });

  it('builds the notification and the session id from pure parts', () => {
    expect(sessionIdOf('/s/2026-11-18T10-00-00-000Z_0b7c5e7a-1111-4222-8333-944455556666.jsonl', null)).toBe('0b7c5e7a-1111-4222-8333-944455556666');
    expect(sessionIdOf('/s/other.jsonl', null)).toBeNull();
    const n = shipmatesNotification(
      { id: 'h_1', session: '/s/other.jsonl', question: 'Which?', options: ['a', 'b'], blocking: true, onBehalfOf: [], state: 'open', answer: null, answerChannel: null, createdAt: 0 },
      null,
    );
    expect(n).toEqual({ itemId: 'h_1', options: ['a', 'b'], title: 'Question for you', body: 'Which?\nOptions: a / b\nAnswer in the wherever inbox.', source: 'other', navigate: '' });
  });
});
