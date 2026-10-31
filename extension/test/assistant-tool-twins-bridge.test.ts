// The `assistant_*` tool twins and the CLI timezone line against the REAL
// extension code and a real WebSocket (ADR 0016): a throwaway WS server stands in
// for wherever, a temp WHEREVER_CONFIG_DIR points the bridge at it, and a fake pi
// records the registered tools and the active-tool set.
//
//  - not configured, an old server, a disabled bridge or no server at all: the
//    active tools are never touched and before_agent_start changes nothing, so
//    the session's tools and system prompt are exactly as before;
//  - `assistant_info` configured (or a push saying so) activates the five twins;
//    a push saying not configured deactivates them;
//  - an active twin round-trips through `cli_request`;
//  - the timezone line is appended every turn in the assistant folder, from the
//    cache: a pushed change shows next turn with no request.
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

const FIVE = [
  "assistant_schedule_add",
  "assistant_schedule_list",
  "assistant_schedule_remove",
  "assistant_set_timezone",
  "assistant_notify",
];

let root: string;
let configDir: string;
let port: number;
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

function writeConfig(remote: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ remote: { host: "127.0.0.1", port, insecure: true, token: "test-token", ...remote } }),
  );
}

before(async () => {
  realBefore = [fingerprint(realWherever), fingerprint(realPi)];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wherever-tool-twins-"));
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
  port = (wss.address() as AddressInfo).port;
  configDir = path.join(root, "wherever-config");
  fs.mkdirSync(configDir, { recursive: true });
  writeConfig({});
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
  writeConfig({});
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; defaultActive?: boolean; execute: (id: string, params: unknown) => Promise<any> };

/** The extension against a fake pi whose active-tool set behaves like pi's (defaultActive honoured). */
async function loadBridge(initialActive: string[] = ["read", "bash", "edit", "write"]) {
  const handlers = new Map<string, Handler[]>();
  const flags = new Map<string, unknown>();
  const tools: Tool[] = [];
  let active = [...initialActive];
  const setCalls: string[][] = [];
  const pi = {
    registerFlag(name: string, opts: { default?: unknown }) {
      if (opts && "default" in opts) flags.set(name, opts.default);
    },
    getFlag: (name: string) => flags.get(name),
    registerCommand() {},
    registerTool(tool: Tool) {
      tools.push(tool);
      if (tool.defaultActive !== false) active.push(tool.name);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      setCalls.push([...names]);
      active = [...names];
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendUserMessage() {},
    setModel: async () => true,
  };
  await (bridge as (api: unknown) => Promise<void>)(pi);
  const activeAtLoad = [...active];
  const emit = async (event: string, payload: unknown, ctx?: unknown) => {
    let last: unknown;
    for (const h of handlers.get(event) ?? []) last = await h(payload, ctx);
    return last;
  };
  return { emit, tools, active: () => active, activeAtLoad, setCalls };
}

function fakeCtx(sessionFile: string, cwd: string) {
  return {
    cwd,
    hasUI: false,
    model: undefined,
    isIdle: () => true,
    getContextUsage: () => undefined,
    modelRegistry: { find: () => undefined },
    ui: { setWidget() {}, notify() {}, setStatus() {} },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "test-session",
      getEntries: () => [],
      getLeafId: () => null,
      buildSessionContext: () => ({ messages: [{ role: "user", content: "hi" }] }),
    },
  };
}

async function until(cond: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return cond();
}
const requests = () => received.filter((m) => m.type === "cli_request");
const pushToAll = (frame: Frame) => {
  for (const ws of sockets) ws.send(JSON.stringify(frame));
};

const PROMPT = "You are pi.";
const turn = (b: Awaited<ReturnType<typeof loadBridge>>, cwd: string) =>
  b.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: PROMPT }, { cwd });

/** What "today" is: the tools a session had without the twins, and an untouched prompt. */
async function assertUntouched(b: Awaited<ReturnType<typeof loadBridge>>, cwd: string) {
  assert.deepEqual(b.setCalls, [], "the active tools were changed");
  assert.deepEqual(b.active(), b.activeAtLoad);
  for (const name of FIVE) assert.ok(!b.active().includes(name), `${name} is active`);
  assert.equal(await turn(b, cwd), undefined, "before_agent_start changed the system prompt");
}

test("every twin is registered inactive; not configured leaves tools and prompt untouched", async () => {
  answer = (req) => ({ type: "cli_response", id: req.id, ok: true, result: { assistantFolder: null, timezone: null } });
  const b = await loadBridge();
  assert.deepEqual(
    b.tools.filter((t) => FIVE.includes(t.name)).map((t) => [t.name, t.defaultActive]),
    FIVE.map((n) => [n, false]),
  );
  const cwd = path.join(root, "assistant");
  await b.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "nc.jsonl"), cwd));
  try {
    assert.ok(await until(() => requests().length >= 1, 5_000));
    await new Promise((r) => setTimeout(r, 200));
    await assertUntouched(b, cwd);
  } finally {
    await b.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

test("an old server (drops cli_request), a disabled bridge and no server all leave tools and prompt untouched", async () => {
  const cwd = path.join(root, "assistant");

  answer = null; // old server
  let b = await loadBridge();
  await b.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "old.jsonl"), cwd));
  try {
    assert.ok(await until(() => requests().length >= 1, 5_000));
    await assertUntouched(b, cwd);
  } finally {
    await b.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }

  writeConfig({ bridge: false });
  b = await loadBridge();
  await b.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "off.jsonl"), cwd));
  await assertUntouched(b, cwd);
  await b.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

  // No wherever server reachable: a port nothing listens on.
  const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => probe.once("listening", () => resolve()));
  const deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  writeConfig({ port: deadPort });
  received = [];
  b = await loadBridge();
  await b.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "none.jsonl"), cwd));
  try {
    await new Promise((r) => setTimeout(r, 300));
    await assertUntouched(b, cwd);
  } finally {
    await b.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
  assert.deepEqual(received, [], "the bridge reached the stand-in server");
});

