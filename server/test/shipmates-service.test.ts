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
  presenceView,
  waitingOnSessionOf,
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
      { sessionFile: path.resolve(file + '/../' + path.basename(file)), sessionId: null, roles: [], state: 'idle', status: null, waitingOn: null, waitingOnSession: null },
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

  it('names the session a `waiting-for-session` presence waits on, and a failed lookup never blanks the snapshot', async () => {
    const d = dirs();
    const k = db(d);
    const sess = (n: number) => path.join(d.root, 'sessions', `2026-11-18T10-00-0${n}-000Z_0b7c5e7a-1111-4222-8333-94445555666${n}.jsonl`);
    const [asker, target, viaRole, unheld, gone, human] = [1, 2, 3, 4, 5, 6].map(sess);
    for (const f of [asker, target, viaRole, unheld, gone, human]) k.register({ sessionFile: f, cwd: '/home/u/lane' });
    // Asked of a session directly (named through a non-normalized path).
    const direct = k.send({ from: asker, to: target + '/../' + path.basename(target), text: 'done?', kind: 'ask' }).question!;
    k.update(asker, { state: 'waiting-for-session', waitingOn: direct.id });
    // Asked of a role someone holds: its holder.
    k.claimRole(target, 'tree/push');
    const role = k.send({ from: viaRole, to: 'tree/push', text: 'pushed?', kind: 'ask' }).question!;
    k.update(viaRole, { state: 'waiting-for-session', waitingOn: role.id });
    // Asked of a role nobody holds any more: null.
    k.claimRole(gone, 'tree/review');
    const orphan = k.send({ from: unheld, to: 'tree/review', text: 'reviewed?', kind: 'ask' }).question!;
    k.releaseRole(gone, 'tree/review');
    k.update(unheld, { state: 'waiting-for-session', waitingOn: orphan.id });
    // A question id that does not exist: null.
    k.update(gone, { state: 'waiting-for-session', waitingOn: 'q_missing' });
    // Waiting for the human: never a session, even with an id.
    const item = k.humanAsk({ from: human, question: 'Ship it?', blocking: true });
    k.update(human, { state: 'waiting-for-human', waitingOn: item.id });

    const { svc } = service(d);
    svc.start();
    await svc.ready();
    const snap = svc.snapshot();
    const by = new Map(snap.presence.map((p) => [p.sessionFile, p]));
    expect(by.get(path.resolve(asker))).toMatchObject({ state: 'waiting-for-session', waitingOn: direct.id, waitingOnSession: path.resolve(target) });
    expect(by.get(path.resolve(viaRole))).toMatchObject({ waitingOn: role.id, waitingOnSession: path.resolve(target) });
    expect(by.get(path.resolve(unheld))).toMatchObject({ waitingOn: orphan.id, waitingOnSession: null });
    expect(by.get(path.resolve(gone))).toMatchObject({ waitingOn: 'q_missing', waitingOnSession: null });
    expect(by.get(path.resolve(human))).toMatchObject({ state: 'waiting-for-human', waitingOn: item.id, waitingOnSession: null });
    expect(by.get(path.resolve(target))).toMatchObject({ waitingOnSession: null });
    // The failed lookups did not empty the inbox or the presence.
    expect(snap.presence).toHaveLength(6);
    expect(snap.inbox.map((i) => i.id)).toEqual([item.id]);
  });

  it('a lookup that THROWS gives null for that session only, never an empty snapshot', () => {
    const p = { sessionFile: '/s/a.jsonl', sessionId: null, cwd: null, branch: null, roles: [], state: 'waiting-for-session', status: null, refs: [], waitingOn: 'q_1', wake: true, live: true, pid: 1, updatedAt: 0, settledAt: null } as const;
    const throwing = { question: () => { throw new Error('ambiguous'); }, roleHolder: () => { throw new Error('boom'); } };
    expect(waitingOnSessionOf(throwing, p)).toBeNull();
    const viaRole = { question: () => ({ to: { kind: 'role' as const, target: 'r' } }), roleHolder: () => { throw new Error('boom'); } };
    expect(waitingOnSessionOf(viaRole, p)).toBeNull();
    const ok = { question: () => ({ to: { kind: 'role' as const, target: 'r' } }), roleHolder: () => '/s/x/../b.jsonl' };
    expect(waitingOnSessionOf(ok, p)).toBe('/s/b.jsonl');
    expect(waitingOnSessionOf(ok, { ...p, state: 'running' })).toBeNull();
    expect(presenceView(p, '/s/b.jsonl')).toMatchObject({ waitingOn: 'q_1', waitingOnSession: '/s/b.jsonl' });
    expect(presenceView(p)).toMatchObject({ waitingOnSession: null });
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

  it('pushes EVERY open item once, across restarts, and a reply to its message answers it', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, sessionId: 'sid-1', cwd: '/home/u/lane' });
    const blocking = k.humanAsk({ from: file, question: 'Approve the MIT license?', blocking: true });
    const later = k.humanAsk({ from: file, question: 'Not urgent: which name do you prefer?' });

    const pushed: ShipmatesNotification[] = [];
    const notifier = async (n: ShipmatesNotification) => {
      pushed.push(n);
      return { delivered: true, refs: [`telegram:42:${100 + pushed.length}`] };
    };
    const first = service(d);
    first.svc.start();
    await first.svc.ready();
    first.svc.setNotifier(notifier);
    const recorded = () => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(path.join(d.stateDir, SHIPMATES_NOTIFIED_FILE), 'utf8')).items).length;
      } catch {
        return 0;
      }
    };
    await until(() => recorded() === 2);
    // Blocking first (shipmates' inbox order); the non-blocking one too (shipmates D39).
    expect(pushed).toEqual([
      { itemId: blocking.id, options: [], title: 'Question for you', body: expect.stringContaining('Approve the MIT license?'), source: 'lane', navigate: 'sid-1' },
      { itemId: later.id, options: [], title: 'Question for you', body: expect.stringContaining('which name do you prefer?'), source: 'lane', navigate: 'sid-1' },
    ]);
    expect(pushed[0].body).toContain('This blocks lane until you answer.');
    expect(pushed[0].body).not.toContain('when you can');
    expect(pushed[1].body).toContain('answer when you can');
    expect(pushed[1].body).not.toContain('blocks');
    // More changes do not push them again.
    k.update(file, { status: 'waiting' });
    await new Promise((r) => setTimeout(r, 100));
    expect(pushed).toHaveLength(2);
    first.svc.stop();

    // A restart remembers it (the record is in wherever's state dir).
    const second = service(d);
    second.svc.start();
    await second.svc.ready();
    second.svc.setNotifier(notifier);
    await new Promise((r) => setTimeout(r, 100));
    expect(pushed).toHaveLength(2);

    expect(second.svc.answerFromReply('telegram:42:999', 'yes', 'telegram')).toEqual({ handled: false });
    expect(second.svc.answerFromReply('telegram:42:101', 'yes, MIT', 'telegram')).toEqual({ handled: true, reply: '✅ Answered: Approve the MIT license?', answered: true });
    expect(k.item(blocking.id)).toMatchObject({ state: 'answered', answer: 'yes, MIT', answerChannel: 'telegram' });
    expect(second.svc.answerFromReply('telegram:42:101', 'no', 'telegram')).toEqual({ handled: true, reply: 'Already answered in Telegram.', answered: false });
    expect(k.item(blocking.id)).toMatchObject({ answer: 'yes, MIT' });
  });

  it('a blocking item names the session it blocks by its role; a non-blocking one says "when you can"', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, cwd: '/home/u/lane' });
    k.claimRole(file, 'tree/push');
    const blocking = k.humanAsk({ from: file, question: 'Force-push?', options: ['yes', 'no'], blocking: true });
    const later = k.humanAsk({ from: file, question: 'Rename later?' });
    const pushed: ShipmatesNotification[] = [];
    const { svc } = service(d);
    svc.start();
    await svc.ready();
    svc.setNotifier(async (n) => (pushed.push(n), { delivered: true, refs: [] }));
    await until(() => pushed.length === 2);
    const byId = new Map(pushed.map((n) => [n.itemId, n]));
    expect(byId.get(blocking.id)!.body).toBe('Force-push?\nOptions: yes / no\nThis blocks tree/push until you answer.\nAnswer in the wherever inbox.');
    expect(byId.get(blocking.id)!.source).toBe('tree/push');
    expect(byId.get(later.id)!.body).toBe('Rename later?\nNo session is waiting on it: answer when you can.\nAnswer in the wherever inbox.');
  });

  it('an item closed through another channel gets its pushed messages marked, once, across restarts', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, cwd: '/home/u/lane' });
    const inSession = k.humanAsk({ from: file, question: 'Ship it?', blocking: true });
    const onWeb = k.humanAsk({ from: file, question: 'Which tag?' });
    const withdrawn = k.humanAsk({ from: file, question: 'Still needed?' });
    const onTelegram = k.humanAsk({ from: file, question: 'Pinned?' });
    let n = 0;
    const refsOf = new Map<string, string[]>();
    const notifier = async (x: ShipmatesNotification) => {
      const refs = [`telegram:42:${++n}`];
      refsOf.set(x.itemId, refs);
      return { delivered: true, refs };
    };
    const closed: Array<{ refs: string[]; note: string }> = [];
    let closerOk = true;
    const closer = async (refs: string[], note: string) => {
      closed.push({ refs, note });
      return closerOk;
    };
    const first = service(d, { notifyRetryMs: 50 });
    first.svc.start();
    await first.svc.ready();
    first.svc.setNotifier(notifier);
    first.svc.setCloser(closer);
    await until(() => refsOf.size === 4);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toEqual([]);

    // The human replied in the asking session (@shipmates/pi: channel `session`).
    k.answerOpenItemsOf(file, 'yes, ship', { channel: 'session', deliver: false, except: [onWeb.id, withdrawn.id, onTelegram.id] });
    await until(() => closed.length === 1);
    expect(closed[0]).toEqual({ refs: refsOf.get(inSession.id), note: '✅ Answered in the session: yes, ship' });

    // A failed mark is tried again; then it holds.
    closerOk = false;
    expect(first.svc.answer(onWeb.id, 'v2', 'web')).toEqual({ ok: true });
    await until(() => closed.length === 1 + 1);
    closerOk = true;
    await new Promise((r) => setTimeout(r, 100)); // past the retry throttle
    k.update(file, { status: 'poke' });
    await until(() => closed.length === 3);
    expect(closed.slice(1).map((c) => c.note)).toEqual(['✅ Answered in the wherever inbox: v2', '✅ Answered in the wherever inbox: v2']);

    k.withdrawItem(file, withdrawn.id);
    await until(() => closed.length === 4);
    expect(closed[3]).toEqual({ refs: refsOf.get(withdrawn.id), note: '↩️ Withdrawn: the session no longer needs an answer.' });

    // Answered ON Telegram: that channel already said so, nothing to mark.
    first.svc.answerFromReply(refsOf.get(onTelegram.id)![0], 'no', 'telegram');
    k.update(file, { status: 'poke again' });
    await new Promise((r) => setTimeout(r, 150));
    expect(closed).toHaveLength(4);
    first.svc.stop();

    // A restart marks nothing again.
    const second = service(d);
    second.svc.start();
    await second.svc.ready();
    second.svc.setNotifier(notifier);
    second.svc.setCloser(closer);
    k.update(file, { status: 'after restart' });
    await new Promise((r) => setTimeout(r, 150));
    expect(closed).toHaveLength(4);

    // A Telegram reply to a closed item: "already answered", and nothing changes.
    const before = k.item(inSession.id);
    expect(second.svc.answerFromReply(refsOf.get(inSession.id)![0], 'no!', 'telegram')).toEqual({ handled: true, reply: 'Already answered in the session.', answered: false });
    expect(second.svc.answerFromReply(refsOf.get(withdrawn.id)![0], 'no!', 'telegram')).toEqual({ handled: true, reply: 'This question was withdrawn.', answered: false });
    expect(k.item(inSession.id)).toEqual(before);
    expect(k.pendingFor(file).filter((m) => m.text === 'no!')).toEqual([]);
  });

  it('a close still waiting for a retry survives a restart (the cursor never passes it)', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, cwd: '/home/u/lane' });
    const a = k.humanAsk({ from: file, question: 'A?' });
    const b = k.humanAsk({ from: file, question: 'B?' });
    let n = 0;
    const notifier = async () => ({ delivered: true, refs: [`telegram:42:${++n}`] });
    const first = service(d, { notifyRetryMs: 60_000 });
    first.svc.start();
    await first.svc.ready();
    first.svc.setNotifier(notifier);
    let fails = 0;
    first.svc.setCloser(async () => (fails++, false)); // Telegram is down
    await until(() => n === 2);
    k.answerOpenItemsOf(file, 'done', { channel: 'session', deliver: false, except: [b.id] });
    await until(() => fails === 1);
    // A later write (a new item pushed and recorded) persists the cursor: it must not pass `a`.
    await new Promise((r) => setTimeout(r, 6000)); // past the 5 s overlap
    k.humanAsk({ from: file, question: 'C?' });
    await until(() => n === 3);
    await new Promise((r) => setTimeout(r, 50));
    first.svc.stop();

    const notes: string[] = [];
    const second = service(d);
    second.svc.start();
    await second.svc.ready();
    second.svc.setNotifier(notifier);
    second.svc.setCloser(async (_refs, note) => (notes.push(note), true));
    await until(() => notes.length === 1);
    expect(notes).toEqual(['✅ Answered in the session: done']);
    expect(k.item(a.id)?.state).toBe('answered');
  }, 20_000);

  it('a record of an item still open is never pruned (it would be pushed again)', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, cwd: '/home/u/lane' });
    k.humanAsk({ from: file, question: 'Can wait for weeks?' });
    const done = k.humanAsk({ from: file, question: 'Done long ago?' });
    let pushes = 0;
    const notifier = async () => ({ delivered: true, refs: [`telegram:42:${++pushes}`] });
    const first = service(d);
    first.svc.start();
    await first.svc.ready();
    first.svc.setNotifier(notifier);
    await until(() => pushes === 2);
    k.answerItem(done.id, 'yes', { channel: 'web' });
    first.svc.stop();

    // 31 days later (wherever's clock): a write prunes the finished item's record only.
    const later = service(d, { now: () => Date.now() + 31 * 86_400_000 });
    later.svc.start();
    await later.svc.ready();
    later.svc.setNotifier(notifier);
    later.svc.setCloser(async () => true);
    k.humanAsk({ from: file, question: 'A new one' });
    await until(() => pushes === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(pushes).toBe(3);
    const items = JSON.parse(fs.readFileSync(path.join(d.stateDir, SHIPMATES_NOTIFIED_FILE), 'utf8')).items;
    expect(Object.keys(items)).toHaveLength(2);
    expect(items[done.id]).toBeUndefined();
  });

  it('the first start with D39 does not push a backlog of old non-blocking items, nor annotate old closes', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, cwd: '/home/u/lane' });
    const old = openShipmates({ stateDir: d.shipmatesDir, now: () => Date.now() - 2 * 3_600_000 });
    cleanups.push(() => old.close());
    const stale = old.humanAsk({ from: file, question: 'Old and not urgent?' });
    const staleBlocking = old.humanAsk({ from: file, question: 'Old but blocking?', blocking: true });
    const oldClosed = old.humanAsk({ from: file, question: 'Answered before the upgrade?', blocking: true });
    const fresh = k.humanAsk({ from: file, question: 'Just asked?' });
    // A notified file as wherever wrote it before D39: no closedCursor.
    fs.mkdirSync(d.stateDir, { recursive: true });
    fs.writeFileSync(path.join(d.stateDir, SHIPMATES_NOTIFIED_FILE), JSON.stringify({ items: { [oldClosed.id]: { at: Date.now() - 3_600_000, refs: ['telegram:42:7'] } } }));
    old.answerItem(oldClosed.id, 'yes', { channel: 'web' });

    const pushed: string[] = [];
    const notes: string[] = [];
    const { svc } = service(d);
    svc.start();
    await svc.ready();
    svc.setNotifier(async (n) => (pushed.push(n.itemId), { delivered: true, refs: [] }));
    svc.setCloser(async (_r, note) => (notes.push(note), true));
    await until(() => pushed.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(pushed.sort()).toEqual([staleBlocking.id, fresh.id].sort());
    expect(notes).toEqual([]);
    // Still in the inbox, just not pushed.
    expect(svc.snapshot().inbox.map((i) => i.id)).toContain(stale.id);
  });

  it('a Telegram reply that loses the race to another channel gets "already answered", not an error', async () => {
    const d = dirs();
    const k = db(d);
    const file = SESSION(d.root);
    k.register({ sessionFile: file, cwd: '/home/u/lane' });
    const item = k.humanAsk({ from: file, question: 'Race?', blocking: true });
    const { svc } = service(d);
    svc.start();
    await svc.ready();
    svc.setNotifier(async () => ({ delivered: true, refs: ['telegram:42:1'] }));
    await until(() => fs.existsSync(path.join(d.stateDir, SHIPMATES_NOTIFIED_FILE)));
    // The web answers between the state check and the write: shipmates' write then throws `answered`.
    const api = svc.api()!;
    const real = api.answerItem.bind(api);
    (api as any).answerItem = (id: string, text: string, opts: any) => {
      real(id, 'from the web', { channel: 'web' });
      return real(id, text, opts);
    };
    expect(svc.answerFromReply('telegram:42:1', 'from telegram', 'telegram')).toEqual({ handled: true, reply: 'Already answered in the wherever inbox.', answered: false });
    expect(k.item(item.id)).toMatchObject({ answer: 'from the web', answerChannel: 'web' });
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
      { id: 'h_1', session: '/s/other.jsonl', question: 'Which?', options: ['a', 'b'], blocking: true, onBehalfOf: [], state: 'open', answer: null, answerChannel: null, createdAt: 0, finishedAt: null },
      null,
    );
    expect(n).toEqual({ itemId: 'h_1', options: ['a', 'b'], title: 'Question for you', body: 'Which?\nOptions: a / b\nThis blocks other until you answer.\nAnswer in the wherever inbox.', source: 'other', navigate: '' });
  });
});
