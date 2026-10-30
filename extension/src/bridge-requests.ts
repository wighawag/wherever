/**
 * The CLI bridge's REQUEST/RESPONSE path and the `assistant_info` cache built on
 * it (ADR 0016, spec `assistant-session-and-channels`).
 *
 * Until ADR 0016 the bridge only carried fire-and-forget frames. A tool that acts
 * on server state (the `assistant_*` twins, `cli-assistant-tool-twins`) must CALL
 * the server and wait, so the extension sends `cli_request {id, op, args}` and the
 * server answers `cli_response {id, ok, result | error}`. Correlation is by id
 * only. The server resolves the calling session from the bridge registration, so
 * nothing about the caller is sent (origin is stamped server-side, never trusted
 * from here).
 *
 * An OLD server has no `cli_request` case and its WS switch has no default, so
 * the frame is silently dropped: a TIMEOUT is the only way to detect it. Every
 * timer is `unref`'d, so a pending request never keeps `pi -p` alive.
 *
 * `request()` never rejects and never waits on a socket that is not there: a
 * disconnected or disabled bridge answers at once with a clear error.
 *
 * Kept free of pi and `ws` imports so it can be tested against a fake socket.
 */

import { randomUUID } from "node:crypto";

/**
 * What this extension tells the server it supports, on every `cli_register`.
 * `agent_settled`: it forwards pi's `agent_settled` (so the server need not fall
 * back to `agent_end`, ADR 0016); `cli_request`: it speaks the request path.
 */
export const BRIDGE_CAPABILITIES: readonly string[] = ["agent_settled", "cli_request"];

/**
 * Default request timeout. Long enough for a busy server on a slow link, short
 * enough that an old server is recognised within a turn. Timers are unref'd, so
 * it never delays process exit.
 */
export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 10_000;

/** The slice of the bridge socket the request client needs (the test seam). */
export interface BridgeTransport {
  isConnected(): boolean;
  /** True only when the frame was handed to an OPEN socket. */
  send(frame: object): boolean;
}

/** Why a request failed: no socket, bridge turned off, no answer in time, or the server said no. */
export type BridgeFailureReason = "disconnected" | "disabled" | "timeout" | "server";

export type BridgeRequestResult =
  | { ok: true; result: unknown }
  | { ok: false; reason: BridgeFailureReason; error: string };

export interface BridgeRequestClientOptions {
  /** The current socket, or null when there is none (re-read on every request). */
  transport: () => BridgeTransport | null;
  /** False when the bridge is turned off (`remote.bridge: false`). Defaults to enabled. */
  enabled?: () => boolean;
  timeoutMs?: number;
  newId?: () => string;
}

interface Pending {
  resolve: (r: BridgeRequestResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeRequestClient {
  private readonly transport: () => BridgeTransport | null;
  private readonly enabled: () => boolean;
  private readonly timeoutMs: number;
  private readonly newId: () => string;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: BridgeRequestClientOptions) {
    this.transport = opts.transport;
    this.enabled = opts.enabled ?? (() => true);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS;
    this.newId = opts.newId ?? (() => randomUUID());
  }

  /** Call `op` on the server. Never rejects. */
  request(op: string, args?: unknown, opts?: { timeoutMs?: number }): Promise<BridgeRequestResult> {
    if (!this.enabled()) {
      return Promise.resolve({
        ok: false,
        reason: "disabled",
        error: "The wherever bridge is disabled (remote.bridge is false in the wherever config).",
      });
    }
    const socket = this.transport();
    if (!socket || !socket.isConnected()) {
      return Promise.resolve(disconnectedResult());
    }
    const id = this.newId();
    const frame: Record<string, unknown> = { type: "cli_request", id, op };
    if (args !== undefined) frame.args = args;
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    return new Promise<BridgeRequestResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        resolve({
          ok: false,
          reason: "timeout",
          error:
            `The wherever server did not answer "${op}" within ${Math.round(timeoutMs / 1000)}s ` +
            "(it may be an older server without this feature).",
        });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      let sent = false;
      try {
        sent = socket.send(frame);
      } catch {
        sent = false;
      }
      if (!sent) this.settle(id, disconnectedResult());
    });
  }

  /** Feed an inbound frame; true when it was the answer to a pending request. */
  handleResponse(msg: unknown): boolean {
    const m = msg as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown } | null;
    if (!m || m.type !== "cli_response" || typeof m.id !== "string") return false;
    if (m.ok === true) return this.settle(m.id, { ok: true, result: m.result });
    const error = typeof m.error === "string" && m.error ? m.error : "The wherever server refused the request.";
    return this.settle(m.id, { ok: false, reason: "server", error });
  }

  /** The socket dropped: no answer can arrive for what is pending. */
  failAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, disconnectedResult());
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private settle(id: string, result: BridgeRequestResult): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(result);
    return true;
  }
}

