import fs from 'node:fs';
import path from 'node:path';
import type { Shipmates, ShipmatesHost, SpawnRequest, SpawnResult, StopOutcome } from 'shipmates';

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
 * - shipmates wakes only its own headless children (D29), so wherever wakes the
 *   ones it spawned: a child the pool evicted while idle (or that a restart
 *   left unloaded) is loaded again when a message for it is pending, and
 *   @shipmates/pi then delivers it.
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
  private readonly waking = new Set<string>();
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
   * shipmates changed: load every child of ours that is not resident, still has
   * its transcript, is not archived (D24) and has a message pending that came
   * after its last stop (D29's rule, so a stopped child is not restarted by the
   * mail it was stopped over). @shipmates/pi delivers once it starts in it.
   */
  wakeEvicted(): void {
    const k = this.opts.shipmates();
    if (!k) return;
    for (const [file, child] of this.children) {
      if (this.waking.has(file) || this.opts.pool.getSession(file)) continue;
      if (!fs.existsSync(file)) continue;
      try {
        if (k.archiveMark(file)) continue;
        const since = k.lastStopAt(file) ?? -1;
        if (!k.pendingFor(file).some((m) => m.createdAt > since)) continue;
      } catch (err) {
        this.log.warn(`[wherever] shipmates: checking ${file} failed: ${(err as Error).message}`);
        continue;
      }
      this.waking.add(file);
      void this.opts.pool
        .loadSession(file, child.folder)
        .then((r) => {
          if (r.error) this.log.warn(`[wherever] shipmates: could not wake ${file}: ${r.error}`);
          else this.log.log(`[wherever] shipmates: woke ${file} (a message is waiting for it)`);
        })
        .catch((err) => this.log.warn(`[wherever] shipmates: could not wake ${file}: ${(err as Error).message}`))
        .finally(() => this.waking.delete(file));
    }
  }

  /** Forget a child whose transcript is gone for good (deleted after its undo window). */
  forget(sessionFile: string): void {
    if (this.children.delete(sessionFile)) this.save();
  }

  private file(): string {
    return path.join(this.opts.stateDir, SHIPMATES_CHILDREN_FILE);
  }

  private load(): void {
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
}
