// The CLI bridge must not connect when it is running INSIDE a wherever server
// process. A server older than the server-side filter loads every extension in
// the user's settings, this one included, and an in-server bridge registers the
// server's own session as a CLI, which loops takeover/handback and aborts every
// turn. The server marks its process with a globalThis symbol (see
// server/src/server-process-marker.ts); this extension checks it.
//
// Real extension code, real WebSocket: a throwaway WS server stands in for
// wherever, and a temp WHEREVER_CONFIG_DIR points the bridge at it. The marker
// present: no connection. The marker absent: the bridge connects and sends
// cli_register, as it always did.
//
// Run with `pnpm test` (node's test runner through tsx). Needs a built
// `@wherever-dev/client` (its package main is dist/): `pnpm --filter ./client build`.

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import bridge from "../src/index.ts";
import { WHEREVER_SERVER_PROCESS_MARKER, isInsideWhereverServer } from "../src/server-process-marker.ts";

const MARKER_KEY = "wherever-dev.server-process";

let root: string;
let wss: WebSocketServer;
let received: Array<{ type?: string; sessionFile?: string }> = [];
let connections = 0;
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wherever-bridge-guard-"));
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  wss.on("connection", (ws) => {
    connections++;
    ws.on("message", (data) => {
      try {
        received.push(JSON.parse(String(data)));
      } catch {}
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
  delete (globalThis as Record<symbol, unknown>)[Symbol.for(MARKER_KEY)];
  received = [];
  connections = 0;
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Load the real extension against a minimal pi API and return its handlers. */
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
  const registered = () => [...handlers.values()].reduce((n, hs) => n + hs.length, 0);
  const emit = async (event: string, payload: unknown, ctx?: unknown) => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return { emit, registered };
}

function fakeCtx(sessionFile: string) {
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
      getEntries: () => [],
      getLeafId: () => null,
    },
  };
}

async function until(cond: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

test("the marker key is the one the server sets", () => {
  assert.equal(WHEREVER_SERVER_PROCESS_MARKER, Symbol.for(MARKER_KEY));
});

test("marker ABSENT (a terminal pi): session_start connects and registers the session", async () => {
  const { emit, registered } = await loadBridge();
  assert.ok(registered() > 0, "a terminal pi's bridge registered no handlers");
  const sessionFile = path.join(root, "absent.jsonl");
  await emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(sessionFile));
  try {
    await until(() => received.some((m) => m.type === "cli_register"), 5_000);
    assert.ok(connections >= 1, "the bridge never connected");
    assert.ok(
      received.some((m) => m.type === "cli_register" && m.sessionFile === sessionFile),
      "the bridge connected but never sent cli_register",
    );
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

test("marker PRESENT (inside a wherever server): session_start does not connect", async () => {
  (globalThis as Record<symbol, unknown>)[Symbol.for(MARKER_KEY)] = true;
  const { emit, registered } = await loadBridge();
  assert.equal(registered(), 0, "the bridge registered handlers inside the server");
  await emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "present.jsonl")));
  try {
    // Long enough for the absent case above to have connected many times over.
    await new Promise((r) => setTimeout(r, 750));
    assert.equal(connections, 0, "the bridge connected from inside the server");
    assert.deepEqual(received, []);
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

// A server OLDER than the marker never sets it, but its entry script is the
// `wherever` bin of the `wherever-dev` package. That is the signal for them.
test("an OLD server (no marker) is detected by its entry script's package", async () => {
  const savedArgv1 = process.argv[1];
  const serverPkg = path.join(root, "old-server", "node_modules", "wherever-dev");
  fs.mkdirSync(path.join(serverPkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(serverPkg, "package.json"), JSON.stringify({ name: "wherever-dev", version: "0.18.3" }));
  fs.writeFileSync(path.join(serverPkg, "dist", "index.js"), "");
  // A look-alike that only CONTAINS "wherever" is not the server.
  const lookAlike = path.join(root, "wherever-tools");
  fs.mkdirSync(lookAlike, { recursive: true });
  fs.writeFileSync(path.join(lookAlike, "package.json"), JSON.stringify({ name: "wherever-dev-tools" }));
  fs.writeFileSync(path.join(lookAlike, "cli.js"), "");
  try {
    process.argv[1] = path.join(serverPkg, "dist", "index.js");
    assert.equal(isInsideWhereverServer(), true);
    const { emit } = await loadBridge();
    await emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "old.jsonl")));
    await new Promise((r) => setTimeout(r, 750));
    assert.equal(connections, 0, "the bridge connected from inside an old server");
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    process.argv[1] = path.join(lookAlike, "cli.js");
    assert.equal(isInsideWhereverServer(), false);
    // The repo's own server entry (dev: tsx src/index.ts) counts too.
    process.argv[1] = path.resolve(import.meta.dirname, "..", "..", "server", "src", "index.ts");
    assert.equal(isInsideWhereverServer(), true);
  } finally {
    process.argv[1] = savedArgv1;
  }
  // A terminal pi (this test runner stands in for it) is not the server.
  assert.equal(isInsideWhereverServer(), false);
});

test("a marker set after load still stops session_start from connecting", async () => {
  const { emit } = await loadBridge();
  (globalThis as Record<symbol, unknown>)[Symbol.for(MARKER_KEY)] = true;
  await emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(path.join(root, "late.jsonl")));
  try {
    await new Promise((r) => setTimeout(r, 750));
    assert.equal(connections, 0, "the bridge connected after the marker was set");
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});
