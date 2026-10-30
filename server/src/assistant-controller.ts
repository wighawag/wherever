import fs from 'node:fs';
import path from 'node:path';

/**
 * The assistant CONTROLLER (spec `assistant-session-and-channels`, ADRs 0014 to
 * 0018): owns WHICH session is the current assistant session, and resets it.
 *
 * The session is disposable; the folder is the memory. So exactly one session in
 * `assistantFolder` (never in `jobs/`) is CURRENT, recorded as a POINTER (a
 * session file path) in the STATE dir (ADR 0006: server-written state never goes
 * in the config dir). A reset makes a fresh session in the folder the pointer
 * target.
 *
 * Exists only while the assistant is ACTIVE (configured AND this server holds the
 * folder lock, see assistant-folder.ts). With `assistantFolder` unset no
 * controller is built and no session-created callback is registered, so the pool
 * behaves exactly as before.
 *
 * Every pointer transition (open, reset, a session created in the folder) runs
 * through ONE serial queue. That is what makes the move idempotent and a reset
 * abort exactly once: the controller's own creation also fires the pool's
 * session-created callback, and by the time that callback's turn in the queue
 * comes, the pointer already names the new session, so it is a no-op.
 */

/** Pointer file, at the root of the state dir (beside ADR 0015's `assistant-runs.jsonl`). */
export const ASSISTANT_POINTER_FILE = 'assistant-session.json';

/**
 * Where a message fed to the assistant came from (`telegram`, `schedule:<jobId>`,
 * ...). `send` threads it into the pool, which records it in the session's
 * per-user-message reply routing (ADR 0014, `reply-routing.ts`).
 */
export type AssistantOrigin = string;

/** The slice of `SessionPool` the controller drives (the seam the tests fake). */
export interface AssistantPoolPort {
  createNewSession(
    cwd: string,
    modelStr?: string,
    gitInit?: boolean,
    createRemote?: boolean,
    repoVisibility?: 'private' | 'public',
    forceNew?: boolean,
  ): Promise<{ tracked: { sessionId: string; sessionFile: string; cwd: string }; error?: string; sessionFile?: string }>;
  loadSession(sessionFile: string): Promise<{ tracked: { sessionId: string; sessionFile: string; cwd: string }; error?: string }>;
  getSession(sessionFile: string): { sessionId: string; sessionFile: string; cwd: string } | null;
  isStreaming(sessionFile: string): boolean;
  abortSession(sessionFile: string): Promise<void>;
  /** Clear pi's steer + followUp queues, returning what was dropped; null when not resident / not readable (CLI). */
  clearQueuedMessages(sessionFile: string): { steering: string[]; followUp: string[] } | null;
  sendUserMessage(
    sessionFile: string,
    text: string,
    streamingBehavior?: 'steer' | 'followUp',
    conversationMode?: boolean,
    origin?: AssistantOrigin,
  ): Promise<void>;
  pinSession(sessionFile: string): void;
  unpinSession(sessionFile: string): void;
}

/** What `GET /config`'s `assistant` gains from the controller. */
export interface AssistantPointerStatus {
  currentSessionId: string | null;
  currentSessionFile: string | null;
}

/** The current assistant session, as handed to a caller that opens it. */
export interface AssistantCurrentSession {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}

/**
 * Messages pi still held queued (steer / followUp) on a session the controller
 * retired. An abort leaves pi's queues populated (ADR 0014), so a reset clears
 * them and RECORDS them here; `channel-seam-notify-and-web-push` reports them to
 * the channels of their routing origins.
 */
export interface DroppedMessages {
  sessionFile: string;
  reason: 'reset';
  steering: string[];
  followUp: string[];
  at: string;
}

interface PointerRecord {
  folder: string;
  sessionFile: string;
  sessionId: string;
  updatedAt: string;
}

/** Bound on the in-memory dropped-message record (it is reported, not archived). */
const DROPPED_KEEP = 50;

export interface AssistantControllerOptions {
  pool: AssistantPoolPort;
  /** The ACTIVE assistant folder (absolute). */
  folder: string;
  /** The wherever state dir (`getWhereverStateDir()`). */
  stateDir: string;
  /** Called after the pointer moved (the server rebroadcasts the status). */
  onChange?: (status: AssistantPointerStatus) => void;
  /** Called with each non-empty batch of dropped messages. */
  onDropped?: (dropped: DroppedMessages) => void;
}

