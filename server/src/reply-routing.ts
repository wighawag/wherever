/**
 * Per-USER-MESSAGE reply routing (ADR 0014), the pure state the session pool
 * keeps for ONE session file.
 *
 * Every pool send that WILL produce a user message records the ORIGIN it came
 * from (`telegram`, `schedule:<jobId>`, ...; a web send records `none`). A user
 * `message_end` takes the head of the matching queue, and that origin is the
 * session's current DESTINATION until the next user message: everything the
 * agent says in between answers that message. Matching is by POSITION, never by
 * text (`/skill:` and prompt-template expansion rewrite the text).
 *
 * Two queues, one per pi delivery mode: prompt-or-steer, and followUp (pi keeps
 * steer and followUp in separate queues and delivers steers first).
 *
 * Each entry also tracks what pi told the pool about it (`prompt()`'s
 * `preflightResult`), because a queue that keeps an entry for a send that
 * produced no message drifts permanently:
 *  - `pending`: sent, `preflightResult` not called yet (pi is still in extension
 *    input handlers / the compaction check);
 *  - `started`: pi started a run with it, so it is the NEXT user message. It is
 *    moved to the FRONT of prompt-or-steer: a prompt into an idle session jumps
 *    ahead of steers an abort left in pi's queue (pi delivers those only after
 *    the prompt's first turn);
 *  - `queued`: in pi's steer or followUp queue;
 *  - `deferred`: `prompt()` returned without calling `preflightResult` (pi
 *    defers a prompt made while it is emitting `agent_settled`); it stays
 *    pending until its preflight fires, and is dropped as stale at the next
 *    settle if it never did (the deferred action threw);
 *  - `relayed`: a CLI-bridge send, whose preflight the server cannot see.
 * A `handled` preflight or a throwing send drops the entry (`drop`).
 *
 * Purely internal bookkeeping: nothing here is observable by a client or the
 * model. Origins are opaque strings to this module.
 *
 * Why these rules refine ADR 0014's "head of the matching queue" (the started
 * move, the take preference, the trim keeping in-flight sends):
 * work/notes/observations/pool-per-message-routing-decisions.md.
 */

/** What a web send records: it came from no channel. */
export const WEB_ORIGIN = 'none';

/** Where a user message came from (`none`, `telegram`, `schedule:<jobId>`, ...). */
export type ReplyOrigin = string;

/** Which routing queue a send goes to, from its requested pi delivery mode. */
export type RoutingMode = 'promptOrSteer' | 'followUp';

type EntryState = 'pending' | 'started' | 'queued' | 'deferred' | 'relayed';

interface Entry {
  origin: ReplyOrigin;
  state: EntryState;
}

/** Opaque handle on one recorded send. Stale tickets (taken, dropped, trimmed) are ignored. */
export interface RoutingTicket {
  readonly __routingTicket: true;
}

export interface RoutingSnapshot {
  promptOrSteer: ReplyOrigin[];
  followUp: ReplyOrigin[];
}

export class ReplyRouting {
  private promptOrSteer: Entry[] = [];
  private followUp: Entry[] = [];
  private current: ReplyOrigin | null = null;

  /** Record a send about to reach pi. */
  record(origin: ReplyOrigin, mode: RoutingMode): RoutingTicket {
    const entry: Entry = { origin, state: 'pending' };
    (mode === 'followUp' ? this.followUp : this.promptOrSteer).push(entry);
    return entry as unknown as RoutingTicket;
  }

  /** `preflightResult('started')`: it is the next user message. */
  started(ticket: RoutingTicket): void {
    const entry = this.remove(ticket);
    if (!entry) return;
    entry.state = 'started';
    // Behind any earlier started entry still waiting for its message_end.
    const at = this.promptOrSteer.findIndex((e) => e.state !== 'started');
    this.promptOrSteer.splice(at === -1 ? this.promptOrSteer.length : at, 0, entry);
  }

  /** `preflightResult('queued')`: it sits in pi's steer / followUp queue. */
  queued(ticket: RoutingTicket): void {
    this.setState(ticket, 'queued');
  }

  /** `prompt()` returned without calling `preflightResult`: deferred by pi. */
  deferred(ticket: RoutingTicket): void {
    const entry = this.find(ticket);
    if (entry?.state === 'pending') entry.state = 'deferred';
  }

  /** A CLI-bridge send was relayed to the terminal pi. */
  relayed(ticket: RoutingTicket): void {
    this.setState(ticket, 'relayed');
  }

