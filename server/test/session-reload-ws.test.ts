import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

// End-to-end (real server + real pi + fake LLM) for the web `/reload`: the
// `session_reload` frame must rebuild the session's agent so that what changed on
// disk (an extension's code, the project's AGENTS.md) is live afterwards, with
// session_reloading -> session_ready framing the composer block, and a refusal
// (not a silent drop) while the agent is busy.

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A global extension that appends `<version>:<event>:<reason>` lines to `marker`. */
function writeMarkerExtension(agentDir: string, marker: string, version: string): void {
  const dir = path.join(agentDir, 'extensions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'reload-marker.ts'),
    `import fs from 'node:fs';
export default function (pi) {
  pi.on('session_start', (e) => { fs.appendFileSync(${JSON.stringify(marker)}, '${version}:start:' + e.reason + '\\n'); });
  pi.on('session_shutdown', (e) => { fs.appendFileSync(${JSON.stringify(marker)}, '${version}:shutdown:' + e.reason + '\\n'); });
}
`,
  );
}

/** A global extension whose session_shutdown takes `ms`: makes a reload slow enough to race. */
function writeSlowShutdownExtension(agentDir: string, ms: number): void {
  const dir = path.join(agentDir, 'extensions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'slow-shutdown.ts'),
    `export default function (pi) {
  pi.on('session_shutdown', () => new Promise((r) => setTimeout(r, ${ms})));
}
`,
  );
}

/** Start a session with one exchanged turn, so its transcript is on disk. */
async function sessionWithOneTurn(harness: Harness, key?: string) {
  const c = await harness.connect(key);
  await c.waitForType('connected');
  c.send({ type: 'session_new', cwd: c.workspace });
  const created = await c.waitForType('session_created');
  c.send({ type: 'message', message: 'hi', sessionId: created.sessionId });
  await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
  return { c, sessionId: created.sessionId as string, sessionFile: created.sessionFile as string };
}

function markerLines(marker: string): string[] {
  return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [];
}

describe('session_reload (web /reload)', () => {
  it('rebuilds the agent: new extension code and new AGENTS.md are live afterwards', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'first' } });
    const marker = path.join(h.workspace, '..', 'marker.log');
    writeMarkerExtension(h.agentDir, marker, 'v1');

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');
    const sessionId = created.sessionId as string;
    expect(markerLines(marker)).toEqual(['v1:start:startup']);

    // Change what a reload is for: the extension's code and the project context.
    writeMarkerExtension(h.agentDir, marker, 'v2');
    fs.writeFileSync(path.join(c.workspace, 'AGENTS.md'), 'RELOAD-SENTINEL-CONTEXT\n');

    c.send({ type: 'session_reload', sessionId });
    await c.waitFor((m) => m.type === 'session_reloading' && m.sessionId === sessionId);
    const ready = await c.waitFor((m) => m.type === 'session_ready' && m.sessionId === sessionId, 30_000);
    expect(ready.sessionFile).toBeTruthy();
    const notice = await c.waitFor((m) => m.type === 'session_notice' && m.sessionId === sessionId);
    expect(notice.level).toBe('info');

    // Old code shut down for a reload; NEW code started for a reload.
    expect(markerLines(marker)).toEqual(['v1:start:startup', 'v1:shutdown:reload', 'v2:start:reload']);

    // The rebuilt agent answers, and its system prompt carries the new context.
    h.setNext({ kind: 'reply', text: 'after reload' });
    c.send({ type: 'message', message: 'hello again', sessionId });
    await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
    const reqs = h.fake.requests();
    expect(JSON.stringify(reqs[reqs.length - 1]?.system ?? '')).toContain('RELOAD-SENTINEL-CONTEXT');
  }, 90_000);

  it('refuses with a notice while the agent is streaming, and leaves the turn alone', async () => {
    h = await startHarness({ initial: { kind: 'slow-reply', text: 'a fairly long streaming answer', charDelayMs: 40 } });
    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');
    const sessionId = created.sessionId as string;

    c.send({ type: 'message', message: 'go', sessionId });
    await c.waitForType('message_update');
    c.send({ type: 'session_reload', sessionId });
    const notice = await c.waitFor((m) => m.type === 'session_notice' && m.sessionId === sessionId);
    expect(notice.level).toBe('warning');
    expect(String(notice.message)).toMatch(/Wait for the current response/);
    expect(c.messages.some((m) => m.type === 'session_reloading')).toBe(false);

    // The turn completes normally.
    await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
  }, 90_000);

  it('a viewer who opens the session MID-reload is painted pending and gets exactly one session_ready', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'ok' } });
    writeSlowShutdownExtension(h.agentDir, 800);
    const { c, sessionId, sessionFile } = await sessionWithOneTurn(h, 'viewer-a');

    c.send({ type: 'session_reload', sessionId });
    await c.waitForType('session_reloading');

    const late = await h.connect('viewer-b');
    await late.waitForType('connected');
    late.send({ type: 'session_load', sessionFile });
    const created = await late.waitForType('session_created');
    expect(created.pending).toBe(true);

    await c.waitFor((m) => m.type === 'session_notice' && m.level === 'info', 30_000);
    await late.waitForType('session_ready', 30_000);
    // Give any stray duplicate a moment to show up.
    await new Promise((r) => setTimeout(r, 200));
    expect(late.messages.filter((m) => m.type === 'session_ready')).toHaveLength(1);
  }, 90_000);

  it('a message sent mid-reload is refused AND the reload block is re-asserted', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'ok' } });
    writeSlowShutdownExtension(h.agentDir, 800);
    const { c, sessionId } = await sessionWithOneTurn(h);

    c.send({ type: 'session_reload', sessionId });
    await c.waitForType('session_reloading');
    c.send({ type: 'message', message: 'too early', sessionId });
    const err = await c.waitFor((m) => m.type === 'session_error' && String(m.error).includes('reloading'));
    // session_error fails the message on the client but also clears its composer
    // block, so it must be FOLLOWED by a fresh session_reloading.
    const errIndex = c.messages.indexOf(err);
    await c.waitFor((m) => m.type === 'session_reloading' && c.messages.indexOf(m) > errIndex);
    await c.waitForType('session_ready', 30_000);
  }, 90_000);

  it('a viewer who switched to another session mid-reload gets none of its frames', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'ok' } });
    writeSlowShutdownExtension(h.agentDir, 800);
    const { c: requester, sessionId } = await sessionWithOneTurn(h, 'requester');
    const watcher = await h.connect('watcher');
    await watcher.waitForType('connected');
    watcher.send({ type: 'session_load', sessionFile: (requester.messages.find((m) => m.type === 'session_created') as any).sessionFile });
    await watcher.waitForType('session_ready', 30_000);

    requester.send({ type: 'session_reload', sessionId });
    await watcher.waitFor((m) => m.type === 'session_reloading' && m.sessionId === sessionId);
    // The watcher leaves for a brand new session while the reload runs.
    watcher.send({ type: 'session_new', cwd: watcher.workspace, model: undefined });
    await watcher.waitFor((m) => m.type === 'session_created' && m.sessionId !== sessionId, 30_000);
    const switchedAt = watcher.messages.length;

    await requester.waitFor((m) => m.type === 'session_notice' && m.level === 'info', 30_000);
    await new Promise((r) => setTimeout(r, 200));
    const stray = watcher.messages.slice(switchedAt).filter((m) => m.sessionId === sessionId);
    expect(stray).toEqual([]);
  }, 90_000);
});