export class AssistantController {
  private readonly pool: AssistantPoolPort;
  private readonly folder: string;
  private readonly pointerPath: string;
  private readonly onChange?: (status: AssistantPointerStatus) => void;
  private readonly onDropped?: (dropped: DroppedMessages) => void;
  private pointer: { sessionFile: string; sessionId: string } | null;
  private dropped: DroppedMessages[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Sessions the controller created itself. Their session-created callback is
   * queued BEHIND the operation that created them, so by its turn the pointer may
   * already have moved on (e.g. `send` replacing a pointer it just created): it
   * must never move the pointer back.
   */
  private ownCreations = new Set<string>();

  constructor(opts: AssistantControllerOptions) {
    this.pool = opts.pool;
    this.folder = path.resolve(opts.folder);
    this.pointerPath = path.join(opts.stateDir, ASSISTANT_POINTER_FILE);
    this.onChange = opts.onChange;
    this.onDropped = opts.onDropped;
    this.pointer = this.readPointer();
    if (this.pointer) this.pool.pinSession(this.pointer.sessionFile);
  }

  status(): AssistantPointerStatus {
    return {
      currentSessionId: this.pointer?.sessionId ?? null,
      currentSessionFile: this.pointer?.sessionFile ?? null,
    };
  }

  /** Every batch of dropped messages recorded so far (bounded), oldest first. */
  droppedMessages(): DroppedMessages[] {
    return [...this.dropped];
  }

  /** Resolves once every queued pointer transition has run (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue.then(
      () => {},
      () => {},
    );
  }

  /**
   * The current assistant session, creating one (and pointing at it) when there
   * is none. A pointer that is neither resident nor on disk is replaced: pi
   * writes a session file only once the conversation starts, so an evicted or
   * pre-restart pointer to a session nobody spoke in names nothing loadable.
   */
  ensureCurrent(): Promise<AssistantCurrentSession> {
    return this.serial(() => this.ensureCurrentUnqueued());
  }

  /**
   * Reset: retire the current session (abort a running turn, then clear and
   * record pi's queues), create a fresh session in the folder (forceNew, so a
   * tab still viewing the old one does not hand it back), and point at it.
   */
  reset(): Promise<AssistantCurrentSession> {
    return this.serial(async () => {
      if (this.pointer) await this.retire(this.pointer.sessionFile);
      return this.createAndPoint();
    });
  }

  /**
   * The pool's session-created callback. A session created IN the assistant
   * folder itself (not `jobs/`, not anywhere else) becomes current; the session
   * it replaces is retired like a reset. This is how a web `/new` / `/reset`
   * (a forceNew `session_new`) in the assistant session becomes an assistant
   * reset with no composer change. Idempotent: a session that is already the
   * pointer (the controller's own creation) is a no-op.
   */
  handleSessionCreated(sessionFile: string, cwd: string): Promise<void> {
    if (path.resolve(cwd) !== this.folder) return Promise.resolve();
    return this.serial(async () => {
      if (this.ownCreations.delete(sessionFile)) return;
      if (this.pointer?.sessionFile === sessionFile) return;
      if (this.pointer) await this.retire(this.pointer.sessionFile);
      const sessionId = this.pool.getSession(sessionFile)?.sessionId ?? '';
      this.movePointer(sessionFile, sessionId);
    }).catch((err) => {
      console.error(`[wherever] assistant: could not adopt new session ${sessionFile}: ${errMessage(err)}`);
    });
  }

  /**
   * Feed a message to the current assistant session (for the channels and the
   * scheduler). Loads the pointer first: the pool's `sendUserMessage` silently
   * no-ops on a session that is not resident (idle eviction, restart). Into a
   * running turn the message STEERS, as the web composer does (ADR 0003).
   * `origin` is recorded by the pool's reply routing (ADR 0014), so the reply
   * to this message is attributed to it.
   */
  async send(text: string, origin: AssistantOrigin, streamingBehavior?: 'steer' | 'followUp'): Promise<void> {
    const cur = await this.serial(async () => {
      const c = await this.ensureCurrentUnqueued();
      const loaded = await this.pool.loadSession(c.sessionFile);
      if (!loaded.error) return c;
      // The file vanished between the check and the load: start afresh.
      return this.createAndPoint();
    });
    const behavior = streamingBehavior ?? (this.pool.isStreaming(cur.sessionFile) ? 'steer' : undefined);
    await this.pool.sendUserMessage(cur.sessionFile, text, behavior, false, origin);
  }

  // -------------------------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async ensureCurrentUnqueued(): Promise<AssistantCurrentSession> {
    if (this.pointer) {
      const file = this.pointer.sessionFile;
      const resident = this.pool.getSession(file);
      if (resident) return { sessionFile: file, sessionId: resident.sessionId, cwd: resident.cwd };
      if (fs.existsSync(file)) return { sessionFile: file, sessionId: this.pointer.sessionId, cwd: this.folder };
    }
    return this.createAndPoint();
  }

