// The bridge registration details and event forwarding the assistant needs
// (ADR 0016), against the REAL extension code and a real WebSocket: a throwaway
// WS server stands in for wherever, and a temp WHEREVER_CONFIG_DIR points the
// bridge at it.
//
//  - `cli_register` carries `capabilities` and `isNew` (true only when the
//    session context had no messages at session_start, and only on the FIRST
//    register after it: a reconnect never repeats it);
//  - `agent_settled` is forwarded as a `cli_event` (it used to only beep);
//  - after register the extension asks `assistant_info` once (`cli_request`);
//  - an OLD server that drops `cli_request` does not break anything.
//
// Run with `pnpm test`. Needs a built `@wherever-dev/client`.

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import bridge from "../src/index.ts";

type Frame = { type?: string; [k: string]: any };

let root: string;
let wss: WebSocketServer;
let received: Frame[] = [];
let sockets: WebSocket[] = [];
/** How the fake server answers a cli_request; null = an OLD server (drops it). */
let answer: ((req: Frame) => Frame) | null = null;
const savedConfigDir = process.env.WHEREVER_CONFIG_DIR;
const realWherever = path.join(os.homedir(), ".wherever");
const realPi = path.join(os.homedir(), ".pi");
const fingerprint = (dir: string) => {
  try {
    return `${fs.statSync(dir).mtimeMs}|${fs.readdirSync(dir).sort().join(",")}`;
  } catch {
    return "<absent>";
  }
};
let realBefore: string[];

before(async () => {
  realBefore = [fingerprint(realWherever), fingerprint(realPi)];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wherever-bridge-register-"));
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (data) => {
      let msg: Frame;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      received.push(msg);
      if (msg.type === "cli_request" && answer) ws.send(JSON.stringify(answer(msg)));
    });
  });
  const { port } = wss.address() as AddressInfo;
  const configDir = path.join(root, "wherever-config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ remote: { host: "127.0.0.1", port, insecure: true, token: "test-token" } }),
  );
  process.env.WHEREVER_CONFIG_DIR = configDir;
});

after(async () => {
  if (savedConfigDir === undefined) delete process.env.WHEREVER_CONFIG_DIR;
  else process.env.WHEREVER_CONFIG_DIR = savedConfigDir;
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual([fingerprint(realWherever), fingerprint(realPi)], realBefore, "real ~/.wherever or ~/.pi was touched");
});

afterEach(() => {
  received = [];
  sockets = [];
  answer = null;
});

type Handler = (event: unknown, ctx: unknown) => unknown;

async function loadBridge() {
  const handlers = new Map<string, Handler[]>();
  const flags = new Map<string, unknown>();
  const pi = {
    registerFlag(name: string, opts: { default?: unknown }) {
      if (opts && "default" in opts) flags.set(name, opts.default);
    },
    getFlag: (name: string) => flags.get(name),
    registerCommand() {},
    registerTool() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendUserMessage() {},
    setModel: async () => true,
  };
  await (bridge as (api: unknown) => Promise<void>)(pi);
  const emit = async (event: string, payload: unknown, ctx?: unknown) => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return { emit };
}

/** A context whose session has `messages` context messages (pi's SessionManager shape). */
function fakeCtx(sessionFile: string, messages: unknown[]) {
  return {
    cwd: root,
    hasUI: false,
    model: undefined,
    isIdle: () => true,
    getContextUsage: () => undefined,
    modelRegistry: { find: () => undefined },
    ui: { setWidget() {}, notify() {}, setStatus() {} },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "test-session",
      // A fresh pi session has model/thinking entries but no messages.
      getEntries: () => [{ type: "model_change", id: "a", parentId: null }],
      getLeafId: () => "a",
      buildSessionContext: () => ({ messages }),
    },
  };
}

async function until(cond: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}
const registers = () => received.filter((m) => m.type === "cli_register");

test("a fresh session registers isNew once with its capabilities; a reconnect does not repeat isNew", async () => {
  answer = (req) => ({ type: "cli_response", id: req.id, ok: true, result: { assistantFolder: null } });
  const { emit } = await loadBridge();
  const sessionFile = path.join(root, "fresh.jsonl");
  await emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(sessionFile, []));
  try {
    await until(() => registers().length >= 1, 5_000);
    const first = registers()[0];
    assert.equal(first.sessionFile, sessionFile);
    assert.equal(first.isNew, true);
    assert.ok(first.capabilities.includes("agent_settled"));
    assert.ok(first.capabilities.includes("cli_request"));

    // The assistant_info fetch follows the register.
    await until(() => received.some((m) => m.type === "cli_request"), 5_000);
    const reqs = received.filter((m) => m.type === "cli_request");
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].op, "assistant_info");
    assert.equal(typeof reqs[0].id, "string");
    assert.ok(received.indexOf(reqs[0]) > received.indexOf(first), "assistant_info was asked before cli_register");

    // The server drops the connection; the bridge reconnects and registers again.
    for (const ws of sockets) ws.terminate();
    await until(() => registers().length >= 2, 10_000);
    const second = registers()[1];
    assert.equal(second.isNew, false, "a reconnect repeated isNew");
    assert.ok(second.capabilities.includes("cli_request"));
    await until(() => received.filter((m) => m.type === "cli_request").length >= 2, 5_000);
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

test("a resumed session (pi -c) registers isNew false", async () => {
  const { emit } = await loadBridge();
  const sessionFile = path.join(root, "resumed.jsonl");
  await emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    fakeCtx(sessionFile, [{ role: "user", content: "hi" }]),
  );
  try {
    await until(() => registers().length >= 1, 5_000);
    assert.equal(registers()[0].isNew, false);
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

test("agent_settled is forwarded as a cli_event; an old server (drops cli_request) keeps working", async () => {
  answer = null; // an OLD server: never answers cli_request
  const { emit } = await loadBridge();
  const sessionFile = path.join(root, "settle.jsonl");
  await emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(sessionFile, []));
  try {
    await until(() => registers().length >= 1, 5_000);
    await emit("agent_start", { type: "agent_start" });
    await emit("agent_end", { type: "agent_end", messages: [] });
    await emit("agent_settled", { type: "agent_settled", aborted: false });
    await until(() => received.some((m) => m.type === "cli_event" && m.event?.type === "agent_settled"), 5_000);
    const events = received.filter((m) => m.type === "cli_event").map((m) => m.event.type);
    // The existing frames are unchanged, in order, with agent_settled after agent_end.
    assert.deepEqual(
      events.filter((t) => t !== "context_usage"),
      ["agent_start", "agent_end", "agent_settled"],
    );
    const settled = received.find((m) => m.type === "cli_event" && m.event?.type === "agent_settled")!;
    assert.deepEqual(settled.event, { type: "agent_settled", aborted: false });
    assert.equal(settled.sessionFile, sessionFile);
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

test("a disabled bridge sends nothing at all", async () => {
  const configDir = process.env.WHEREVER_CONFIG_DIR!;
  const cfgPath = path.join(configDir, "config.json");
  const saved = fs.readFileSync(cfgPath, "utf8");
  const cfg = JSON.parse(saved);
  fs.writeFileSync(cfgPath, JSON.stringify({ remote: { ...cfg.remote, bridge: false } }));
  try {
    const { emit } = await loadBridge();
    await emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "off.jsonl"), []));
    await emit("agent_settled", { type: "agent_settled", aborted: false });
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(received, []);
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    fs.writeFileSync(cfgPath, saved);
  }
});
