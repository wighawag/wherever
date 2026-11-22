// The bridge's kenning host (ADR 0024): registered on kenning's per-process
// registry (globalThis[Symbol.for('kenning.host')], kenning ADR 0008) exactly
// while the connected server says it can carry spawns, so a terminal
// session's `session_spawn` becomes a sidebar session on the server, and
// kenning falls back to its terminal default otherwise.
//
// Run with `pnpm test` (node's test runner through tsx).

import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeKenningHostRegistration, createBridgeKenningHost, KENNING_HOST_REGISTRY_KEY, registerKenningHost } from "../src/kenning-host.ts";

type Res = { ok: true; result: unknown } | { ok: false; reason: "disconnected" | "disabled" | "timeout" | "server"; error: string };
const current = () => {
  const r = (globalThis as any)[KENNING_HOST_REGISTRY_KEY] as { version: number; entries: { host: unknown }[] } | undefined;
  return r?.entries.at(-1)?.host;
};

test("the registry is kenning's shape; the latest wins and unregistering restores the previous one", () => {
  const a = {};
  const b = {};
  const offA = registerKenningHost(a);
  const offB = registerKenningHost(b);
  assert.equal((globalThis as any)[KENNING_HOST_REGISTRY_KEY].version, 1);
  assert.equal(current(), b);
  offA();
  assert.equal(current(), b);
  offB();
  assert.equal(current(), undefined);
});

test("registered only while the server says it can carry it; gone on disconnect", async () => {
  let available = true;
  const calls: string[] = [];
  const reg = new BridgeKenningHostRegistration(async (op): Promise<Res> => {
    calls.push(op);
    if (op === "kenning_host_info") return { ok: true, result: { available } };
    return { ok: false, reason: "server", error: "unexpected" };
  });
  await reg.connected();
  assert.equal(reg.registered, true);
  assert.ok(current());
  reg.disconnected();
  assert.equal(reg.registered, false);
  assert.equal(current(), undefined);

  available = false;
  await reg.connected();
  assert.equal(reg.registered, false);
});

test("an older server (unknown op) leaves kenning's terminal default in place", async () => {
  const reg = new BridgeKenningHostRegistration(async (): Promise<Res> => ({ ok: false, reason: "server", error: "Unknown cli_request op: kenning_host_info" }));
  await reg.connected();
  assert.equal(reg.registered, false);
  assert.equal(current(), undefined);
});

test("a disconnect while asking wins over the late answer", async () => {
  let answer!: (r: Res) => void;
  const reg = new BridgeKenningHostRegistration(() => new Promise<Res>((r) => (answer = r)));
  const p = reg.connected();
  reg.disconnected();
  answer({ ok: true, result: { available: true } });
  await p;
  assert.equal(reg.registered, false);
});

test("spawn and stop go to the server; a failed stop is not-mine so kenning falls back to a stop request", async () => {
  const seen: Array<[string, unknown, unknown]> = [];
  let stopRes: Res = { ok: true, result: { outcome: "stopped" } };
  const host = createBridgeKenningHost(async (op, args, opts): Promise<Res> => {
    seen.push([op, args, opts]);
    if (op === "kenning_spawn") return { ok: true, result: { sessionFile: "/s/child.jsonl" } };
    return stopRes;
  });
  const req = { spawnId: "sp_1", owner: "/s/owner.jsonl", folder: "/w", title: "t" };
  assert.deepEqual(await host.spawn(req), { sessionFile: "/s/child.jsonl" });
  assert.deepEqual(seen[0], ["kenning_spawn", req, { timeoutMs: 60_000 }]);
  assert.equal(await host.stop("/s/child.jsonl", { by: "/s/owner.jsonl" }), "stopped");
  stopRes = { ok: false, reason: "timeout", error: "no answer" };
  assert.equal(await host.stop("/s/child.jsonl", { by: "/s/owner.jsonl" }), "not-mine");

  const failing = createBridgeKenningHost(async (): Promise<Res> => ({ ok: false, reason: "server", error: "no such folder: /w" }));
  await assert.rejects(failing.spawn(req), /no such folder/);
});
