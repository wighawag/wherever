import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttentionItem, Shipmates, Presence } from 'shipmates';

/**
 * wherever as a shipmates HOST (shipmates' spec "Architecture", D20; wherever ADR
 * 0023 for the human-input half). @shipmates/pi already runs inside every server
 * session as an ordinary extension (presence, delivery, the tools); this module
 * adds what only wherever can do with the same database:
 *
 * - the human's ATTENTION INBOX on the web (a panel, a badge, a reply box) and
 *   the PRESENCE of each session in the session list, pushed to dashboards as
 *   `shipmates_update` frames on every change (polled like shipmates' own D6
 *   watcher, then throttled like `sessions_updated`);
 * - an authenticated web or Telegram answer is a HUMAN act, so it goes through
 *   `answerItem(id, text, {channel})`;
 * - EVERY open item is pushed once through the assistant's channels (Web Push,
 *   Telegram), saying whether it blocks a session, linking to the asking
 *   session; a Telegram reply to that message answers it, and once the item
 *   closes through another channel the Telegram message is marked so it no
 *   longer looks open (shipmates D39).
 *
 * It never creates shipmates' database: it opens it once it EXISTS (@shipmates/pi
 * or the shipmates CLI made it), checking every `openPollMs` until then, so a
 * user who does not use shipmates gets nothing written. `shipmates.enabled: false`
 * in config.json turns it off entirely.
 */

/** One open attention item, as the web shows it. */
export interface ShipmatesInboxItemView {
  id: string;
  question: string;
  options: string[] | null;
  blocking: boolean;
  createdAt: number;
  /** The asking session's transcript, normalized like the pool's keys and the listing's `path`. */
  sessionFile: string;
  /** Its session id, for the link that opens it (null when it cannot be told). */
  sessionId: string | null;
  /** Who asks: the session's role, else its folder name. */
  from: string;
  /** How many children's questions this item merges (an orchestrator's, `onBehalfOf`). */
  onBehalfOf: number;
}

/** One live session's presence, as the session list shows it. */
export interface ShipmatesPresenceView {
  sessionFile: string;
  sessionId: string | null;
  roles: string[];
  state: Presence['state'];
  status: string | null;
  waitingOn: string | null;
}

/** What a dashboard gets (`shipmates_update`). `available` false = no shipmates database (or off). */
export interface ShipmatesSnapshot {
  available: boolean;
  inbox: ShipmatesInboxItemView[];
  presence: ShipmatesPresenceView[];
  /** Deletions this server cascaded through ownership that can still be undone (shipmates D24). */
  archives: ShipmatesArchiveView[];
}

/** One delete that took a session and everything it owns, undoable until `undoUntil`. */
export interface ShipmatesArchiveView {
  batch: string;
  /** The session the human deleted (normalized file). */
  root: string;
  /** Every session the batch hid, the root first. */
  sessions: string[];
  at: number;
  undoUntil: number;
}

export const SHIPMATES_ARCHIVES_FILE = 'shipmates-archives.json';

/** An open item to push through the channels (`ChannelNotification` shape). */
export interface ShipmatesNotification {
  itemId: string;
  /** The item's fixed answers (none = free text): Telegram shows them as buttons. */
  options: string[];
  title: string;
  body: string;
  source: string;
  /** The session id a tap opens ('' = the main screen). */
  navigate: string;
}

/** What pushing one notification produced: whether anything delivered, and the channel-side refs a reply can name. */
export interface ShipmatesNotifyOutcome {
  delivered: boolean;
  /** `<channel>:<id>` per message sent (Telegram: `telegram:<chatId>:<messageId>`). */
  refs: string[];
  error?: string;
}

export type ShipmatesAnswerResult = { ok: true } | { ok: false; error: string };

