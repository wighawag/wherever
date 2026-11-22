// What a server `cli_message` hands to `pi.sendUserMessage` (task
// `pool-send-images`): the plain string without images, the text + image
// content array with them. The server side (the `images` key on `cli_message`)
// is server/test/pool-send-images.test.ts.
//
// Run with `pnpm test` (node's test runner through tsx).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cliHumanInputMark, cliMessageContent, KENNING_HUMAN_INPUT_EVENT } from "../src/cli-message.ts";

const PNG = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

test("without images the message string is sent exactly as before", () => {
  assert.equal(cliMessageContent({ message: "hello" }), "hello");
  assert.equal(cliMessageContent({ message: "hello", images: [] }), "hello");
  assert.equal(cliMessageContent({ message: "/skill:x go" }), "/skill:x go");
});

test("with images the text comes first, then each image", () => {
  assert.deepEqual(cliMessageContent({ message: "what is this?", images: [PNG, { ...PNG, mimeType: "image/jpeg" }] }), [
    { type: "text", text: "what is this?" },
    PNG,
    { ...PNG, mimeType: "image/jpeg" },
  ]);
});

test("malformed image entries are dropped (all malformed = the plain string)", () => {
  assert.equal(cliMessageContent({ message: "x", images: "nope" }), "x");
  assert.equal(cliMessageContent({ message: "x", images: [{ type: "image", data: "" , mimeType: "image/png" }, null, { type: "text", text: "t" }] }), "x");
  assert.deepEqual(cliMessageContent({ message: "x", images: [{ ...PNG, extra: 1 }, { type: "image", data: 5 }] }), [
    { type: "text", text: "x" },
    PNG,
  ]);
});

test("the kenning mark: only a human's send (web, Telegram), with the exact text", () => {
  assert.equal(KENNING_HUMAN_INPUT_EVENT, "kenning:human-input");
  assert.deepEqual(cliHumanInputMark({ message: "I approve", humanInput: { channel: "web" } }), { text: "I approve", channel: "web" });
  assert.deepEqual(cliHumanInputMark({ message: "/skill:x go", humanInput: { channel: "telegram" } }), { text: "/skill:x go", channel: "telegram" });
  // A scheduled job (no field), an older server, an unknown channel: nothing.
  assert.equal(cliHumanInputMark({ message: "[schedule:x] approve" }), null);
  assert.equal(cliHumanInputMark({ message: "x", humanInput: { channel: "schedule" } }), null);
  assert.equal(cliHumanInputMark({ message: "x", humanInput: null }), null);
  assert.equal(cliHumanInputMark({ message: "x", humanInput: "web" }), null);
});
