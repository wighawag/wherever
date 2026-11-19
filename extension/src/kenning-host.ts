/**
 * kenning's host in a terminal pi bridged to a wherever server (kenning D26,
 * ADR 0008; wherever ADR 0024). kenning-pi's `session_spawn` and
 * `session_stop` use the most recently registered host of the process; with
 * this one, a terminal session's spawn becomes a SIDEBAR session on the
 * server (not a zellij pane or a headless `pi -p`), and a stop of a session
 * the server runs aborts it there.
 *
 * Registered only while the bridge is connected to a server that says it can
 * (`kenning_host_info`), and removed on disconnect, so kenning falls back to
 * its terminal default (D19) exactly when no server can carry the spawn.
 */

import type { BridgeRequestResult } from "./bridge-requests.js";

/**
 * kenning's registry key and shape (`{version: 1, entries: [{host}]}` on
 * `globalThis[Symbol.for('kenning.host')]`, kenning ADR 0008): a contract
 * between packages, written here because the bridge does not depend on kenning.
 */
export const KENNING_HOST_REGISTRY_KEY = Symbol.for("kenning.host");

type Host = Record<string, unknown>;

export function registerKenningHost(host: Host): () => void {
  const g = globalThis as unknown as Record<symbol, { version: 1; entries: { host: Host }[] } | undefined>;
  let r = g[KENNING_HOST_REGISTRY_KEY];
  if (!r || !Array.isArray(r.entries)) r = g[KENNING_HOST_REGISTRY_KEY] = { version: 1, entries: [] };
  const entry = { host };
  r.entries.push(entry);
  return () => {
    const entries = g[KENNING_HOST_REGISTRY_KEY]?.entries;
    const i = entries ? entries.indexOf(entry) : -1;
    if (entries && i >= 0) entries.splice(i, 1);
  };
}

/** How long a spawn may take on the server (it builds an agent, possibly a fork). */
export const KENNING_SPAWN_TIMEOUT_MS = 60_000;

type Request = (op: string, args?: unknown, opts?: { timeoutMs?: number }) => Promise<BridgeRequestResult>;

/**
 * The host the bridge registers. `spawn` asks the server (`kenning_spawn`,
 * whose owner must be this session) and rejects with its error; `stop` asks
 * `kenning_stop` and answers `not-mine` on any failure, so kenning falls back
 * to a stop request the target's own extension acts on (D30).
 */
export function createBridgeKenningHost(request: Request) {
  return {
    async spawn(req: { owner: string; [k: string]: unknown }): Promise<{ sessionFile: string }> {
      const res = await request("kenning_spawn", req, { timeoutMs: KENNING_SPAWN_TIMEOUT_MS });
      if (!res.ok) throw new Error(`wherever could not spawn the session: ${res.error}`);
      const file = (res.result as { sessionFile?: unknown } | null)?.sessionFile;
      if (typeof file !== "string" || !file) throw new Error("wherever answered the spawn without a session file");
      return { sessionFile: file };
    },
    async stop(sessionFile: string, opts: { by: string | null }): Promise<"stopped" | "not-running" | "not-mine"> {
      const res = await request("kenning_stop", { sessionFile, by: opts.by });
      const outcome = res.ok ? (res.result as { outcome?: unknown } | null)?.outcome : undefined;
      return outcome === "stopped" || outcome === "not-running" ? outcome : "not-mine";
    },
  };
}

/**
 * Keeps the bridge's host registered exactly while the connected server can
 * carry it. `connected()` after every register (asks `kenning_host_info`; an
 * older server answers an unknown op, which leaves it unregistered),
 * `disconnected()` on every loss of the socket and at session shutdown.
 */
export class BridgeKenningHostRegistration {
  private off: (() => void) | null = null;
  private generation = 0;

  constructor(private readonly request: Request) {}

  get registered(): boolean {
    return this.off !== null;
  }

  async connected(): Promise<void> {
    const gen = ++this.generation;
    const res = await this.request("kenning_host_info");
    if (gen !== this.generation) return; // a disconnect or a newer register came first
    const available = res.ok && (res.result as { available?: unknown } | null)?.available === true;
    if (available && !this.off) this.off = registerKenningHost(createBridgeKenningHost(this.request));
    if (!available) this.disconnected();
  }

  disconnected(): void {
    this.generation++;
    this.off?.();
    this.off = null;
  }
}