export const SHIPMATES_NOTIFIED_FILE = 'shipmates-notified.json';
export const SHIPMATES_DISABLED_ERROR = 'shipmates is not available on this server (no shipmates database yet, or `shipmates.enabled` is false)';
const NOTIFIED_RETENTION_MS = 30 * 86_400_000; // shipmates prunes finished items after 30 days (D11)
/** On the first start with D39, a non-blocking item older than this is not pushed (`skipStaleNonBlocking`). */
const STALE_NONBLOCKING_MS = 3_600_000;
/**
 * shipmates' database dir, as shipmates' `defaultStateDir()` (its store.ts)
 * computes it, without loading shipmates (and `node:sqlite`) for a user who does
 * not use it. shipmates-service.test.ts pins the two together.
 */
export function shipmatesStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHIPMATES_STATE_DIR) return env.SHIPMATES_STATE_DIR;
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'shipmates');
}

const SESSION_ID_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** A session id from the presence, else from pi's `<timestamp>_<uuid>.jsonl` file name. */
export function sessionIdOf(sessionFile: string, presence: Presence | null | undefined): string | null {
  return presence?.sessionId ?? SESSION_ID_RE.exec(sessionFile)?.[1] ?? null;
}

/** Who a session is to the human: its first role, else its folder name, else its file name. */
export function sessionLabel(sessionFile: string, presence: Presence | null | undefined): string {
  return presence?.roles[0] || (presence?.cwd ? path.basename(presence.cwd) : '') || path.basename(sessionFile, '.jsonl');
}

export function inboxItemView(item: AttentionItem, presence: Presence | null): ShipmatesInboxItemView {
  return {
    id: item.id,
    question: item.question,
    options: item.options,
    blocking: item.blocking,
    createdAt: item.createdAt,
    sessionFile: normalizeSessionFile(item.session),
    sessionId: sessionIdOf(item.session, presence),
    from: sessionLabel(item.session, presence),
    onBehalfOf: item.onBehalfOf.length,
  };
}

export function presenceView(p: Presence): ShipmatesPresenceView {
  return {
    sessionFile: normalizeSessionFile(p.sessionFile),
    sessionId: p.sessionId,
    roles: p.roles,
    state: p.state,
    status: p.status,
    waitingOn: p.waitingOn,
  };
}

/**
 * Who an item blocks, as the human reads it: the presence's role or folder,
 * else shipmates' `labelOf` when it is a role (it is the transcript path
 * otherwise), else the file name.
 */
export function blockedLabel(sessionFile: string, presence: Presence | null | undefined, shipmatesLabel?: string | null): string {
  if (presence) return sessionLabel(sessionFile, presence);
  if (shipmatesLabel && shipmatesLabel !== sessionFile && !shipmatesLabel.startsWith('/')) return shipmatesLabel;
  return sessionLabel(sessionFile, null);
}

/**
 * The notification for an open item (shipmates D39: every item is pushed, and
 * says whether a session waits on it). `label` names the session it blocks
 * (default: from the presence). Pure.
 */
export function shipmatesNotification(item: AttentionItem, presence: Presence | null, label?: string): ShipmatesNotification {
  const who = label ?? blockedLabel(item.session, presence);
  const lines = [item.question];
  if (item.options?.length) lines.push(`Options: ${item.options.join(' / ')}`);
  lines.push(item.blocking ? `This blocks ${who} until you answer.` : 'No session is waiting on it: answer when you can.');
  // Every channel's wording: how to answer ON a channel (Telegram: buttons,
  // swipe to reply) is that channel's to say, since only it knows.
  lines.push('Answer in the wherever inbox.');
  return {
    itemId: item.id,
    options: item.options ?? [],
    title: 'Question for you',
    body: lines.join('\n'),
    source: who,
    navigate: sessionIdOf(item.session, presence) ?? '',
  };
}

interface NotifiedRecord {
  at: number;
  refs: string[];
  /** When its pushed messages were marked closed (or found not to need it): never again. */
  closed?: number;
}

/** Where an item was answered, as a sentence names it. */
export function answerChannelLabel(channel: string | null): string {
  switch (channel) {
    case 'session':
      return 'the session';
    case 'web':
      return 'the wherever inbox';
    case 'cli':
      return 'the shipmates CLI';
    case 'terminal':
      return 'a terminal';
    case 'telegram':
      return 'Telegram';
    default:
      return channel || 'another channel';
  }
}

