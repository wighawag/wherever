import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openShipmates, type Shipmates } from 'shipmates';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * shipmates' deliveries in the chat (server/src/shipmates-delivery.ts), end to end:
 * a REAL server with the REAL @shipmates/pi in its sessions (from the agent dir's
 * settings, as a user's install), against the fake LLM.
 *
 * - an idle session woken by a `session_tell` (@shipmates/pi `sendMessage(...,
 *   {triggerTurn: true})`, a `message_end` with role `custom`) shows it live as
 *   `shipmates_delivery` and in `message_history` as a `shipmates` message;
 * - a message arriving while the receiver runs comes back from @shipmates/pi's
 *   `agent_before_settle` as a boundary entry (`entry_appended`, no
 *   message_end), and shows live too;
 * - a spawned child's history starts with its owner's `spawn` message;
 * - a client that did not ask (`shipmates=1`) gets neither the frame nor the
 *   history message, and no delivery ever comes as a user message.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIPMATES_PI_DIR = fs.realpathSync(path.join(here, '..', 'node_modules', '@shipmates/pi'));
const CARDS = { shipmates: '1' };

let h: Harness;
let shipmates: Shipmates;

beforeAll(async () => {
  shipmates = openShipmates();
  h = await startHarness({ env: { SHIPMATES_POLL_MS: '100' } });
  const settings = path.join(h.agentDir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), extensions: [SHIPMATES_PI_DIR] }));
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
  shipmates?.close();
});

async function newSession(c: TestClient, dir: string): Promise<{ sessionId: string; sessionFile: string }> {
  fs.mkdirSync(dir, { recursive: true });
  c.send({ type: 'session_new', cwd: dir });
  const created = await c.waitForType('session_created', 30_000);
  const s = { sessionId: created.sessionId as string, sessionFile: created.sessionFile as string };
  // @shipmates/pi registered it (its presence), so a message can be addressed to it.
  await c.waitFor((m) => m.type === 'shipmates_update' && (m as any).presence.some((p: any) => p.sessionFile === s.sessionFile), 15_000);
  return s;
}

/** Let every session finish: the fake model serves them all in request order. */
async function quiet(ms = 1000): Promise<void> {
  for (let n = -1, since = Date.now(); Date.now() - since < ms; await new Promise((r) => setTimeout(r, 100))) {
    if (h.fake.requests().length !== n) {
      n = h.fake.requests().length;
      since = Date.now();
    }
  }
}

async function history(c: TestClient, sessionFile: string): Promise<any[]> {
  const before = c.messages.length;
  c.send({ type: 'session_load', sessionFile });
  const m = await c.waitFor((x) => x.type === 'message_history' && c.messages.indexOf(x) >= before, 20_000);
  return m.messages as any[];
}

