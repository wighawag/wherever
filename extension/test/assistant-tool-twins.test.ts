// The CLI-bridge twins of the five `assistant_*` tools and the CLI timezone line
// (ADR 0016), against a FAKE request function and a fake active-tools API (no
// WebSocket, no pi). The real-bridge behaviour is in assistant-tool-twins-bridge.test.ts;
// the text drift guard against the server is server/test/assistant-tool-twins.test.ts.
//
// Run with `pnpm test` (node's test runner through tsx).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSISTANT_TOOL_TWIN_NAMES,
  ASSISTANT_TWIN_REQUEST_TIMEOUT_MS,
  cliTimezoneLine,
  createAssistantToolTwins,
  syncTwinActivation,
  type TwinRequest,
} from "../src/assistant-tool-twins.ts";
import { BridgeRequestClient, type AssistantInfo, type BridgeRequestResult } from "../src/bridge-requests.ts";

const FIVE = [
  "assistant_schedule_add",
  "assistant_schedule_list",
  "assistant_schedule_remove",
  "assistant_set_timezone",
  "assistant_notify",
];

type Twin = {
  name: string;
  defaultActive?: boolean;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: unknown; isError?: boolean }>;
};

function twinsWith(answer: (op: string, args: unknown) => BridgeRequestResult) {
  const calls: Array<{ op: string; args: unknown; timeoutMs?: number }> = [];
  const request: TwinRequest = async (op, args, opts) => {
    calls.push({ op, args, timeoutMs: opts?.timeoutMs });
    return answer(op, args);
  };
  const twins = createAssistantToolTwins(request) as unknown as Twin[];
  const byName = (n: string) => twins.find((t) => t.name === n)!;
  return { twins, byName, calls };
}

test("the five twins are registered INACTIVE, with their prompt text", () => {
  const { twins } = twinsWith(() => ({ ok: true, result: null }));
  assert.deepEqual(twins.map((t) => t.name), FIVE);
  assert.deepEqual([...ASSISTANT_TOOL_TWIN_NAMES], FIVE);
  for (const t of twins) {
    assert.equal(t.defaultActive, false, t.name);
    assert.ok(t.promptSnippet && t.promptGuidelines && t.promptGuidelines.length > 0, t.name);
  }
});

test("each twin calls its op with the tool params and returns the server's result", async () => {
  const { byName, calls } = twinsWith((op) => ({ ok: true, result: { text: `did ${op}`, details: { op } } }));
  const ops: Record<string, string> = {
    assistant_schedule_add: "schedule_add",
    assistant_schedule_list: "schedule_list",
    assistant_schedule_remove: "schedule_remove",
    assistant_set_timezone: "set_timezone",
    assistant_notify: "notify",
  };
  for (const name of FIVE) {
    const params = { probe: name };
    const res = await byName(name).execute("call-1", params);
    assert.equal(res.isError, undefined, name);
    assert.equal(res.content[0]!.text, `did ${ops[name]}`);
    assert.deepEqual(res.details, { op: ops[name] });
    assert.deepEqual(calls.at(-1), { op: ops[name], args: params, timeoutMs: ASSISTANT_TWIN_REQUEST_TIMEOUT_MS });
  }
});

test("a server error (not configured, lock, bad input) is a clear isError result", async () => {
  const { byName } = twinsWith(() => ({
    ok: false,
    reason: "server",
    error: "the wherever assistant is not configured on this server (set assistantFolder in the wherever config and restart it)",
  }));
  const res = await byName("assistant_schedule_add").execute("c", { name: "x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /^assistant_schedule_add: the wherever assistant is not configured/);
});

test("disconnected, disabled and timeout (old server) bridges each give a clear isError result", async () => {
  let transport: { isConnected(): boolean; send(f: object): boolean } | null = null;
  let enabled = true;
  const client = new BridgeRequestClient({ transport: () => transport, enabled: () => enabled, timeoutMs: 30 });
  const twins = createAssistantToolTwins((op, args) => client.request(op, args, { timeoutMs: 30 })) as unknown as Twin[];
  const notify = twins.find((t) => t.name === "assistant_notify")!;

  // No socket at all.
  let res = await notify.execute("c", { title: "t", body: "b" });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /^assistant_notify: Not connected to the wherever server\..*reconnects/);

  // The bridge turned off.
  enabled = false;
  res = await notify.execute("c", { title: "t", body: "b" });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /disabled/);

  // An OLD server: the frame is accepted and never answered.
  enabled = true;
  transport = { isConnected: () => true, send: () => true };
  res = await notify.execute("c", { title: "t", body: "b" });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /did not answer "notify".*older server/);
});

/** A fake pi active-tools API. */
function fakePi(initial: string[]) {
  let active = [...initial];
  const sets: string[][] = [];
  return {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      sets.push([...names]);
      active = [...names];
    },
    active: () => active,
    sets,
  };
}

const configured: AssistantInfo = { state: "configured", assistantFolder: "/home/u/assistant", timezone: "Europe/Paris" };

test("activation follows the cache: configured adds the twins, anything else removes them; no call when unchanged", () => {
  const pi = fakePi(["read", "bash"]);
  for (const state of ["disconnected", "not_configured", "unsupported", "disabled"] as const) {
    assert.equal(syncTwinActivation(pi, { state }), false, state);
  }
  assert.deepEqual(pi.sets, [], "a not-configured session never touches the active tools");

  assert.equal(syncTwinActivation(pi, configured), true);
  assert.deepEqual(pi.active(), ["read", "bash", ...FIVE]);
  assert.equal(syncTwinActivation(pi, configured), false, "already active");

  assert.equal(syncTwinActivation(pi, { state: "not_configured" }), true);
  assert.deepEqual(pi.active(), ["read", "bash"]);
  assert.equal(pi.sets.length, 2);
});

test("a loadout restored with the twins active loses them unless configured", () => {
  const pi = fakePi(["read", "assistant_notify", "bash", "assistant_schedule_list"]);
  assert.equal(syncTwinActivation(pi, { state: "disconnected" }), true);
  assert.deepEqual(pi.active(), ["read", "bash"]);
});

test("activation tolerates a pi without (or with a throwing) active-tools API", () => {
  assert.equal(syncTwinActivation({}, configured), false);
  const throwing = {
    getActiveTools: () => {
      throw new Error("not bound yet");
    },
    setActiveTools: () => {},
  };
  assert.equal(syncTwinActivation(throwing, configured), false);
});

test("the CLI timezone line: only in the assistant folder or jobs/, only when configured with a zone", () => {
  assert.equal(cliTimezoneLine(configured, "/home/u/assistant"), "User's current timezone: Europe/Paris");
  assert.equal(cliTimezoneLine(configured, "/home/u/assistant/jobs"), "User's current timezone: Europe/Paris");
  assert.equal(cliTimezoneLine(configured, "/home/u/assistant/"), "User's current timezone: Europe/Paris");
  assert.equal(cliTimezoneLine(configured, "/home/u/assistant/notes"), null);
  assert.equal(cliTimezoneLine(configured, "/home/u/code"), null);
  assert.equal(cliTimezoneLine(configured, undefined), null);
  assert.equal(cliTimezoneLine({ ...configured, timezone: null }, "/home/u/assistant"), null);
  for (const state of ["disconnected", "not_configured", "unsupported", "disabled"] as const) {
    assert.equal(cliTimezoneLine({ state }, "/home/u/assistant"), null, state);
  }
});