/** What a pushed message says once its item closed through another channel. Pure. */
export function closedNote(item: AttentionItem): string {
  if (item.state === 'withdrawn') return '↩️ Withdrawn: the session no longer needs an answer.';
  return `✅ Answered in ${answerChannelLabel(item.answerChannel)}${item.answer ? `: ${clip(item.answer, 200)}` : '.'}`;
}

/** The reply to a channel-side answer for an item already closed. Pure. */
export function alreadyClosedReply(item: AttentionItem): string {
  if (item.state === 'withdrawn') return 'This question was withdrawn.';
  return `Already answered in ${answerChannelLabel(item.answerChannel)}.`;
}

export interface ShipmatesServiceOptions {
  /** Off = never open shipmates (`shipmates.enabled: false`). */
  enabled: boolean;
  /** wherever's state dir: where the once-per-item notification record lives (ADR 0006). */
  whereverStateDir: string;
  /** shipmates' own state dir (default: shipmates', `SHIPMATES_STATE_DIR` or `$XDG_STATE_HOME/shipmates`). */
  shipmatesStateDir?: string;
  /** Called with a new snapshot whenever it changed (throttled). */
  onUpdate(snapshot: ShipmatesSnapshot): void;
  /** Called on every shipmates change, unthrottled (the host wakes evicted children from it). */
  onShipmatesChange?(): void;
  /** Leading + trailing throttle of `onUpdate`, like `sessions_updated` (default 2000 ms). */
  throttleMs?: number;
  /** How often shipmates' database is polled for changes (shipmates' D6 interval, default 1000 ms). */
  pollMs?: number;
  /** How often to look for the database before it exists (default 5000 ms). */
  openPollMs?: number;
  /** Re-evaluate the snapshot this often even without a write: a crashed session's presence goes stale by pid, not by a write (default 30 s). */
  refreshMs?: number;
  /** An item no channel delivered is tried again at most this often (default 60 s). */
  notifyRetryMs?: number;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
  now?: () => number;
  /** shipmates' own clock (tests: an archive made "8 days ago"). */
  shipmatesNow?: () => number;
}

export class ShipmatesService {
  private shipmates: Shipmates | null = null;
  private opening = false;
  private watcher: { stop(): void } | null = null;
  private openTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateAt = 0;
  private lastSent = '';
  private notifier: ((n: ShipmatesNotification) => Promise<ShipmatesNotifyOutcome>) | null = null;
  private closer: ((refs: string[], note: string) => Promise<boolean>) | null = null;
  private notified = new Map<string, NotifiedRecord>();
  /** Items finished at or after this (shipmates' clock) are still to be looked at (persisted). */
  private closeCursor: number | null = null;
  private closing = new Set<string>();
  /** Closed items whose messages could not be marked yet: last try and count (memory only). */
  private closeRetry = new Map<string, { at: number; tries: number }>();
  private notifying = new Set<string>();
  /** Items no channel delivered yet: when they were last tried (memory only). */
  private undelivered = new Map<string, number>();
  private stopped = false;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly now: () => number;
  private readonly dbPath: string;

  constructor(private readonly opts: ShipmatesServiceOptions) {
    this.log = opts.log ?? console;
    this.now = opts.now ?? Date.now;
    this.dbPath = path.join(opts.shipmatesStateDir ?? shipmatesStateDir(), 'shipmates.db');
  }

  /** Open now if the database exists, else keep looking (unref'd). Never throws. */
  start(): void {
    if (!this.opts.enabled || this.stopped) return;
    if (fs.existsSync(this.dbPath)) {
      void this.open();
      return;
    }
    this.openTimer = setInterval(() => {
      if (!fs.existsSync(this.dbPath)) return;
      if (this.openTimer) clearInterval(this.openTimer);
      this.openTimer = null;
      void this.open();
    }, this.opts.openPollMs ?? 5000);
    this.openTimer.unref?.();
  }

  /** Resolves once the service has tried to open the database (tests, start-up order). */
  ready(): Promise<void> {
    return this.openPromise ?? Promise.resolve();
  }
  private openPromise: Promise<void> | null = null;