describe("shipmates' deliveries in the chat", () => {
  it('a woken session shows the human-relayed message live and in history; an older client sees none of it', async () => {
    const webA = await h.connect(undefined, CARDS);
    const webB = await h.connect(undefined, CARDS);
    await webA.waitForType('shipmates_update');
    await webB.waitForType('shipmates_update');
    const a = await newSession(webA, path.join(h.workspace, 'relay-a'));
    const b = await newSession(webB, path.join(h.workspace, 'relay-b'));
    const old = await h.connect();
    await history(old, b.sessionFile);
    await quiet();

    h.fake.queue({
      kind: 'tool-call',
      toolName: 'session_tell',
      input: { target: b.sessionFile, text: 'The human wants the docs shipped.', origin: 'human-relayed', relayQuote: 'please ship the docs' },
    });
    webA.send({ type: 'message', sessionId: a.sessionId, message: 'please ship the docs today' });

    const live = (await webB.waitForType('shipmates_delivery', 20_000)) as any;
    expect(live.sessionId).toBe(b.sessionId);
    expect(live.shipmates.origins).toEqual(['human-relayed']);
    expect(live.shipmates.from).toHaveLength(1);
    expect(live.shipmates.ids).toHaveLength(1);
    expect(live.content).toContain('The human wants the docs shipped.');
    expect(live.content).toMatch(/origin: human-relayed · tell/);
    // The woken turn answered it.
    await webB.waitFor((m) => m.type === 'agent_end', 20_000);
    await quiet();

    // Never a user message, on any client.
    for (const c of [webB, old]) {
      expect(c.messages.some((m) => m.type === 'message_end' && (m as any).role === 'user' && String((m as any).content).includes('docs shipped'))).toBe(false);
    }
    expect(old.messages.some((m) => m.type === 'shipmates_delivery')).toBe(false);

    const shown = await history(webB, b.sessionFile);
    const card = shown.find((m) => m.role === 'shipmates');
    expect(card).toMatchObject({ shipmates: { ids: live.shipmates.ids, from: live.shipmates.from, origins: ['human-relayed'] } });
    expect(card.entryId).toBeUndefined();
    // It sits before the reply it caused.
    expect(shown.slice(shown.indexOf(card) + 1).some((m) => m.role === 'assistant')).toBe(true);

    const oldShown = await history(old, b.sessionFile);
    expect(oldShown.some((m) => m.role === 'shipmates')).toBe(false);
    expect(oldShown.some((m) => m.role === 'assistant')).toBe(true);
  }, 120_000);

  it('a message that arrives while the receiver runs shows live from the settle boundary', async () => {
    const webA = await h.connect(undefined, CARDS);
    const webB = await h.connect(undefined, CARDS);
    await webA.waitForType('shipmates_update');
    await webB.waitForType('shipmates_update');
    const a = await newSession(webA, path.join(h.workspace, 'busy-a'));
    const b = await newSession(webB, path.join(h.workspace, 'busy-b'));
    await quiet();

    // B streams slowly (~2 s); A tells it something in the meantime.
    h.fake.queue({ kind: 'slow-reply', text: 'working on it, one character at a time', charDelayMs: 50 });
    webB.send({ type: 'message', sessionId: b.sessionId, message: 'start the long job' });
    await webB.waitForType('message_update', 20_000);
    h.fake.queue({ kind: 'tool-call', toolName: 'session_tell', input: { target: b.sessionFile, text: 'also update the changelog' } });
    webA.send({ type: 'message', sessionId: a.sessionId, message: 'tell B about the changelog' });

    const live = (await webB.waitForType('shipmates_delivery', 20_000)) as any;
    expect(live.shipmates.origins).toEqual(['agent']);
    expect(live.content).toContain('also update the changelog');
    // Delivered at the boundary, after the slow reply it interrupted nothing of.
    const reply = webB.messages.findIndex((m) => m.type === 'message_end' && (m as any).role === 'assistant');
    expect(reply).toBeGreaterThanOrEqual(0);
    expect(reply).toBeLessThan(webB.messages.indexOf(live));
    await quiet();
    // One delivery, one frame: pi emits only `entry_appended` for a boundary entry.
    expect(webB.messages.filter((m) => m.type === 'shipmates_delivery')).toHaveLength(1);
    const shown = await history(webB, b.sessionFile);
    expect(shown.filter((m) => m.role === 'shipmates')).toHaveLength(1);
  }, 120_000);

  it("a spawned child's history starts with its owner's first prompt", async () => {
    const web = await h.connect(undefined, CARDS);
    await web.waitForType('shipmates_update');
    const owner = await newSession(web, path.join(h.workspace, 'spawn-owner'));
    const laneDir = path.join(h.workspace, 'spawn-lane');
    fs.mkdirSync(laneDir, { recursive: true });
    await quiet();
    h.fake.queue({ kind: 'tool-call', toolName: 'session_spawn', input: { folder: laneDir, prompt: 'Build the push lane.', role: 'tree/push' } });
    web.send({ type: 'message', sessionId: owner.sessionId, message: 'spawn the push lane' });

    let child: { path: string } | undefined;
    const deadline = Date.now() + 30_000;
    while (!child && Date.now() < deadline) {
      const r = await fetch(`http://127.0.0.1:${h.port}/sessions`);
      const data = (await r.json()) as { folders: Array<{ sessions: Array<{ path: string; ownerSessionPath?: string }> }> };
      child = data.folders.flatMap((f) => f.sessions).find((s) => s.ownerSessionPath === owner.sessionFile);
      if (!child) await new Promise((r) => setTimeout(r, 200));
    }
    expect(child).toBeTruthy();
    await quiet();

    const viewer = await h.connect(undefined, CARDS);
    const shown = await history(viewer, child!.path);
    expect(shown[0].role).toBe('shipmates');
    expect(shown[0].content).toMatch(/· spawn\n/);
    expect(shown[0].content).toContain('Build the push lane.');
    expect(shown[0].shipmates.origins).toEqual(['agent']);
    // Nothing was typed into the child: no user message at all.
    expect(shown.some((m) => m.role === 'user')).toBe(false);
  }, 120_000);
});
