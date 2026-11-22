/**
 * shipmates' host in a terminal pi bridged to a wherever server (shipmates D26,
 * ADR 0008; wherever ADR 0024). @shipmates/pi's `session_spawn` and
 * `session_stop` use the most recently registered host of the process; with
 * this one, a terminal session's spawn becomes a SIDEBAR session on the
 * server (not a zellij pane or a headless `pi -p`), and a stop of a session
 * the server runs aborts it there.
 *
 * Registered only while the bridge is connected to a server that says it can
 * (`shipmates_host_info`), and removed on disconnect, so shipmates falls back to
 * its terminal default (D19) exactly when no server can carry the spawn.
 */

import type { BridgeRequestResult } from "./bridge-requests.js";

/**
 * shipmates' registry key and shape (`{version: 1, entries: [{host}]}` on
 * `globalThis[Symbol.for('shipmates.host')]`, shipmates ADR 0008): a contract
 * between packages, written here because the bridge does not depend on shipmates.
 */
export const SHIPMATES_HOST_REGISTRY_KEY = Symbol.for("shipmates.host");

type Host = Record<string, unknown>;

export function registerShipmatesHost(host: Host): () => void {
  const g = globalThis as unknown as Record<symbol, { version: 1; entries: { host: Host }[] } | undefined>;
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

/** How long a spawn may take on the server (it builds an agent, possibly a fork). */
export const SHIPMATES_SPAWN_TIMEOUT_MS = 60_000;

type Request = (op: string, args?: unknown, opts?: { timeoutMs?: number }) => Promise<BridgeRequestResult>;

/**
 * The host the bridge registers. `spawn` asks the server (`shipmates_spawn`,
 * whose owner must be this session) and rejects with its error; `stop` asks
 * `shipmates_stop` and answers `not-mine` on any failure, so shipmates falls back
 * to a stop request the target's own extension acts on (D30).
 */
export function createBridgeShipmatesHost(request: Request) {
  return {
    async spawn(req: { owner: string; [k: string]: unknown }): Promise<{ sessionFile: string }> {
      const res = await request("shipmates_spawn", req, { timeoutMs: SHIPMATES_SPAWN_TIMEOUT_MS });
      if (!res.ok) throw new Error(`wherever could not spawn the session: ${res.error}`);
      const file = (res.result as { sessionFile?: unknown } | null)?.sessionFile;
      if (typeof file !== "string" || !file) throw new Error("wherever answered the spawn without a session file");
      return { sessionFile: file };
    },
    async stop(sessionFile: string, opts: { by: string | null }): Promise<"stopped" | "not-running" | "not-mine"> {
      const res = await request("shipmates_stop", { sessionFile, by: opts.by });
      const outcome = res.ok ? (res.result as { outcome?: unknown } | null)?.outcome : undefined;
      return outcome === "stopped" || outcome === "not-running" ? outcome : "not-mine";
    },
  };
}

/**
 * Keeps the bridge's host registered exactly while the connected server can
 * carry it. `connected()` after every register (asks `shipmates_host_info`; an
 * older server answers an unknown op, which leaves it unregistered),
 * `disconnected()` on every loss of the socket and at session shutdown.
 */
export class BridgeShipmatesHostRegistration {
  private off: (() => void) | null = null;
  private generation = 0;

  constructor(private readonly request: Request) {}

  get registered(): boolean {
    return this.off !== null;
  }

  async connected(): Promise<void> {
    const gen = ++this.generation;
    const res = await this.request("shipmates_host_info");
    if (gen !== this.generation) return; // a disconnect or a newer register came first
    const available = res.ok && (res.result as { available?: unknown } | null)?.available === true;
    if (available && !this.off) this.off = registerShipmatesHost(createBridgeShipmatesHost(this.request));
    if (!available) this.disconnected();
  }

  disconnected(): void {
    this.generation++;
    this.off?.();
    this.off = null;
  }
}
