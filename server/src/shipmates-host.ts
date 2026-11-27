import fs from 'node:fs';
import path from 'node:path';
import type { Shipmates, ShipmatesHost, SpawnRequest, SpawnResult, StopOutcome } from 'shipmates';
import { sessionSetting } from './shipmates-settings.js';

/**
 * wherever as shipmates' HOST for spawn and stop (shipmates D20, D26, D28, D30;
 * wherever ADR 0024). @shipmates/pi's `session_spawn` / `session_stop` run inside
 * a session; they look up the process's registered host, and in the server
 * process that is this one, serving every session in the pool:
 *
 * - `spawn` creates a SIDEBAR session in the requested folder (a branch of
 *   another transcript when asked), with a live agent and NOTHING sent into it:
 *   shipmates delivers the first prompt itself, as a `spawn` message from the
 *   owner with origin `agent`, which wakes the idle session. No human-input
 *   mark is ever emitted for it. Resolves once the session exists.
 * - `stop` aborts only that session's current run; the session stays, and
 *   nothing it owns is touched. `not-mine` for a session outside the pool.
 * - @shipmates/pi delivers only inside a LOADED session, and the pool unloads
 *   an idle session after a while (and all of them on shutdown). So wherever
 *   loads a session again when a message waits for it, and @shipmates/pi then
 *   delivers it, exactly as if the session had stayed loaded:
 *   - a child it spawned, by D29's rule (a message after its last stop);
 *   - any other server session it unloaded, under the rule the session's own
 *     delivery would have applied (`planDelivery`): never with waking off,
 *     only for a human-origin message once it declared `waiting-for-human`,
 *     and never for a message already pending as it left (held on purpose, an
 *     Esc included) or older than its last stop. What was pending is recorded
 *     as the session leaves the pool (`noteUnloaded`).
 *   Waking off and the declaration come from shipmates' per-session settings
 *   (its D40, shipmates-settings.ts), for children too. On a shipmates without
 *   them, from what the presence said as the session left (`noteUnloaded`
 *   records it, since shipmates then drops the presence on unregister), and
 *   children follow D29 alone.
 *   Never a session another process has open (a terminal pi), and at most
 *   `MAX_CONCURRENT_WAKES` loads at a time (a restart with a full mailbox).
 */

/**
 * shipmates' per-process host registry, on `globalThis[Symbol.for('shipmates.host')]`
 * as `{version: 1, entries: [{host}]}` (shipmates ADR 0008: the key and the shape
 * are a contract between packages). Written here rather than through shipmates'
 * `registerHost` so the server registers at start without loading shipmates (and
 * `node:sqlite`) for a user who does not use it; shipmates-host.test.ts pins it
 * against shipmates' `currentHost()`. Most recent wins; the returned function
 * removes exactly this entry.
 */
export const SHIPMATES_HOST_REGISTRY_KEY = Symbol.for('shipmates.host');

export function registerShipmatesHost(host: ShipmatesHost): () => void {
  const g = globalThis as unknown as Record<symbol, { version: 1; entries: { host: ShipmatesHost }[] } | undefined>;
  let r = g[SHIPMATES_HOST_REGISTRY_KEY];
  if (!r || !Array.isArray(r.entries)) r = g[SHIPMATES_HOST_REGISTRY_KEY] = { version: 1, entries: [] };
  const entry = { host };
  r.entries.push(entry);
  return () => {
    const entries = g[SHIPMATES_HOST_REGISTRY_KEY]?.entries;
    const i = entries ? entries.indexOf(entry) : -1;
    if (entries && i >= 0) entries.splice(i, 1);
  };
}

/** The slice of the session pool the host drives (faked in tests). */
export interface ShipmatesHostPool {
  spawnSession(opts: {
    folder: string;
    title?: string;
    fork?: { sessionFile: string; entryId?: string };
  }): Promise<{ tracked: { sessionFile: string } } | { error: string }>;
  getSession(sessionFileOrId: string): { sessionFile: string } | null;
  isStreaming(sessionFileOrId: string): boolean;
  abortSession(sessionFileOrId: string): Promise<void>;
  loadSession(sessionFile: string, cwd?: string): Promise<{ error?: string }>;
}

export const SHIPMATES_CHILDREN_FILE = 'shipmates-children.json';
/** The server sessions the pool unloaded, with what their presence said then. */
export const SHIPMATES_UNLOADED_FILE = 'shipmates-unloaded.json';
/** Loads in flight at once; the rest follow as each finishes. */
export const MAX_CONCURRENT_WAKES = 3;
/** How long a session whose load failed is left alone before the next try. */
export const WAKE_RETRY_MS = 60_000;

/**
 * What a session's delivery would hold back, read from its presence as it left
 * the pool: `off` (waking off: nothing wakes it), `human` (it declared
 * `waiting-for-human`: only a human-origin message wakes it), `none`.
 */
export type UnloadHold = 'none' | 'human' | 'off';

interface UnloadedRecord {
  /** shipmates' clock when it left the pool. */
  at: number;
  hold: UnloadHold;
  /** The messages pending as it left: held on purpose, so they wake nothing. */
  held: string[];
  folder?: string;
}