  get available(): boolean {
    return this.shipmates !== null;
  }

  /**
   * Load shipmates only now (it brings `node:sqlite`, which Node 22 announces with
   * an ExperimentalWarning) and open the database. A database that exists but
   * will not open is logged once and not retried.
   */
  private open(): Promise<void> {
    if (this.opening) return this.openPromise ?? Promise.resolve();
    this.opening = true;
    this.openPromise = (async () => {
      let mod: typeof import('shipmates');
      try {
        mod = await import('shipmates');
        if (this.stopped) return;
        mod.silenceSqliteWarning();
        this.shipmates = mod.openShipmates({ stateDir: path.dirname(this.dbPath), ...(this.opts.shipmatesNow ? { now: this.opts.shipmatesNow } : {}) });
      } catch (err) {
        this.log.warn(`[wherever] shipmates: could not open ${this.dbPath} (${(err as Error).message}); the inbox stays off`);
        return;
      }
      this.loadNotified();
      this.skipStaleNonBlocking();
      this.loadArchives();
      this.log.log(`[wherever] shipmates: inbox and presence from ${this.dbPath}`);
      this.watcher = mod.watchChanges(this.shipmates, () => this.onChange(), { intervalMs: this.opts.pollMs ?? 1000 });
      this.refreshTimer = setInterval(() => {
        this.checkNotifications(); // retries an undelivered item even when nothing is written
        this.checkClosed();
        this.flush();
      }, this.opts.refreshMs ?? 30_000);
      this.refreshTimer.unref?.();
      this.onChange();
    })();
    return this.openPromise;
  }

