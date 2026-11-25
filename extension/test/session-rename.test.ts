// The bridge half of a wherever rename (wherever ADR 0027): the server sends
// `cli_rename {id, name}`, the extension writes the name with pi's
// `setSessionName` (this terminal owns the transcript) and answers
// `cli_rename_result {id, ok, error?}`. The server side is
// server/test/session-rename.test.ts.
//
// Run with `pnpm test` (node's test runner through tsx).

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCliRename } from "../src/session-rename.ts";
import { BRIDGE_CAPABILITIES } from "../src/bridge-requests.ts";

function fakes(opts: { throws?: Error } = {}) {
  const names: string[] = [];
  const sent: any[] = [];
  return {
    names,
    sent,
    deps: {
      setSessionName(name: string) {
        if (opts.throws) throw opts.throws;
        names.push(name);
      },
      send(frame: object) {
        sent.push(frame);
        return true;
      },
    },
  };
}

test("the capability is advertised on cli_register", () => {
  assert.ok(BRIDGE_CAPABILITIES.includes("cli_rename"));
});

test("cli_rename calls pi's setSessionName and answers ok with the same id", () => {
  const f = fakes();
  handleCliRename({ type: "cli_rename", id: "r1", name: "Release notes" }, f.deps);
  assert.deepEqual(f.names, ["Release notes"]);
  assert.deepEqual(f.sent, [{ type: "cli_rename_result", id: "r1", ok: true }]);
});

test("when setSessionName throws it answers ok:false with the error", () => {
  const f = fakes({ throws: new Error("session is read-only") });
  handleCliRename({ type: "cli_rename", id: "r2", name: "x" }, f.deps);
  assert.deepEqual(f.sent, [{ type: "cli_rename_result", id: "r2", ok: false, error: "session is read-only" }]);
});

test("an empty name is refused without touching pi; a frame without id is dropped", () => {
  const f = fakes();
  handleCliRename({ type: "cli_rename", id: "r3", name: "   " }, f.deps);
  assert.deepEqual(f.names, []);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].ok, false);
  handleCliRename({ type: "cli_rename", name: "no id" }, f.deps);
  assert.deepEqual(f.names, []);
  assert.equal(f.sent.length, 1);
});