test("configured activates the twins; a not-configured push deactivates; a configured push re-activates", async () => {
  const folder = path.join(root, "assistant");
  answer = (req) => ({ type: "cli_response", id: req.id, ok: true, result: { assistantFolder: folder, timezone: "Europe/Paris" } });
  const b = await loadBridge();
  await b.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "on.jsonl"), folder));
  try {
    assert.ok(await until(() => FIVE.every((n) => b.active().includes(n)), 5_000), "the twins were not activated");
    assert.deepEqual(b.active(), [...b.activeAtLoad, ...FIVE]);

    pushToAll({ type: "assistant_info_changed", assistantFolder: null, timezone: null });
    assert.ok(await until(() => !b.active().some((n) => FIVE.includes(n)), 5_000), "the twins were not deactivated");
    assert.deepEqual(b.active(), b.activeAtLoad);

    pushToAll({ type: "assistant_info_changed", assistantFolder: folder, timezone: "Europe/Paris" });
    assert.ok(await until(() => FIVE.every((n) => b.active().includes(n)), 5_000));
  } finally {
    await b.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

test("an active twin round-trips through cli_request and returns the server's result", async () => {
  const folder = path.join(root, "assistant");
  answer = (req) =>
    req.op === "assistant_info"
      ? { type: "cli_response", id: req.id, ok: true, result: { assistantFolder: folder, timezone: "UTC" } }
      : req.op === "notify"
        ? { type: "cli_response", id: req.id, ok: false, error: "no channel could deliver the notification" }
        : { type: "cli_response", id: req.id, ok: true, result: { text: `Scheduled "${req.args.name}" (id j1).`, details: { id: "j1" } } };
  const b = await loadBridge();
  await b.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "rt.jsonl"), root));
  try {
    assert.ok(await until(() => b.active().includes("assistant_schedule_add"), 5_000));
    const add = b.tools.find((t) => t.name === "assistant_schedule_add")!;
    const res = await add.execute("call-1", { name: "ci", prompt: "check CI", mode: "isolated", at: "now" });
    assert.deepEqual(res, { content: [{ type: "text", text: 'Scheduled "ci" (id j1).' }], details: { id: "j1" } });
    const sent = requests().find((m) => m.op === "schedule_add")!;
    // Only the tool's params: the caller is resolved by the server from the registration.
    assert.deepEqual(sent.args, { name: "ci", prompt: "check CI", mode: "isolated", at: "now" });
    assert.deepEqual(Object.keys(sent).sort(), ["args", "id", "op", "type"]);

    const notify = b.tools.find((t) => t.name === "assistant_notify")!;
    const failed = await notify.execute("call-2", { title: "t", body: "b" });
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0].text, "assistant_notify: no channel could deliver the notification");

    // The bridge drops: an active twin fails at call time, and stays active.
    for (const ws of sockets) ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    const offline = await add.execute("call-3", { name: "x", prompt: "y", mode: "inline", at: "now" });
    assert.equal(offline.isError, true);
    assert.match(offline.content[0].text, /Not connected to the wherever server/);
    assert.ok(b.active().includes("assistant_schedule_add"));
  } finally {
    await b.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

test("the timezone line is appended every turn in the assistant folder; a pushed change shows next turn with no request", async () => {
  const folder = path.join(root, "assistant");
  answer = (req) => ({ type: "cli_response", id: req.id, ok: true, result: { assistantFolder: folder, timezone: "Europe/Paris" } });
  const b = await loadBridge();
  await b.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "tz.jsonl"), folder));
  try {
    assert.ok(await until(() => b.active().includes("assistant_notify"), 5_000));
    const paris = { systemPrompt: `${PROMPT}\n\nUser's current timezone: Europe/Paris` };
    assert.deepEqual(await turn(b, folder), paris);
    assert.deepEqual(await turn(b, folder), paris, "the line is not repeated on every turn");
    assert.deepEqual(await turn(b, path.join(folder, "jobs")), paris);
    // Outside the folder: nothing appended.
    assert.equal(await turn(b, root), undefined);
    assert.equal(await turn(b, path.join(folder, "notes")), undefined);

    const asked = requests().length;
    pushToAll({ type: "assistant_info_changed", assistantFolder: folder, timezone: "Asia/Tokyo" });
    const tokyo = { systemPrompt: `${PROMPT}\n\nUser's current timezone: Asia/Tokyo` };
    let next: unknown;
    const deadline = Date.now() + 5_000;
    do {
      next = await turn(b, folder);
      if (JSON.stringify(next) === JSON.stringify(tokyo)) break;
      await new Promise((r) => setTimeout(r, 20));
    } while (Date.now() < deadline);
    assert.deepEqual(next, tokyo);
    assert.equal(requests().length, asked, "a turn waited on (or made) a request");

    // A push saying not configured: the line goes away too.
    pushToAll({ type: "assistant_info_changed", assistantFolder: null, timezone: null });
    assert.ok(await until(() => !b.active().includes("assistant_notify"), 5_000));
    assert.equal(await turn(b, folder), undefined);
  } finally {
    await b.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});