function disconnectedResult(): BridgeRequestResult {
  return { ok: false, reason: "disconnected", error: "Not connected to the wherever server." };
}

/**
 * The cached answer to `assistant_info`. Negative answers are cached too, so a
 * caller (the tool twins, the timezone line) never waits on the network:
 *  - `configured`: the server's assistant is active in `assistantFolder`;
 *  - `not_configured`: the server answered, and has no active assistant;
 *  - `unsupported`: the request timed out (an older server drops `cli_request`);
 *  - `disconnected`: no server has answered yet (no bridge connection so far);
 *  - `disabled`: the bridge is turned off.
 * A disconnect AFTER a server answer keeps that answer: an active tool then fails
 * at call time with "not connected" (ADR 0016) instead of vanishing mid-session.
 */
export type AssistantInfo =
  | { state: "configured"; assistantFolder: string; timezone: string | null }
  | { state: "not_configured" }
  | { state: "unsupported" }
  | { state: "disconnected" }
  | { state: "disabled" };

/** The server's `assistant_info` result, and the `assistant_info_changed` push body. */
interface AssistantInfoWire {
  assistantFolder?: unknown;
  timezone?: unknown;
}

function fromWire(w: AssistantInfoWire | null | undefined): AssistantInfo {
  const folder = w && typeof w.assistantFolder === "string" && w.assistantFolder ? w.assistantFolder : null;
  if (!folder) return { state: "not_configured" };
  const timezone = typeof w!.timezone === "string" && w!.timezone ? w!.timezone : null;
  return { state: "configured", assistantFolder: folder, timezone };
}

const isServerAnswer = (i: AssistantInfo) =>
  i.state === "configured" || i.state === "not_configured" || i.state === "unsupported";

export class AssistantInfoCache {
  private info: AssistantInfo = { state: "disconnected" };
  private listeners = new Set<(info: AssistantInfo) => void>();
  /** Bumped by every push, so a refresh that started before it never overwrites it. */
  private generation = 0;

  get(): AssistantInfo {
    return this.info;
  }

  /** Called on every change (the tool twins activate/deactivate on it). Returns the unsubscribe. */
  subscribe(listener: (info: AssistantInfo) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Ask the server (once per register). Never rejects; resolves with the cached value. */
  async refresh(client: BridgeRequestClient): Promise<AssistantInfo> {
    const gen = this.generation;
    const res = await client.request("assistant_info");
    if (gen !== this.generation) return this.info;
    if (res.ok) {
      this.set(fromWire(res.result as AssistantInfoWire));
    } else if (res.reason === "timeout" || res.reason === "server") {
      this.set({ state: "unsupported" });
    } else if (res.reason === "disabled") {
      this.set({ state: "disabled" });
    } else if (!isServerAnswer(this.info)) {
      this.set({ state: "disconnected" });
    }
    return this.info;
  }

  /** A server `assistant_info_changed` push. */
  applyPush(msg: AssistantInfoWire): void {
    this.generation++;
    this.set(fromWire(msg));
  }

  /** The bridge is turned off for this session. */
  setDisabled(): void {
    this.generation++;
    this.set({ state: "disabled" });
  }

  private set(next: AssistantInfo): void {
    if (JSON.stringify(next) === JSON.stringify(this.info)) return;
    this.info = next;
    for (const l of [...this.listeners]) {
      try {
        l(next);
      } catch {
        // A listener failure never breaks the bridge.
      }
    }
  }
}

/**
 * True when the session context has NO messages, the check pi's own SDK uses for
 * "is this a new session" (`buildSessionContext().messages.length === 0`). Not an
 * entry count: pi writes `model_change` / `thinking_level_change` entries into
 * every new session. Unknown surface or a throw answers false: wrongly claiming a
 * session is new would move the assistant pointer, the riskier mistake.
 */
export function sessionHasNoMessages(sessionManager: unknown): boolean {
  const sm = sessionManager as {
    buildSessionContext?: () => { messages?: unknown[] };
    buildSessionProjection?: () => { messages?: unknown[] };
  } | null;
  if (!sm) return false;
  try {
    const ctx =
      typeof sm.buildSessionContext === "function"
        ? sm.buildSessionContext()
        : typeof sm.buildSessionProjection === "function"
          ? sm.buildSessionProjection()
          : null;
    return !!ctx && Array.isArray(ctx.messages) && ctx.messages.length === 0;
  } catch {
    return false;
  }
}