  stop(): void {
    this.stopped = true;
    if (this.openTimer) clearInterval(this.openTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.openTimer = this.refreshTimer = this.throttleTimer = null;
    this.watcher?.stop();
    this.watcher = null;
    try {
      this.shipmates?.close();
    } catch {}
    this.shipmates = null;
  }

  /** The current snapshot (sent to a dashboard as it connects). */
  snapshot(): ShipmatesSnapshot {
    const k = this.shipmates;
    if (!k) return { available: false, inbox: [], presence: [], archives: [] };
    try {
      const live = k.list();
      const bySession = new Map(live.map((p) => [p.sessionFile, p]));
      const inbox = k.inbox().map((item) => inboxItemView(item, bySession.get(item.session) ?? k.presence(item.session)));
      return { available: true, inbox, presence: live.map(presenceView), archives: this.archiveViews() };
    } catch (err) {
      this.log.warn(`[wherever] shipmates: reading the inbox failed: ${(err as Error).message}`);
      return { available: true, inbox: [], presence: [], archives: this.archiveViews() };
    }
  }

  /**
   * The human answered an item from an authenticated wherever surface (the web
   * reply box: `web`; a Telegram reply from the paired user: `telegram`). Only
   * ever called for a real human act (ADR 0003): never from a CLI bridge
   * connection, never from a tool.
   */
  answer(itemId: string, text: string, channel: 'web' | 'telegram'): ShipmatesAnswerResult {
    const k = this.shipmates;
    if (!k) return { ok: false, error: SHIPMATES_DISABLED_ERROR };
    if (typeof itemId !== 'string' || !itemId) return { ok: false, error: 'no item id' };
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'the answer is empty' };
    try {
      k.answerItem(itemId, text, { channel });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    this.onChange();
    return { ok: true };
  }

  /** The open shipmates connection (the spawn/stop host reads ownership through it), or null. */
  api(): Shipmates | null {
    return this.shipmates;
  }

  // ------------------------------------------------ ownership in the sidebar

  /**
   * Per-session lookups the `/sessions` listing makes for every session
   * (owner, archived), memoized until the next shipmates change: one indexed
   * query each, but a real listing has thousands of sessions.
   */
  private lookups = new Map<string, { owner: string | null; archived: boolean }>();

  private lookup(sessionFile: string): { owner: string | null; archived: boolean } {
    const hit = this.lookups.get(sessionFile);
    if (hit) return hit;
    const k = this.shipmates;
    let v = { owner: null as string | null, archived: false };
    if (k) {
      try {
        v = { owner: k.ownerOf(sessionFile), archived: k.archiveMark(sessionFile) !== null };
      } catch {}
    }
    this.lookups.set(sessionFile, v);
    return v;
  }

  /** The session that spawned this one (shipmates D23), normalized; null when none or no shipmates. */
  ownerOf(sessionFile: string): string | null {
    const o = this.lookup(sessionFile).owner;
    return o ? normalizeSessionFile(o) : null;
  }

  /** Hidden by a cascaded delete (or another host's archive), within its undo window. */
  isArchived(sessionFile: string): boolean {
    return this.lookup(sessionFile).archived;
  }

  /** Whether deleting this session must cascade (it owns sessions, shipmates D24). */
  ownsSessions(sessionFile: string): boolean {
    try {
      return (this.shipmates?.ownedBy(sessionFile).length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------- cascaded delete

  private archives = new Map<string, ShipmatesArchiveView>();

  private archiveViews(): ShipmatesArchiveView[] {
    const now = this.now();
    return [...this.archives.values()].filter((a) => a.undoUntil > now).sort((a, b) => b.at - a.at);
  }

  /**
   * The human deleted a session that owns others (shipmates D24): mark it and
   * its whole owned subtree as one batch. The host hides every session in it
   * and keeps their transcripts until the undo window has passed
   * (`purgeExpired`). Null without shipmates.
   */
  deleteCascade(sessionFile: string): ShipmatesArchiveView | null {
    const k = this.shipmates;
    if (!k) return null;
    const r = k.archive(sessionFile, { kind: 'deleted', by: 'web' });
    const view: ShipmatesArchiveView = {
      batch: r.batch,
      root: normalizeSessionFile(sessionFile),
      sessions: r.sessions.map(normalizeSessionFile),
      at: r.at,
      undoUntil: r.undoUntil,
    };
    this.archives.set(r.batch, view);
    this.saveArchives();
    this.onChange();
    return view;
  }

  /** Undo a cascaded delete within its window: the sessions come back. */
  undoDelete(batch: string): { ok: true; sessions: string[] } | { ok: false; error: string } {
    const k = this.shipmates;
    if (!k) return { ok: false, error: SHIPMATES_DISABLED_ERROR };
    try {
      const sessions = k.undoArchive(batch).map(normalizeSessionFile);
      this.archives.delete(batch);
      this.saveArchives();
      this.onChange();
      return { ok: true, sessions };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * The cascaded deletes whose undo window shipmates says has passed
   * (`expiredArchives`): `remove` deletes each transcript for good, then the
   * batch is forgotten. Never before shipmates lists it (D24).
   */
  purgeExpired(remove: (sessionFile: string) => void): number {
    const k = this.shipmates;
    if (!k) return 0;
    let expired: Set<string>;
    try {
      expired = new Set(k.expiredArchives().map((m) => `${m.batch}\n${normalizeSessionFile(m.session)}`));
    } catch {
      return 0;
    }
    let n = 0;
    for (const [batch, a] of this.archives) {
      if (a.undoUntil > this.now()) continue;
      for (const s of a.sessions) {
        if (!expired.has(`${batch}\n${s}`)) continue;
        try {
          remove(s);
          n++;
        } catch (err) {
          this.log.warn(`[wherever] shipmates: could not delete ${s}: ${(err as Error).message}`);
        }
      }
      this.archives.delete(batch);
    }
    if (n) this.saveArchives();
    return n;
  }

  private archivesPath(): string {
    return path.join(this.opts.whereverStateDir, SHIPMATES_ARCHIVES_FILE);
  }

  private loadArchives(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.archivesPath(), 'utf8')) as { batches?: ShipmatesArchiveView[] };
      for (const a of raw.batches ?? []) if (a && typeof a.batch === 'string' && Array.isArray(a.sessions)) this.archives.set(a.batch, a);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`[wherever] shipmates: ignoring an unreadable ${SHIPMATES_ARCHIVES_FILE}: ${(err as Error).message}`);
    }
  }

  private saveArchives(): void {
    const file = this.archivesPath();
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ batches: [...this.archives.values()] }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log.warn(`[wherever] shipmates: could not record deleted sessions: ${(err as Error).message}`);
    }
  }

