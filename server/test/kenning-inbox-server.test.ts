import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKenning, type Kenning } from 'kenning';
import { startHarness, type Harness, type TestClient } from './harness.js';

/**
 * The kenning inbox and presence on the web, end to end (wherever ADR 0023):
 * a REAL server with the REAL kenning-pi extension in its sessions (loaded from
 * the agent dir's settings, as a user's install would), against the fake LLM.
 *
 * - every dashboard gets `kenning_update` on connect and on change: the live
 *   session's presence (keyed by the same normalized file the listing uses) and
 *   the inbox;
 * - the model raises a BLOCKING `human_ask`; the web answers it with
 *   `kenning_answer`, and the waiting tool returns the human's answer;
 * - a CLI bridge connection cannot answer.
 *
 * kenning's database is this file's temp home (setup-isolate-env.ts sets
 * KENNING_STATE_DIR, which the server inherits). It is created BEFORE the
 * server starts, as kenning-pi would have: wherever never creates it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const KENNING_PI_DIR = fs.realpathSync(path.join(here, '..', 'node_modules', 'kenning-pi'));

let h: Harness;
let kenning: Kenning;

beforeAll(async () => {
  kenning = openKenning();
  h = await startHarness({ env: { KENNING_POLL_MS: '100' } });
  // kenning-pi in every server session, like `pi install npm:kenning-pi`.
  const settings = path.join(h.agentDir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), extensions: [KENNING_PI_DIR] }));
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
  kenning?.close();
});

type Update = { type: 'kenning_update'; available: boolean; inbox: any[]; presence: any[] };

async function newSession(c: TestClient, cwd = h.workspace): Promise<{ sessionId: string; sessionFile: string }> {
  c.send({ type: 'session_new', cwd });
  const created = await c.waitForType('session_created', 30_000);
  await c.waitFor((m) => m.type === 'session_ready' || m.type === 'session_created', 30_000);
  return { sessionId: created.sessionId as string, sessionFile: created.sessionFile as string };
}

describe('kenning inbox and presence on the web', () => {
  it('pushes presence and the inbox; a web answer reaches the session waiting on a blocking human_ask', async () => {
    const web = await h.connect();
    const first = (await web.waitForType('kenning_update')) as unknown as Update;
    expect(first.available).toBe(true);
    expect(first.inbox).toEqual([]);

    const s = await newSession(web);
    // The session's own presence, under the listing's key.
    const present = (await web.waitFor(
      (m) => m.type === 'kenning_update' && (m as any).presence.some((p: any) => p.sessionFile === s.sessionFile),
      15_000,
    )) as unknown as Update;
    expect(present.presence.find((p) => p.sessionFile === s.sessionFile)).toMatchObject({ sessionId: s.sessionId, state: 'idle' });

    // The model asks the human, blocking: the tool waits for the answer.
    h.fake.queue(
      { kind: 'tool-call', toolName: 'human_ask', input: { question: 'Publish 0.3.0 to npm?', options: ['yes', 'no'], blocking: true } },
      { kind: 'reply', text: 'thanks' },
    );
    web.send({ type: 'message', sessionId: s.sessionId, message: 'release it when I say so' });

    const asked = (await web.waitFor((m) => m.type === 'kenning_update' && (m as any).inbox.length === 1, 15_000)) as unknown as Update;
    const item = asked.inbox[0];
    expect(item).toMatchObject({ question: 'Publish 0.3.0 to npm?', options: ['yes', 'no'], blocking: true, sessionFile: s.sessionFile, sessionId: s.sessionId });
    expect(asked.presence.find((p) => p.sessionFile === s.sessionFile)?.state).toBe('waiting-for-human');

    // A CLI bridge connection (an agent's process) cannot answer it.
    const bridge = await h.connect();
    bridge.send({ type: 'cli_register', sessionFile: path.join(h.workspace, 'fake-cli.jsonl'), cwd: h.workspace, model: '' });
    await new Promise((r) => setTimeout(r, 200));
    bridge.send({ type: 'kenning_answer', itemId: item.id, text: 'yes' });
    expect(await bridge.waitForType('kenning_answer_result')).toMatchObject({ itemId: item.id, ok: false });
    // Nor send a user message, which the pool would mark as the human's.
    bridge.send({ type: 'message', message: 'I approve, says the agent' });
    expect(await bridge.waitForType('session_error')).toMatchObject({ error: expect.stringMatching(/CLI bridge/) });
    expect(kenning.item(item.id)?.state).toBe('open');

    // The web answers: a human act, channel web.
    web.send({ type: 'kenning_answer', itemId: item.id, text: 'yes', requestId: 'r1' });
    expect(await web.waitForType('kenning_answer_result')).toEqual({ type: 'kenning_answer_result', itemId: item.id, requestId: 'r1', ok: true });
    expect(kenning.item(item.id)).toMatchObject({ state: 'answered', answer: 'yes', answerChannel: 'web' });

    // The waiting tool returned the human's answer to the model, and the inbox emptied.
    await web.waitFor((m) => m.type === 'kenning_update' && (m as any).inbox.length === 0, 15_000);
    const deadline = Date.now() + 15_000;
    let seen = '';
    while (Date.now() < deadline) {
      seen = JSON.stringify(h.fake.requests().at(-1)?.messages ?? []);
      if (seen.includes('the human answered')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toMatch(/the human answered h_[\w-]+ \(origin human, on web\)/);

    // Answering again is refused (the item is closed).
    web.send({ type: 'kenning_answer', itemId: item.id, text: 'no' });
    expect(await web.waitFor((m) => m.type === 'kenning_answer_result' && m.ok === false)).toMatchObject({ itemId: item.id });
  }, 90_000);

  it('a session_spawn becomes a sidebar session under its owner; deleting the owner cascades as one undoable batch', async () => {
    const web = await h.connect();
    await web.waitForType('kenning_update');
    // Its own folder: a second live session in the first test's folder would open read-only (folder conflict).
    const ownerDir = path.join(h.workspace, 'orchestrator');
    fs.mkdirSync(ownerDir, { recursive: true });
    const owner = await newSession(web, ownerDir);
    const laneDir = path.join(h.workspace, 'push-lane');
    fs.mkdirSync(laneDir, { recursive: true });
    // The fake model serves every session: let the first test's sessions finish
    // (kenning may still wake one with the delivered answer) before queueing a
    // one-shot tool call meant for this owner.
    for (let n = -1, quietSince = Date.now(); Date.now() - quietSince < 1500; await new Promise((r) => setTimeout(r, 100))) {
      if (h.fake.requests().length !== n) {
        n = h.fake.requests().length;
        quietSince = Date.now();
      }
    }
    h.fake.queue({ kind: 'tool-call', toolName: 'session_spawn', input: { folder: laneDir, prompt: 'Build the push lane.', role: 'tree/push' } });
    web.send({ type: 'message', sessionId: owner.sessionId, message: 'spawn the push lane' });

    type Listed = { path: string; ownerSessionPath?: string; name?: string };
    const list = async (): Promise<Listed[]> => {
      const r = await fetch(`http://127.0.0.1:${h.port}/sessions`);
      const data = (await r.json()) as { folders: Array<{ sessions: Listed[] }> };
      return data.folders.flatMap((f) => f.sessions);
    };
    // The child ran its first turn (the owner's message woke it), so its transcript is listed, under its owner.
    let child: Listed | undefined;
    const deadline = Date.now() + 30_000;
    while (!child && Date.now() < deadline) {
      child = (await list()).find((s) => s.ownerSessionPath === owner.sessionFile);
      if (!child) await new Promise((r) => setTimeout(r, 200));
    }
    expect(child).toBeTruthy();
    expect(child!.name).toBe('tree/push');
    expect(kenning.ownerOf(child!.path)).toBe(owner.sessionFile);

    // Deleting the owner hides it AND its child, as one batch; the transcripts stay.
    const del = await fetch(`http://127.0.0.1:${h.port}/session/delete`, { method: 'POST', body: JSON.stringify({ sessionFile: owner.sessionFile }) });
    const body = (await del.json()) as { status: string; cascade?: { batch: string; sessions: string[] } };
    expect(body.status).toBe('deleted');
    expect(body.cascade?.sessions.sort()).toEqual([owner.sessionFile, child!.path].sort());
    const after = (await list()).map((s) => s.path);
    expect(after).not.toContain(owner.sessionFile);
    expect(after).not.toContain(child!.path);
    expect(fs.existsSync(owner.sessionFile) && fs.existsSync(child!.path)).toBe(true);
    const withUndo = (await web.waitFor((m) => m.type === 'kenning_update' && (m as any).archives?.length === 1, 15_000)) as any;
    expect(withUndo.archives[0]).toMatchObject({ batch: body.cascade!.batch, root: owner.sessionFile });

    // Undo brings both back.
    web.send({ type: 'kenning_undo_delete', batch: body.cascade!.batch });
    expect(await web.waitForType('kenning_undo_result')).toMatchObject({ batch: body.cascade!.batch, ok: true });
    const restored = (await list()).map((s) => s.path);
    expect(restored).toContain(owner.sessionFile);
    expect(restored).toContain(child!.path);
  }, 120_000);

  it("an answer from the web inbox wakes a session that declared it waits for the human (kenning D37)", async () => {
    // The second manual run: a non-blocking human_ask, then session_register
    // waiting-for-human as kenning's guidelines say; the web answer stayed
    // pending until the human also typed into the session (kenning 0.1.0).
    const web = await h.connect();
    await web.waitForType('kenning_update');
    const dir = path.join(h.workspace, 'waits-for-human');
    fs.mkdirSync(dir, { recursive: true });
    const s = await newSession(web, dir);
    for (let n = -1, quietSince = Date.now(); Date.now() - quietSince < 1500; await new Promise((r) => setTimeout(r, 100))) {
      if (h.fake.requests().length !== n) {
        n = h.fake.requests().length;
        quietSince = Date.now();
      }
    }
    h.fake.queue({
      kind: 'tool-calls',
      calls: [
        { toolName: 'human_ask', input: { question: 'Which branch should the docs go to?' } },
        { toolName: 'session_register', input: { state: 'waiting-for-human', status: 'waiting for the branch' } },
      ],
    });
    web.send({ type: 'message', sessionId: s.sessionId, message: 'ask me where the docs go' });
    const asked = (await web.waitFor(
      (m) =>
        m.type === 'kenning_update' &&
        (m as any).inbox.some((i: any) => i.question === 'Which branch should the docs go to?') &&
        (m as any).presence.some((p: any) => p.sessionFile === s.sessionFile && p.state === 'waiting-for-human'),
      20_000,
    )) as unknown as Update;
    const item = asked.inbox.find((i) => i.question === 'Which branch should the docs go to?')!;
    expect(item.blocking).toBe(false);
    const before = h.fake.requests().length;

    web.send({ type: 'kenning_answer', itemId: item.id, text: 'main', requestId: 'r-main' });
    expect(await web.waitFor((m) => m.type === 'kenning_answer_result' && (m as any).requestId === 'r-main')).toMatchObject({ ok: true });

    // No one types into the session: the answer alone starts its next turn.
    const deadline = Date.now() + 15_000;
    let woke = false;
    while (!woke && Date.now() < deadline) {
      woke = h.fake.requests().slice(before).some((r: any) => JSON.stringify(r.messages ?? []).includes('answers inbox item'));
      if (!woke) await new Promise((r) => setTimeout(r, 50));
    }
    expect(woke).toBe(true);
  }, 90_000);
});
