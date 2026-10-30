// The CLI bridge's request/response path (ADR 0016): `cli_request {id, op, args}`
// answered by `cli_response {id, ok, result | error}`, correlated by id, with a
// timeout (an OLD server silently drops the unknown frame, so a timeout is how it
// is detected), and the `assistant_info` cache built on it (negative answers
// cached too, `assistant_info_changed` pushes update it).
//
// Seam: the request client and the cache against a FAKE socket; no WebSocket,
// no pi. Run with `pnpm test` (node's test runner through tsx).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  AssistantInfoCache,
  BRIDGE_CAPABILITIES,
  BridgeRequestClient,
  sessionHasNoMessages,
  type BridgeTransport,
} from "../src/bridge-requests.ts";

/** A socket that records what is sent and lets the test answer. */
function fakeSocket(connected = true) {
  const sent: Array<{ type: string; id: string; op: string; args?: unknown }> = [];
  const transport: BridgeTransport & { connected: boolean } = {
    connected,
    isConnected() {
      return this.connected;
    },
    send(frame) {
      if (!this.connected) return false;
      sent.push(frame as any);
      return true;
    },
  };
  return { sent, transport };
}

const tick = () => new Promise((r) => setImmediate(r));

test("capabilities name the two new bridge features", () => {
  assert.ok(BRIDGE_CAPABILITIES.includes("agent_settled"));
  assert.ok(BRIDGE_CAPABILITIES.includes("cli_request"));
});

test("a request is sent with a unique id and resolved by its matching cli_response", async () => {
  const { sent, transport } = fakeSocket();
  const client = new BridgeRequestClient({ transport: () => transport, timeoutMs: 5_000 });
  const a = client.request("assistant_info");
  const b = client.request("other_op", { x: 1 });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "cli_request");
  assert.equal(sent[0].op, "assistant_info");
  assert.deepEqual(sent[1].args, { x: 1 });
  assert.notEqual(sent[0].id, sent[1].id);

  // Answered out of order: correlation is by id, never by position.
  assert.equal(client.handleResponse({ type: "cli_response", id: sent[1].id, ok: false, error: "unknown op: other_op" }), true);
  assert.equal(client.handleResponse({ type: "cli_response", id: sent[0].id, ok: true, result: { assistantFolder: "/a" } }), true);
  assert.deepEqual(await a, { ok: true, result: { assistantFolder: "/a" } });
  assert.deepEqual(await b, { ok: false, reason: "server", error: "unknown op: other_op" });
  assert.equal(client.pendingCount(), 0);

  // A stray or duplicate response is ignored, not thrown on.
  assert.equal(client.handleResponse({ type: "cli_response", id: sent[0].id, ok: true }), false);
  assert.equal(client.handleResponse({ type: "something_else" }), false);
});

test("an unanswered request times out with a clear error (an old server drops cli_request)", async () => {
  const { transport } = fakeSocket();
  const client = new BridgeRequestClient({ transport: () => transport, timeoutMs: 30 });
  const started = Date.now();
  const res = await client.request("assistant_info");
  assert.equal(res.ok, false);
  assert.equal((res as any).reason, "timeout");
  assert.match((res as any).error, /did not answer|older/i);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(client.pendingCount(), 0);
});

test("a disconnected or disabled bridge answers at once, without sending anything", async () => {
  const off = fakeSocket(false);
  const disconnected = new BridgeRequestClient({ transport: () => off.transport, timeoutMs: 60_000 });
  const r1 = await disconnected.request("assistant_info");
  assert.deepEqual({ ok: r1.ok, reason: (r1 as any).reason }, { ok: false, reason: "disconnected" });
  assert.equal(off.sent.length, 0);

  const none = new BridgeRequestClient({ transport: () => null, timeoutMs: 60_000 });
  assert.equal(((await none.request("assistant_info")) as any).reason, "disconnected");

  const on = fakeSocket(true);
  const disabled = new BridgeRequestClient({ transport: () => on.transport, enabled: () => false, timeoutMs: 60_000 });
  const r3 = await disabled.request("assistant_info");
  assert.equal((r3 as any).reason, "disabled");
  assert.match((r3 as any).error, /disabled/i);
  assert.equal(on.sent.length, 0);
});

test("a dropped connection fails every pending request as disconnected", async () => {
  const { transport } = fakeSocket();
  const client = new BridgeRequestClient({ transport: () => transport, timeoutMs: 60_000 });
  const p = client.request("assistant_info");
  client.failAll();
  const res = await p;
  assert.equal((res as any).reason, "disconnected");
  assert.equal(client.pendingCount(), 0);
});

