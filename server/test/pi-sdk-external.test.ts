import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness, type Harness, type TestClient } from './harness.js';
import { makeSeparatePiInstall } from './separate-pi-install.ts';
import { findPiPackageFrom, readPiPackage } from '../src/pi-sdk-policy.ts';

// The server can run its sessions on a pi SDK it did NOT bundle (`piSdk.source`
// in config.json, here `WHEREVER_PI_SDK`), gated by the version policy, and
// falls back to the bundled SDK when that install is refused. The `connected`
// message reports the version it runs on, which is how these tests (and the
// web UI) tell which SDK was chosen.
//
// The "other install" is built offline from the bundled SDK (a real copy with
// its own module URLs, see separate-pi-install.ts) with a rewritten version,
// so the version policy can be driven without network installs.

const bundledVersion = readPiPackage(findPiPackageFrom(fileURLToPath(import.meta.url))!)!.version;

let root: string;
let tested: string; // a tested version (1.4.x) that is not the bundled one
let untested: string; // below the tested range, above the floor

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-pi-sdk-external-'));
  tested = makeSeparatePiInstall(path.join(root, 'tested'), { version: '1.4.99' });
  untested = makeSeparatePiInstall(path.join(root, 'untested'), { version: '1.3.0' });
}, 60_000);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** Connect, and return the `connected` message plus a session that completed a tool-call round trip. */
async function roundTrip(env: Record<string, string>): Promise<{ piVersion: unknown; c: TestClient }> {
  // The model calls the server's own `say` tool (schema built with the server's
  // typebox, executed by the chosen SDK), then answers.
  // Every piSdk variable explicitly, so the ambient env of a CI job that runs
  // the whole suite on another SDK (WHEREVER_PI_SDK...) cannot leak in.
  const isolated = { WHEREVER_PI_SDK: '', WHEREVER_PI_SDK_ACCEPT: '', WHEREVER_PI_SDK_ALLOW_UNTESTED: '', ...env };
  h = await startHarness({ initial: { kind: 'tool-call', toolName: 'say', input: { text: 'spoken' } }, env: isolated });
  const c = await h.connect();
  const connected = await c.waitForType('connected');
  c.send({ type: 'session_new', cwd: c.workspace });
  const created = await c.waitForType('session_created');
  c.send({ type: 'message', message: 'hi', sessionId: created.sessionId });
  await c.waitForType('tool_end');
  h.setNext({ kind: 'reply', text: 'after say' });
  const end = await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant' && m.content === 'after say');
  expect(end.content).toBe('after say');
  return { piVersion: connected.piVersion, c };
}

describe('running on a separately installed pi SDK', () => {
  it('reports the bundled SDK by default', async () => {
    const { piVersion } = await roundTrip({});
    expect(piVersion).toBe(bundledVersion);
  }, 60_000);

  it('uses an install in the tested range, and sessions run on it', async () => {
    const { piVersion } = await roundTrip({ WHEREVER_PI_SDK: tested });
    expect(piVersion).toBe('1.4.99');
  }, 60_000);

  it('refuses an untested install by default and falls back to the bundled SDK (the server still works)', async () => {
    const { piVersion } = await roundTrip({ WHEREVER_PI_SDK: untested });
    expect(piVersion).toBe(bundledVersion);
  }, 60_000);

  it('uses an untested install when the user opts in', async () => {
    const { piVersion } = await roundTrip({ WHEREVER_PI_SDK: untested, WHEREVER_PI_SDK_ALLOW_UNTESTED: '1' });
    expect(piVersion).toBe('1.3.0');
  }, 60_000);

  it('a missing install falls back to the bundled SDK', async () => {
    const { piVersion } = await roundTrip({ WHEREVER_PI_SDK: path.join(root, 'does-not-exist') });
    expect(piVersion).toBe(bundledVersion);
  }, 60_000);
});