  /**
   * Where open items go (the assistant's channel dispatcher). Set once the
   * channels have started; without one, nothing is pushed or recorded, so the
   * items are pushed when a later start has channels.
   */
  setNotifier(fn: ((n: ShipmatesNotification) => Promise<ShipmatesNotifyOutcome>) | null): void {
    this.notifier = fn;
    if (fn) this.checkNotifications();
  }

  /**
   * A channel-side reply (Telegram: a reply to a message, `ref` =
   * `telegram:<chatId>:<messageId>`). Answers the item that message notified,
   * as the human on `channel`. `handled: false` when the message notified no
   * item: the channel then treats it as an ordinary message.
   */
  answerFromReply(ref: string, text: string, channel: 'telegram'): { handled: false } | { handled: true; reply: string; answered: boolean } {
    let itemId: string | null = null;
    for (const [id, rec] of this.notified) if (rec.refs.includes(ref)) itemId = id;
    if (!itemId) return { handled: false };
    const k = this.shipmates;
    if (!k) return { handled: true, reply: `⚠️ ${SHIPMATES_DISABLED_ERROR}.`, answered: false };
    const item = k.item(itemId);
    if (!item) return { handled: true, reply: 'That question is no longer in the inbox.', answered: false };
    // Closed through another channel: say where, deliver nothing (shipmates D39).
    if (item.state !== 'open') return { handled: true, reply: alreadyClosedReply(item), answered: false };
    if (!text.trim()) return { handled: true, reply: '⚠️ Could not answer: the answer is empty', answered: false };
    try {
      k.answerItem(itemId, text, { channel });
    } catch (err) {
      // `answerItem` checks inside its write, so another channel that answered
      // meanwhile makes this one throw `answered` (or `withdrawn`).
      const code = (err as { code?: string }).code;
      const now = k.item(itemId);
      if ((code === 'answered' || code === 'withdrawn') && now && now.state !== 'open') return { handled: true, reply: alreadyClosedReply(now), answered: false };
      return { handled: true, reply: `⚠️ Could not answer: ${(err as Error).message}`, answered: false };
    }
    this.onChange();
    return { handled: true, reply: `✅ Answered: ${clip(item.question, 120)}`, answered: true };
  }

  /**
   * How a pushed notification is marked closed on the channels that sent it
   * (the dispatcher's `closeNotification`). Without one nothing is marked, and
   * nothing recorded, so a later start with channels still does it.
   */
  setCloser(fn: ((refs: string[], note: string) => Promise<boolean>) | null): void {
    this.closer = fn;
    if (fn) this.checkClosed();
  }