export interface WhereverShipmatesHostOptions {
  pool: ShipmatesHostPool;
  /** wherever's state dir: the list of sessions this server spawned (ADR 0006). */
  stateDir: string;
  /** The open shipmates connection, or null while there is none (ShipmatesService). */
  shipmates: () => Shipmates | null;
  /** A spawn created a session: re-list the sidebar. */
  onSpawned?(sessionFile: string, req: SpawnRequest): void;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class WhereverShipmatesHost implements ShipmatesHost {
  private readonly children = new Map<string, { owner: string; folder: string; at: number }>();
  private readonly unloaded = new Map<string, UnloadedRecord>();
  private readonly waking = new Set<string>();
  /** A wake was skipped for the concurrency cap: look again when a load finishes. */
  private wakeDeferred = false;
  /** When a load last failed, so a session that cannot load is retried slowly, not on every change. */
  private readonly failedAt = new Map<string, number>();
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(private readonly opts: WhereverShipmatesHostOptions) {
    this.log = opts.log ?? console;
    this.load();
  }

  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    if (!req || typeof req.folder !== 'string' || !path.isAbsolute(req.folder)) throw new Error('spawn needs an absolute folder');
    const r = await this.opts.pool.spawnSession({
      folder: req.folder,
      ...(req.title ? { title: req.title } : {}),
      ...(req.fork ? { fork: req.fork } : {}),
    });
    if ('error' in r) throw new Error(r.error);
    const sessionFile = r.tracked.sessionFile;
    this.children.set(sessionFile, { owner: req.owner, folder: req.folder, at: Date.now() });
    this.save();
    this.log.log(`[wherever] shipmates: spawned ${sessionFile} for ${req.owner} (${req.spawnId})`);
    try {
      this.opts.onSpawned?.(sessionFile, req);
    } catch (err) {
      this.log.error('[wherever] shipmates: onSpawned failed:', err);
    }
    return { sessionFile };
  }

  /** shipmates has already checked that `by` owns the target (D31). */
  async stop(sessionFile: string, _opts: { by: string | null }): Promise<StopOutcome> {
    const tracked = this.opts.pool.getSession(sessionFile);
    if (!tracked) return 'not-mine';
    if (!this.opts.pool.isStreaming(tracked.sessionFile)) return 'not-running';
    await this.opts.pool.abortSession(tracked.sessionFile);
    return 'stopped';
  }

  /** The sessions this server spawned (by file), oldest first. */
  spawned(): string[] {
    return [...this.children.entries()].sort((a, b) => a[1].at - b[1].at).map(([f]) => f);
  }

  /**
   * A server session is leaving the pool (idle eviction, delete, shutdown),
   * its extensions not yet shut down: record when, and what its presence says
   * its delivery would hold back, before @shipmates/pi's unregister drops it.
   * Never throws (it runs inside the pool's teardown).
   */
  noteUnloaded(sessionFile: string): void {
    const k = this.opts.shipmates();
    if (!k) return;
    try {
      const p = k.presence(sessionFile);
      const hold: UnloadHold = p && !p.wake ? 'off' : p?.state === 'waiting-for-human' ? 'human' : 'none';
      const held = k.pendingFor(sessionFile).map((m) => m.id);
      this.unloaded.set(sessionFile, { at: k.now(), hold, held, ...(p?.cwd ? { folder: p.cwd } : {}) });
      this.saveUnloaded();
    } catch (err) {
      this.log.warn(`[wherever] shipmates: could not record the unload of ${sessionFile}: ${(err as Error).message}`);
    }
  }

  /**
   * shipmates changed: load every session of ours that is not resident, still
   * has its transcript, is not archived (D24), is not open in another process
   * and has a message its own delivery would act on (see the file comment).
   * @shipmates/pi delivers once it starts in it. At most
   * `MAX_CONCURRENT_WAKES` at once; the rest are looked at again as each load
   * finishes.
   */
  wakeEvicted(): void {
    const k = this.opts.shipmates();
    if (!k) return;
    const recipients = pendingRecipients(k);
    const candidates = new Set<string>([...this.children.keys(), ...this.unloaded.keys()]);
    let dropped = false;
    for (const file of candidates) {
      if (recipients && !recipients.has(file)) continue;
      if (this.waking.has(file) || this.opts.pool.getSession(file)) continue;
      const failed = this.failedAt.get(file);
      if (failed !== undefined && Date.now() - failed < WAKE_RETRY_MS) continue;
      if (!fs.existsSync(file)) {
        if (this.unloaded.delete(file)) dropped = true;
        continue;
      }
      const child = this.children.get(file);
      const record = this.unloaded.get(file);
      try {
        if (k.archiveMark(file) || k.isLive(file)) continue;
        if (!this.hasWakingMessage(k, file, child ? null : (record ?? null))) continue;
      } catch (err) {
        this.log.warn(`[wherever] shipmates: checking ${file} failed: ${(err as Error).message}`);
        continue;
      }
      if (this.waking.size >= MAX_CONCURRENT_WAKES) {
        this.wakeDeferred = true;
        break;
      }
      this.waking.add(file);
      void this.opts.pool
        .loadSession(file, child?.folder ?? record?.folder)
        .then((r) => {
          if (r.error) {
            this.failedAt.set(file, Date.now());
            this.log.warn(`[wherever] shipmates: could not wake ${file}: ${r.error}`);
          } else {
            this.failedAt.delete(file);
            this.log.log(`[wherever] shipmates: woke ${file} (a message is waiting for it)`);
          }
        })
        .catch((err) => {
          this.failedAt.set(file, Date.now());
          this.log.warn(`[wherever] shipmates: could not wake ${file}: ${(err as Error).message}`);
        })
        .finally(() => {
          this.waking.delete(file);
          if (this.wakeDeferred) {
            this.wakeDeferred = false;
            this.wakeEvicted();
          }
        });
    }
    if (dropped) this.saveUnloaded();
  }

