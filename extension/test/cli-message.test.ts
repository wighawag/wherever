// What a server `cli_message` hands to `pi.sendUserMessage` (task
// `pool-send-images`): the plain string without images, the text + image
// content array with them. The server side (the `images` key on `cli_message`)
// is server/test/pool-send-images.test.ts.
//
// Run with `pnpm test` (node's test runner through tsx).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cliMessageContent } from "../src/cli-message.ts";

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
