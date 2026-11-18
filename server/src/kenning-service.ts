import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttentionItem, Kenning, Presence } from 'kenning';

/**
 * wherever as a kenning HOST (kenning's spec "Architecture", D20; wherever ADR
 * 0023 for the human-input half). kenning-pi already runs inside every server
 * session as an ordinary extension (presence, delivery, the tools); this module
 * adds what only wherever can do with the same database:
 *
 * - the human's ATTENTION INBOX on the web (a panel, a badge, a reply box) and
 *   the PRESENCE of each session in the session list, pushed to dashboards as
 *   `kenning_update` frames on every change (polled like kenning's own D6
 *   watcher, then throttled like `sessions_updated`);
 * - an authenticated web or Telegram answer is a HUMAN act, so it goes through
 *   `answerItem(id, text, {channel})`;
 * - a BLOCKING item is pushed once through the assistant's channels (Web Push,
 *   Telegram), linking to the asking session; a Telegram reply to that message
 *   answers it.
 *
 * It never creates kenning's database: it opens it once it EXISTS (kenning-pi
 * or the kenning CLI made it), checking every `openPollMs` until then, so a
 * user who does not use kenning gets nothing written. `kenning.enabled: false`
 * in config.json turns it off entirely.
 */

/** One open attention item, as the web shows it. */
export interface KenningInboxItemView {
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
export interface KenningPresenceView {
  sessionFile: string;
  sessionId: string | null;
  roles: string[];
  state: Presence['state'];
  status: string | null;
  waitingOn: string | null;
}

/** What a dashboard gets (`kenning_update`). `available` false = no kenning database (or off). */
export interface KenningSnapshot {
  available: boolean;
  inbox: KenningInboxItemView[];
  presence: KenningPresenceView[];
}

/** A blocking item to push through the channels (`ChannelNotification` shape). */
export interface KenningNotification {
  itemId: string;
  title: string;
  body: string;
  source: string;
  /** The session id a tap opens ('' = the main screen). */
  navigate: string;
}

/** What pushing one notification produced: whether anything delivered, and the channel-side refs a reply can name. */
export interface KenningNotifyOutcome {
  delivered: boolean;
  /** `<channel>:<id>` per message sent (Telegram: `telegram:<chatId>:<messageId>`). */
  refs: string[];
  error?: string;
}

export type KenningAnswerResult = { ok: true } | { ok: false; error: string };

export const KENNING_NOTIFIED_FILE = 'kenning-notified.json';
export const KENNING_DISABLED_ERROR = 'kenning is not available on this server (no kenning database yet, or `kenning.enabled` is false)';
const NOTIFIED_RETENTION_MS = 30 * 86_400_000; // kenning prunes finished items after 30 days (D11)
/**
 * kenning's database dir, as kenning's `defaultStateDir()` (its store.ts)
 * computes it, without loading kenning (and `node:sqlite`) for a user who does
 * not use it. kenning-service.test.ts pins the two together.
 */
export function kenningStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KENNING_STATE_DIR) return env.KENNING_STATE_DIR;
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'kenning');
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