  private onChange(): void {
    this.lookups.clear();
    this.checkNotifications();
    this.checkClosed();
    try {
      this.opts.onShipmatesChange?.();
    } catch (err) {
      this.log.error('[wherever] shipmates: a change listener failed:', err);
    }
    if (this.throttleTimer) return;
    const throttle = this.opts.throttleMs ?? 2000;
    const elapsed = this.now() - this.lastUpdateAt;
    if (elapsed >= throttle) {
      this.flush();
      return;
    }
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.flush();
    }, throttle - elapsed);
    this.throttleTimer.unref?.();
  }

  /** Send the snapshot when it differs from the last one sent. */
  private flush(): void {
    if (!this.shipmates) return;
    this.lastUpdateAt = this.now();
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    if (json === this.lastSent) return;
    this.lastSent = json;
    try {
      this.opts.onUpdate(snap);
    } catch (err) {
      this.log.error('[wherever] shipmates: broadcasting the inbox failed:', err);
    }
  }

  /**
   * Push every open item not pushed before, once (recorded in the state dir).
   * Every item, not only blocking ones (shipmates D39): the human's inbox and
   * their channels must agree; the wording says whether a session waits.
   */
  private checkNotifications(): void {
    const k = this.shipmates;
    const notify = this.notifier;
    if (!k || !notify) return;
    let items: AttentionItem[];
    try {
      items = k.inbox();
    } catch {
      return;
    }
    const open = new Set(items.map((i) => i.id));
    for (const id of this.undelivered.keys()) if (!open.has(id)) this.undelivered.delete(id);
    for (const item of items) {
      if (this.notified.has(item.id) || this.notifying.has(item.id)) continue;
      const lastTry = this.undelivered.get(item.id);
      if (lastTry !== undefined && this.now() - lastTry < (this.opts.notifyRetryMs ?? 60_000)) continue;
      this.notifying.add(item.id);
      const presence = k.presence(item.session);
      let label: string | null = null;
      try {
        label = k.labelOf(item.session);
      } catch {}
      const n = shipmatesNotification(item, presence, blockedLabel(item.session, presence, label));
      void notify(n)
        .catch((err): ShipmatesNotifyOutcome => ({ delivered: false, refs: [], error: (err as Error).message }))
        .then((out) => {
          this.notifying.delete(item.id);
          if (!out.delivered) {
            // Nothing reached the human (no device subscribed, Telegram not
            // paired, a network error): not recorded, so the item is pushed
            // once a channel can deliver, tried again at most every
            // `notifyRetryMs`. Said once per item, not on every try.
            if (!this.undelivered.has(item.id)) this.log.warn(`[wherever] shipmates: could not push item ${item.id}: ${out.error ?? 'no channel delivered'}; trying again later`);
            this.undelivered.set(item.id, this.now());
            return;
          }
          // ONCE per item: recorded in the state dir, so a restart never repeats it.
          this.undelivered.delete(item.id);
          this.notified.set(item.id, { at: this.now(), refs: out.refs });
          this.saveNotified();
          // Closed while it was being pushed: the close check has passed it by.
          const now = this.shipmates?.item(item.id);
          if (now && now.state !== 'open') this.closeOne(now);
        });
    }
  }

  /**
   * Mark the pushed messages of items that closed through another channel
   * (the session, the web inbox, the CLI, a terminal dialog, or withdrawn) so
   * they no longer look open (shipmates D39). Read from `itemsFinishedSince`
   * the persisted cursor, so a restart picks up what closed while it was down;
   * each item once (`closed` in its record).
   */
  private checkClosed(): void {
    const k = this.shipmates;
    if (!k || !this.closer) return;
    const kNow = (this.opts.shipmatesNow ?? Date.now)();
    const since = this.closeCursor ?? kNow;
    let items: AttentionItem[];
    try {
      // A little overlap: an item that closes during the read is seen next time; `closed` dedupes.
      items = k.itemsFinishedSince(since - 5000);
    } catch {
      return;
    }
    for (const item of items) this.closeOne(item);
    for (const id of [...this.closeRetry.keys()]) {
      const item = k.item(id);
      if (item && item.state !== 'open') this.closeOne(item);
      else this.closeRetry.delete(id);
    }
    // Never past a close still in flight or waiting for a retry (those live in
    // memory only): after a restart the cursor must still reach it. Persisted
    // with the next record write; an older cursor only re-reads, `closed` dedupes.
    let cursor = kNow;
    for (const id of [...this.closing, ...this.closeRetry.keys()]) {
      const at = k.item(id)?.finishedAt;
      if (typeof at === 'number' && at < cursor) cursor = at;
    }
    this.closeCursor = cursor;
  }

  private closeOne(item: AttentionItem): void {
    const rec = this.notified.get(item.id);
    const close = this.closer;
    if (!rec || rec.closed !== undefined || !close || this.closing.has(item.id)) return;
    // Answered on the very channel that holds its messages (a Telegram reply or
    // tap): that channel already said so. Nothing to mark either without refs.
    if (rec.refs.length === 0 || (item.state === 'answered' && item.answerChannel && rec.refs.every((r) => r.startsWith(`${item.answerChannel}:`)))) {
      rec.closed = this.now();
      this.saveNotified();
      return;
    }
    const retry = this.closeRetry.get(item.id);
    if (retry && this.now() - retry.at < (this.opts.notifyRetryMs ?? 60_000)) return;
    this.closing.add(item.id);
    void close(rec.refs, closedNote(item))
      .catch(() => false)
      .then((ok) => {
        this.closing.delete(item.id);
        if (!ok) {
          const tries = (retry?.tries ?? 0) + 1;
          if (tries >= 10) {
            this.log.warn(`[wherever] shipmates: gave up marking the closed item ${item.id} on its channels`);
            this.closeRetry.delete(item.id);
            rec.closed = this.now();
            this.saveNotified();
          } else this.closeRetry.set(item.id, { at: this.now(), tries });
          return;
        }
        this.closeRetry.delete(item.id);
        rec.closed = this.now();
        this.saveNotified();
      });
  }

  /**
   * Before shipmates D39 only blocking items were pushed, so on the first start
   * without a close cursor (a notified file from before, or none at all) every
   * old non-blocking item would arrive at once. Those older than
   * `STALE_NONBLOCKING_MS` are recorded as pushed, with no refs: they stay in
   * the inbox, they are just not pushed. Newer ones and blocking ones are.
   */
  private skipStaleNonBlocking(): void {
    const k = this.shipmates;
    if (!k || this.closeCursor !== null) return;
    const kNow = (this.opts.shipmatesNow ?? Date.now)();
    let skipped = 0;
    try {
      for (const item of k.inbox()) {
        if (item.blocking || this.notified.has(item.id) || kNow - item.createdAt < STALE_NONBLOCKING_MS) continue;
        this.notified.set(item.id, { at: this.now(), refs: [] });
        skipped++;
      }
    } catch {
      return;
    }
    this.closeCursor = kNow;
    // Nothing written for a user with nothing recorded yet (the cursor goes with the first record).
    if (skipped || fs.existsSync(this.notifiedPath())) this.saveNotified();
    if (skipped) this.log.log(`[wherever] shipmates: not pushing ${skipped} non-blocking item(s) raised more than an hour before this version (they stay in the inbox)`);
  }

  private notifiedPath(): string {
    return path.join(this.opts.whereverStateDir, SHIPMATES_NOTIFIED_FILE);
  }

  private loadNotified(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.notifiedPath(), 'utf8')) as { items?: Record<string, NotifiedRecord>; closedCursor?: number };
      for (const [id, rec] of Object.entries(raw.items ?? {})) {
        if (rec && typeof rec.at === 'number')
          this.notified.set(id, {
            at: rec.at,
            refs: Array.isArray(rec.refs) ? rec.refs.filter((r) => typeof r === 'string') : [],
            ...(typeof rec.closed === 'number' ? { closed: rec.closed } : {}),
          });
      }
      // A record from before close marking has no cursor: start from now, so an
      // upgrade does not annotate a month of old questions at once.
      if (typeof raw.closedCursor === 'number') this.closeCursor = raw.closedCursor;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`[wherever] shipmates: ignoring an unreadable ${SHIPMATES_NOTIFIED_FILE}: ${(err as Error).message}`);
    }
  }

  private saveNotified(): void {
    const cutoff = this.now() - NOTIFIED_RETENTION_MS;
    // A record of an item still OPEN stays, however old: pruning it would push
    // the item again (a non-blocking item can wait for weeks).
    for (const [id, rec] of this.notified) {
      if (rec.at >= cutoff) continue;
      let open = false;
      try {
        open = this.shipmates?.item(id)?.state === 'open';
      } catch {}
      if (!open) this.notified.delete(id);
    }
    const file = this.notifiedPath();
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const closedCursor = this.closeCursor ?? (this.opts.shipmatesNow ?? Date.now)();
      fs.writeFileSync(tmp, JSON.stringify({ items: Object.fromEntries(this.notified), closedCursor }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log.warn(`[wherever] shipmates: could not record notified items: ${(err as Error).message}`);
    }
  }
}

/** The pool's session key (`normalizeSessionFile` in session-pool.ts, path.resolve), without importing the pool. */
function normalizeSessionFile(p: string): string {
  return p ? path.resolve(p) : p;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