test("the timeout timer never keeps the process alive (pi -p exit time unchanged)", () => {
  // A child process sends a request no server will ever answer, with a 60 s
  // timeout, and must still exit straight away: the timer is unref'd.
  const modulePath = path.resolve(import.meta.dirname, "..", "src", "bridge-requests.ts");
  const script = `
    import { BridgeRequestClient } from ${JSON.stringify(modulePath)};
    const transport = { isConnected: () => true, send: () => true };
    const client = new BridgeRequestClient({ transport: () => transport, timeoutMs: 60000 });
    client.request("assistant_info").then(() => console.log("resolved"));
  `;
  const started = Date.now();
  const tsx = path.resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsx");
  const out = spawnSync(tsx, ["--eval", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(Date.now() - started < 15_000, "the pending request kept the process alive");
  assert.doesNotMatch(out.stdout, /resolved/);
});

test("assistant_info: a configured answer is cached, with the folder", async () => {
  const { sent, transport } = fakeSocket();
  const client = new BridgeRequestClient({ transport: () => transport, timeoutMs: 5_000 });
  const cache = new AssistantInfoCache();
  assert.deepEqual(cache.get(), { state: "disconnected" });
  const seen: string[] = [];
  cache.subscribe((info) => seen.push(info.state));

  const p = cache.refresh(client);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, "assistant_info");
  client.handleResponse({ type: "cli_response", id: sent[0].id, ok: true, result: { assistantFolder: "/home/u/assistant" } });
  assert.deepEqual(await p, { state: "configured", assistantFolder: "/home/u/assistant", timezone: null });
  assert.deepEqual(cache.get(), { state: "configured", assistantFolder: "/home/u/assistant", timezone: null });
  assert.deepEqual(seen, ["configured"]);
});

test("assistant_info: 'not configured' is cached as a negative answer", async () => {
  const { sent, transport } = fakeSocket();
  const client = new BridgeRequestClient({ transport: () => transport, timeoutMs: 5_000 });
  const cache = new AssistantInfoCache();
  const p = cache.refresh(client);
  client.handleResponse({ type: "cli_response", id: sent[0].id, ok: true, result: { assistantFolder: null } });
  assert.deepEqual(await p, { state: "not_configured" });
  assert.deepEqual(cache.get(), { state: "not_configured" });
});

test("assistant_info: a timeout (old server) is cached as 'unsupported'", async () => {
  const { transport } = fakeSocket();
  const client = new BridgeRequestClient({ transport: () => transport, timeoutMs: 20 });
  const cache = new AssistantInfoCache();
  assert.deepEqual(await cache.refresh(client), { state: "unsupported" });
  assert.deepEqual(cache.get(), { state: "unsupported" });
});

test("assistant_info: disconnected and disabled bridges give cached negative answers", async () => {
  const cache = new AssistantInfoCache();
  const none = new BridgeRequestClient({ transport: () => null });
  assert.deepEqual(await cache.refresh(none), { state: "disconnected" });

  cache.setDisabled();
  assert.deepEqual(cache.get(), { state: "disabled" });
});

test("assistant_info: a disconnect after a server answer keeps that answer", async () => {
  const { sent, transport } = fakeSocket();
  const client = new BridgeRequestClient({ transport: () => transport, timeoutMs: 5_000 });
  const cache = new AssistantInfoCache();
  const p = cache.refresh(client);
  client.handleResponse({ type: "cli_response", id: sent[0].id, ok: true, result: { assistantFolder: "/a" } });
  await p;
  transport.connected = false;
  assert.deepEqual(await cache.refresh(client), { state: "configured", assistantFolder: "/a", timezone: null });
});

test("assistant_info_changed updates the cache, and wins over a refresh still in flight", async () => {
  const { sent, transport } = fakeSocket();
  const client = new BridgeRequestClient({ transport: () => transport, timeoutMs: 5_000 });
  const cache = new AssistantInfoCache();
  const seen: string[] = [];
  cache.subscribe((info) => seen.push(info.state));

  cache.applyPush({ type: "assistant_info_changed", assistantFolder: "/a", timezone: "Europe/Paris" });
  assert.deepEqual(cache.get(), { state: "configured", assistantFolder: "/a", timezone: "Europe/Paris" });

  // A refresh started BEFORE a push must not overwrite the newer pushed value.
  const p = cache.refresh(client);
  cache.applyPush({ type: "assistant_info_changed", assistantFolder: null, timezone: null });
  assert.deepEqual(cache.get(), { state: "not_configured" });
  client.handleResponse({ type: "cli_response", id: sent[0].id, ok: true, result: { assistantFolder: "/a" } });
  await p;
  await tick();
  assert.deepEqual(cache.get(), { state: "not_configured" });
  assert.deepEqual(seen, ["configured", "not_configured"]);
});

test("sessionHasNoMessages uses the session context, not the entry count", () => {
  // pi writes model_change / thinking_level_change entries into EVERY new
  // session, so a fresh session has entries but no context messages.
  const fresh = {
    getEntries: () => [{ type: "model_change" }, { type: "thinking_level_change" }],
    buildSessionContext: () => ({ messages: [] }),
  };
  assert.equal(sessionHasNoMessages(fresh), true);
  const resumed = { buildSessionContext: () => ({ messages: [{ role: "user" }] }) };
  assert.equal(sessionHasNoMessages(resumed), false);
  // The readonly surface pi hands extensions: buildSessionProjection.
  assert.equal(sessionHasNoMessages({ buildSessionProjection: () => ({ messages: [] }) }), true);
  // Unknown or throwing: never claims new (a pointer move is the riskier mistake).
  assert.equal(sessionHasNoMessages({}), false);
  assert.equal(
    sessionHasNoMessages({
      buildSessionContext: () => {
        throw new Error("boom");
      },
    }),
    false,
  );
});