  /**
   * The rule the session's own delivery would have applied: a message after its
   * last stop (D29), none with waking off, only a human-origin one while it
   * declared waiting for the human, none already pending as it left.
   */
  private hasWakingMessage(k: Shipmates, file: string, record: UnloadedRecord | null): boolean {
    const stop = k.lastStopAt(file) ?? -1;
    // shipmates' own record of the session's settings (D40) when it keeps one;
    // otherwise what its presence said as it left (children: no hold, as D29 had it).
    const setting = sessionSetting(k, file);
    const hold: UnloadHold = setting ? (!setting.wake ? 'off' : setting.declaredWaiting ? 'human' : 'none') : (record?.hold ?? 'none');
    if (hold === 'off') return false;
    const held = record?.held ?? [];
    return k.pendingFor(file).some((m) => m.createdAt > stop && !held.includes(m.id) && (hold !== 'human' || m.origin === 'human'));
  }

  /** Forget a session whose transcript is gone for good (deleted after its undo window). */
  forget(sessionFile: string): void {
    if (this.children.delete(sessionFile)) this.save();
    if (this.unloaded.delete(sessionFile)) this.saveUnloaded();
  }

  private file(): string {
    return path.join(this.opts.stateDir, SHIPMATES_CHILDREN_FILE);
  }

  private load(): void {
    this.loadUnloaded();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as { children?: Record<string, { owner: string; folder: string; at: number }> };
      for (const [f, c] of Object.entries(raw.children ?? {})) {
        if (c && typeof c.owner === 'string' && typeof c.folder === 'string') this.children.set(f, { owner: c.owner, folder: c.folder, at: typeof c.at === 'number' ? c.at : 0 });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`[wherever] shipmates: ignoring an unreadable ${SHIPMATES_CHILDREN_FILE}: ${(err as Error).message}`);
    }
  }

  private save(): void {
    const file = this.file();
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ children: Object.fromEntries(this.children) }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log.warn(`[wherever] shipmates: could not record spawned sessions: ${(err as Error).message}`);
    }
  }

  private unloadedFile(): string {
    return path.join(this.opts.stateDir, SHIPMATES_UNLOADED_FILE);
  }

  private loadUnloaded(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.unloadedFile(), 'utf8')) as { sessions?: Record<string, Partial<UnloadedRecord>> };
      for (const [f, r] of Object.entries(raw.sessions ?? {})) {
        if (!r || typeof r.at !== 'number') continue;
        const hold: UnloadHold = r.hold === 'off' || r.hold === 'human' ? r.hold : 'none';
        const held = Array.isArray(r.held) ? r.held.filter((x): x is string => typeof x === 'string') : [];
        this.unloaded.set(f, { at: r.at, hold, held, ...(typeof r.folder === 'string' ? { folder: r.folder } : {}) });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`[wherever] shipmates: ignoring an unreadable ${SHIPMATES_UNLOADED_FILE}: ${(err as Error).message}`);
    }
  }

  private saveUnloaded(): void {
    const file = this.unloadedFile();
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ sessions: Object.fromEntries(this.unloaded) }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log.warn(`[wherever] shipmates: could not record unloaded sessions: ${(err as Error).message}`);
    }
  }
}

/**
 * The sessions some pending message is for (to the session, or to a role it
 * holds), in one read, so a change costs one query rather than one per known
 * session. Null when the schema is not the one expected (another shipmates
 * version): every candidate is then checked through the API instead.
 */
const recipientsQuery = new WeakMap<Shipmates, ReturnType<Shipmates['db']['prepare']>>();
function pendingRecipients(k: Shipmates): Set<string> | null {
  try {
    let st = recipientsQuery.get(k);
    if (!st) {
      st = k.db.prepare(
        `SELECT to_target AS f FROM message WHERE state = 'pending' AND to_kind = 'session'
         UNION SELECT r.session_file AS f FROM role r JOIN message m
           ON m.state = 'pending' AND m.to_kind = 'role' AND m.to_target = r.role`,
      );
      recipientsQuery.set(k, st);
    }
    return new Set((st.all() as { f: string }[]).map((r) => r.f));
  } catch {
    return null;
  }
}