  private async createAndPoint(): Promise<AssistantCurrentSession> {
    const result = await this.pool.createNewSession(this.folder, undefined, undefined, undefined, undefined, true);
    if (result.error || !result.tracked) {
      throw new Error(result.error || 'could not create the assistant session');
    }
    const { sessionFile, sessionId, cwd } = result.tracked;
    this.ownCreations.add(sessionFile);
    // Bounded backstop, should a pool ever not call back for a creation.
    if (this.ownCreations.size > 100) this.ownCreations.delete(this.ownCreations.values().next().value!);
    this.movePointer(sessionFile, sessionId);
    return { sessionFile, sessionId, cwd };
  }

  /** Abort the session's running turn, if any, then clear and record its queues. Never throws. */
  private async retire(sessionFile: string): Promise<void> {
    try {
      if (this.pool.isStreaming(sessionFile)) await this.pool.abortSession(sessionFile);
    } catch (err) {
      console.error(`[wherever] assistant: abort of ${sessionFile} on reset failed: ${errMessage(err)}`);
    }
    let cleared: { steering: string[]; followUp: string[] } | null = null;
    try {
      cleared = this.pool.clearQueuedMessages(sessionFile);
    } catch (err) {
      console.error(`[wherever] assistant: clearing the queue of ${sessionFile} on reset failed: ${errMessage(err)}`);
    }
    if (cleared && (cleared.steering.length > 0 || cleared.followUp.length > 0)) {
      const record: DroppedMessages = {
        sessionFile,
        reason: 'reset',
        steering: [...cleared.steering],
        followUp: [...cleared.followUp],
        at: new Date().toISOString(),
      };
      this.dropped.push(record);
      if (this.dropped.length > DROPPED_KEEP) this.dropped.splice(0, this.dropped.length - DROPPED_KEEP);
      console.log(
        `[wherever] assistant reset dropped ${record.steering.length + record.followUp.length} queued message(s) of ${sessionFile}`,
      );
      try {
        this.onDropped?.(record);
      } catch (err) {
        console.error(`[wherever] assistant: onDropped failed: ${errMessage(err)}`);
      }
    }
  }

  private movePointer(sessionFile: string, sessionId: string): void {
    const previous = this.pointer?.sessionFile;
    if (previous === sessionFile && this.pointer?.sessionId === sessionId) return;
    if (previous && previous !== sessionFile) this.pool.unpinSession(previous);
    this.pointer = { sessionFile, sessionId };
    this.pool.pinSession(sessionFile);
    this.writePointer();
    try {
      this.onChange?.(this.status());
    } catch (err) {
      console.error(`[wherever] assistant: onChange failed: ${errMessage(err)}`);
    }
  }

  /**
   * The pointer from the state dir, or null. A record written for a DIFFERENT
   * assistant folder (the config changed across a restart) is ignored: its
   * session lives in the old folder, and the pointer must name one in this one.
   */
  private readPointer(): { sessionFile: string; sessionId: string } | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.pointerPath, 'utf8');
    } catch {
      return null;
    }
    try {
      const rec = JSON.parse(raw) as Partial<PointerRecord>;
      if (typeof rec.sessionFile !== 'string' || typeof rec.folder !== 'string') return null;
      if (path.resolve(rec.folder) !== this.folder) return null;
      return { sessionFile: rec.sessionFile, sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '' };
    } catch {
      console.warn(`[wherever] assistant: ignoring an unreadable pointer at ${this.pointerPath}`);
      return null;
    }
  }

  /** Atomic (tmp + rename), like drafts and stars. A failure is logged; the in-memory pointer still holds. */
  private writePointer(): void {
    if (!this.pointer) return;
    const rec: PointerRecord = {
      folder: this.folder,
      sessionFile: this.pointer.sessionFile,
      sessionId: this.pointer.sessionId,
      updatedAt: new Date().toISOString(),
    };
    const dir = path.dirname(this.pointerPath);
    const tmp = path.join(dir, `.${ASSISTANT_POINTER_FILE}.${process.pid}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.pointerPath);
    } catch (err) {
      console.error(`[wherever] assistant: could not write the pointer to ${this.pointerPath}: ${errMessage(err)}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