  /** The send produced no user message (`handled`, or it threw). */
  drop(ticket: RoutingTicket): void {
    this.remove(ticket);
  }

  /**
   * A user `message_end`: take the matching entry and make its origin the
   * current destination (null = no origin, e.g. a message typed directly in a
   * CLI terminal with nothing recorded). pi delivers a started prompt first,
   * then steers, then follow-ups, so an entry pi has (started / queued /
   * relayed) wins over one still awaiting its preflight; with none, the oldest
   * remaining entry is taken (ADR 0014's accepted CLI misattribution, corrected
   * at the next settle).
   */
  takeForUserMessage(): ReplyOrigin | null {
    const known = (e: Entry) => e.state !== 'pending' && e.state !== 'deferred';
    const entry =
      this.takeFirst(this.promptOrSteer, known) ??
      this.takeFirst(this.followUp, known) ??
      this.takeFirst(this.promptOrSteer, () => true) ??
      this.takeFirst(this.followUp, () => true);
    this.current = entry ? entry.origin : null;
    return this.current;
  }

  /** The origin of the user message the session's current output answers. */
  destination(): ReplyOrigin | null {
    return this.current;
  }

  /**
   * Server-session settle: trim each queue to pi's ACTUAL queue length, keeping
   * the newest (an abort leaves pi's queues populated, so "empty at settle" is
   * false). Sends still awaiting their preflight are not in pi's queue yet and
   * are kept; a started entry with no message_end, or a deferred one from an
   * earlier settle, is stale and dropped.
   */
  trimToPiQueues(steeringLength: number, followUpLength: number): void {
    this.promptOrSteer = trimQueue(this.promptOrSteer, steeringLength);
    this.followUp = trimQueue(this.followUp, followUpLength);
  }

  /**
   * pi's queues were cleared (`clearQueue`): drop what pi had queued (sends not
   * in pi yet still arrive afterwards and keep their entry). Returns the dropped
   * origins, oldest first.
   */
  clear(): RoutingSnapshot {
    const isInPi = (e: Entry) => e.state === 'queued' || e.state === 'relayed';
    const dropped = {
      promptOrSteer: this.promptOrSteer.filter(isInPi).map((e) => e.origin),
      followUp: this.followUp.filter(isInPi).map((e) => e.origin),
    };
    this.promptOrSteer = this.promptOrSteer.filter((e) => !isInPi(e));
    this.followUp = this.followUp.filter((e) => !isInPi(e));
    return dropped;
  }

  /** CLI-bridge settle: the server cannot see the terminal pi's queues, so empty both. */
  empty(): void {
    this.promptOrSteer = [];
    this.followUp = [];
  }

  /** True when nothing is recorded and there is no destination (safe to forget). */
  isBlank(): boolean {
    return this.promptOrSteer.length === 0 && this.followUp.length === 0 && this.current === null;
  }

  /** The recorded origins, oldest first (tests, diagnostics). */
  snapshot(): RoutingSnapshot {
    return {
      promptOrSteer: this.promptOrSteer.map((e) => e.origin),
      followUp: this.followUp.map((e) => e.origin),
    };
  }

  // -------------------------------------------------------------------------

  private find(ticket: RoutingTicket): Entry | undefined {
    const entry = ticket as unknown as Entry;
    return this.promptOrSteer.includes(entry) || this.followUp.includes(entry) ? entry : undefined;
  }

  private setState(ticket: RoutingTicket, state: EntryState): void {
    const entry = this.find(ticket);
    if (entry) entry.state = state;
  }

  private remove(ticket: RoutingTicket): Entry | undefined {
    const entry = ticket as unknown as Entry;
    for (const q of [this.promptOrSteer, this.followUp]) {
      const i = q.indexOf(entry);
      if (i !== -1) {
        q.splice(i, 1);
        return entry;
      }
    }
    return undefined;
  }

  private takeFirst(q: Entry[], pred: (e: Entry) => boolean): Entry | undefined {
    const i = q.findIndex(pred);
    return i === -1 ? undefined : q.splice(i, 1)[0];
  }
}

function trimQueue(q: Entry[], piLength: number): Entry[] {
  const inPi = q.filter((e) => e.state === 'queued' || e.state === 'relayed');
  const keep = new Set(inPi.slice(Math.max(0, inPi.length - piLength)));
  return q.filter((e) => e.state === 'pending' || keep.has(e));
}