export function inboxItemView(item: AttentionItem, presence: Presence | null): KenningInboxItemView {
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

export function presenceView(p: Presence): KenningPresenceView {
  return {
    sessionFile: normalizeSessionFile(p.sessionFile),
    sessionId: p.sessionId,
    roles: p.roles,
    state: p.state,
    status: p.status,
    waitingOn: p.waitingOn,
  };
}

/** The notification for a blocking item. Pure. */
export function kenningNotification(item: AttentionItem, presence: Presence | null): KenningNotification {
  const lines = [item.question];
  if (item.options?.length) lines.push(`Options: ${item.options.join(' / ')}`);
  lines.push('Answer in the wherever inbox, or reply to this message on Telegram.');
  return {
    itemId: item.id,
    title: 'Question for you',
    body: lines.join('\n'),
    source: sessionLabel(item.session, presence),
    navigate: sessionIdOf(item.session, presence) ?? '',
  };
}

interface NotifiedRecord {
  at: number;
  refs: string[];
}

export interface KenningServiceOptions {
  /** Off = never open kenning (`kenning.enabled: false`). */
  enabled: boolean;
  /** wherever's state dir: where the once-per-item notification record lives (ADR 0006). */
  whereverStateDir: string;
  /** kenning's own state dir (default: kenning's, `KENNING_STATE_DIR` or `$XDG_STATE_HOME/kenning`). */
  kenningStateDir?: string;
  /** Called with a new snapshot whenever it changed (throttled). */
  onUpdate(snapshot: KenningSnapshot): void;
  /** Leading + trailing throttle of `onUpdate`, like `sessions_updated` (default 2000 ms). */
  throttleMs?: number;
  /** How often kenning's database is polled for changes (kenning's D6 interval, default 1000 ms). */
  pollMs?: number;
  /** How often to look for the database before it exists (default 5000 ms). */
  openPollMs?: number;
  /** Re-evaluate the snapshot this often even without a write: a crashed session's presence goes stale by pid, not by a write (default 30 s). */
  refreshMs?: number;
  /** An item no channel delivered is tried again at most this often (default 60 s). */
  notifyRetryMs?: number;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
  now?: () => number;
}

export class KenningService {
  private kenning: Kenning | null = null;
  private opening = false;
  private watcher: { stop(): void } | null = null;
  private openTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateAt = 0;
  private lastSent = '';
  private notifier: ((n: KenningNotification) => Promise<KenningNotifyOutcome>) | null = null;
  private notified = new Map<string, NotifiedRecord>();
  private notifying = new Set<string>();
  /** Items no channel delivered yet: when they were last tried (memory only). */
  private undelivered = new Map<string, number>();
  private stopped = false;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly now: () => number;
  private readonly dbPath: string;

  constructor(private readonly opts: KenningServiceOptions) {
    this.log = opts.log ?? console;
    this.now = opts.now ?? Date.now;
    this.dbPath = path.join(opts.kenningStateDir ?? kenningStateDir(), 'kenning.db');
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
    return this.kenning !== null;
  }

  /**
   * Load kenning only now (it brings `node:sqlite`, which Node 22 announces with
   * an ExperimentalWarning) and open the database. A database that exists but
   * will not open is logged once and not retried.
   */
  private open(): Promise<void> {
    if (this.opening) return this.openPromise ?? Promise.resolve();
    this.opening = true;
    this.openPromise = (async () => {
      let mod: typeof import('kenning');
      try {
        mod = await import('kenning');
        if (this.stopped) return;
        mod.silenceSqliteWarning();
        this.kenning = mod.openKenning({ stateDir: path.dirname(this.dbPath) });
      } catch (err) {
        this.log.warn(`[wherever] kenning: could not open ${this.dbPath} (${(err as Error).message}); the inbox stays off`);
        return;
      }
      this.loadNotified();
      this.log.log(`[wherever] kenning: inbox and presence from ${this.dbPath}`);
      this.watcher = mod.watchChanges(this.kenning, () => this.onChange(), { intervalMs: this.opts.pollMs ?? 1000 });
      this.refreshTimer = setInterval(() => {
        this.checkNotifications(); // retries an undelivered item even when nothing is written
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
      this.kenning?.close();
    } catch {}
    this.kenning = null;
  }

  /** The current snapshot (sent to a dashboard as it connects). */
  snapshot(): KenningSnapshot {
    const k = this.kenning;
    if (!k) return { available: false, inbox: [], presence: [] };
    try {
      const live = k.list();
      const bySession = new Map(live.map((p) => [p.sessionFile, p]));
      const inbox = k.inbox().map((item) => inboxItemView(item, bySession.get(item.session) ?? k.presence(item.session)));
      return { available: true, inbox, presence: live.map(presenceView) };
    } catch (err) {
      this.log.warn(`[wherever] kenning: reading the inbox failed: ${(err as Error).message}`);
      return { available: true, inbox: [], presence: [] };
    }
  }

  /**
   * The human answered an item from an authenticated wherever surface (the web
   * reply box: `web`; a Telegram reply from the paired user: `telegram`). Only
   * ever called for a real human act (ADR 0003): never from a CLI bridge
   * connection, never from a tool.
   */
  answer(itemId: string, text: string, channel: 'web' | 'telegram'): KenningAnswerResult {
    const k = this.kenning;
    if (!k) return { ok: false, error: KENNING_DISABLED_ERROR };
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

  /**
   * Where blocking items go (the assistant's channel dispatcher). Set once the
   * channels have started; without one, nothing is pushed or recorded, so the
   * items are pushed when a later start has channels.
   */
  setNotifier(fn: ((n: KenningNotification) => Promise<KenningNotifyOutcome>) | null): void {
    this.notifier = fn;
    if (fn) this.checkNotifications();
  }

  /**
   * A channel-side reply (Telegram: a reply to a message, `ref` =
   * `telegram:<chatId>:<messageId>`). Answers the item that message notified,
   * as the human on `channel`. `handled: false` when the message notified no
   * item: the channel then treats it as an ordinary message.
   */
  answerFromReply(ref: string, text: string, channel: 'telegram'): { handled: false } | { handled: true; reply: string } {
    let itemId: string | null = null;
    for (const [id, rec] of this.notified) if (rec.refs.includes(ref)) itemId = id;
    if (!itemId) return { handled: false };
    const k = this.kenning;
    if (!k) return { handled: true, reply: `⚠️ ${KENNING_DISABLED_ERROR}.` };
    const item = k.item(itemId);
    if (!item || item.state !== 'open') return { handled: true, reply: 'That question was already answered (or withdrawn).' };
    const r = this.answer(itemId, text, channel);
    return { handled: true, reply: r.ok ? `✅ Answered: ${clip(item.question, 120)}` : `⚠️ Could not answer: ${r.error}` };
  }

  private onChange(): void {
    this.checkNotifications();
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
    if (!this.kenning) return;
    this.lastUpdateAt = this.now();
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    if (json === this.lastSent) return;
    this.lastSent = json;
    try {
      this.opts.onUpdate(snap);
    } catch (err) {
      this.log.error('[wherever] kenning: broadcasting the inbox failed:', err);
    }
  }

  /** Push every open blocking item not pushed before, once (recorded in the state dir). */
  private checkNotifications(): void {
    const k = this.kenning;
    const notify = this.notifier;
    if (!k || !notify) return;
    let items: AttentionItem[];
    try {
      items = k.inbox().filter((i) => i.blocking);
    } catch {
      return;
    }
    for (const item of items) {
      if (this.notified.has(item.id) || this.notifying.has(item.id)) continue;
      const lastTry = this.undelivered.get(item.id);
      if (lastTry !== undefined && this.now() - lastTry < (this.opts.notifyRetryMs ?? 60_000)) continue;
      this.notifying.add(item.id);
      const n = kenningNotification(item, k.presence(item.session));
      void notify(n)
        .catch((err): KenningNotifyOutcome => ({ delivered: false, refs: [], error: (err as Error).message }))
        .then((out) => {
          this.notifying.delete(item.id);
          if (!out.delivered) {
            // Nothing reached the human (no device subscribed, Telegram not
            // paired, a network error): not recorded, so the item is pushed
            // once a channel can deliver, tried again at most every
            // `notifyRetryMs`. Said once per item, not on every try.
            if (!this.undelivered.has(item.id)) this.log.warn(`[wherever] kenning: could not push item ${item.id}: ${out.error ?? 'no channel delivered'}; trying again later`);
            this.undelivered.set(item.id, this.now());
            return;
          }
          // ONCE per item: recorded in the state dir, so a restart never repeats it.
          this.undelivered.delete(item.id);
          this.notified.set(item.id, { at: this.now(), refs: out.refs });
          this.saveNotified();
        });
    }
  }

  private notifiedPath(): string {
    return path.join(this.opts.whereverStateDir, KENNING_NOTIFIED_FILE);
  }

  private loadNotified(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.notifiedPath(), 'utf8')) as { items?: Record<string, NotifiedRecord> };
      for (const [id, rec] of Object.entries(raw.items ?? {})) {
        if (rec && typeof rec.at === 'number') this.notified.set(id, { at: rec.at, refs: Array.isArray(rec.refs) ? rec.refs.filter((r) => typeof r === 'string') : [] });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`[wherever] kenning: ignoring an unreadable ${KENNING_NOTIFIED_FILE}: ${(err as Error).message}`);
    }
  }

  private saveNotified(): void {
    const cutoff = this.now() - NOTIFIED_RETENTION_MS;
    for (const [id, rec] of this.notified) if (rec.at < cutoff) this.notified.delete(id);
    const file = this.notifiedPath();
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ items: Object.fromEntries(this.notified) }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log.warn(`[wherever] kenning: could not record notified items: ${(err as Error).message}`);
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
