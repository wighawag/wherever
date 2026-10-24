import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

// `POST /session/upload` (the `uploads.method: 'post'` path) gets the WebSocket
// path's write guarantees (docs/adr/0012):
//
//  - the target folder is the session's own, resolved from the pool when it is
//    loaded and from the session file's HEADER otherwise. The old handler used
//    `pool.getSession()` only, so a session whose agent was not (yet) built
//    silently got its file in tmp;
//  - a `sessions.readOnly` folder, a MISSING folder and a folder a restore job is
//    materialising all refuse the upload (the old handler had no gate at all, and
//    its `mkdirSync(recursive)` would even recreate a missing folder);
//  - an unknown session is a 404;
//  - `uploads.maxBytes` is enforced from `Content-Length` and, for a body without
//    one, by a running count that unlinks the partial file.
//
// Every test that may write an upload uses `uploads.type: 'session'` (its OWN
// config dir), so nothing reaches the real os.tmpdir(); the AMBIENT state dir is
// checked to be untouched.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUILD_DELAY_MS = 2_500;
const PAYLOAD = 'post upload payload\n';

// The state dir the server would resolve WITHOUT the harness's isolation (see
// getWhereverStateDir). Compared by entry names only (a live server may write
// to it concurrently), ignoring the transient `.tmp` of an atomic write.
const ambientStateDir = (() => {
  const state = process.env.WHEREVER_STATE_DIR?.trim();
  if (state) return path.resolve(state);
  const config = process.env.WHEREVER_CONFIG_DIR?.trim();
  if (config) return path.resolve(config);
  return path.join(os.homedir(), '.wherever');
})();
function snapshotAmbient(): string[] {
  try {
    return fs
      .readdirSync(ambientStateDir)
      .filter((n) => !n.endsWith('.tmp'))
      .sort();
  } catch {
    return ['<absent>'];
  }
}

// A local git fixture plus a template whose post-checkout hook sleeps, so a
// restore clone is RUNNING for a known time (see restore-clone-panel.test.ts).
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Wherever Test',
  GIT_AUTHOR_EMAIL: 'test@wherever.invalid',
  GIT_COMMITTER_NAME: 'Wherever Test',
  GIT_COMMITTER_EMAIL: 'test@wherever.invalid',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
};
let fixtureRoot = '';
let repoUrl = '';
let slowTemplateDir = '';
let fakeHome = '';

let ambientBefore: string[];
beforeAll(() => {
  ambientBefore = snapshotAmbient();
  fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-post-upload-fx-')));
  const repo = path.join(fixtureRoot, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'restored\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  repoUrl = `file://${repo}`;
  fakeHome = path.join(fixtureRoot, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  slowTemplateDir = path.join(fixtureRoot, 'slow-template');
  fs.mkdirSync(path.join(slowTemplateDir, 'hooks'), { recursive: true });
  const hook = path.join(slowTemplateDir, 'hooks', 'post-checkout');
  fs.writeFileSync(hook, '#!/bin/sh\nsleep 4\nexit 0\n');
  fs.chmodSync(hook, 0o755);
});
afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  expect(snapshotAmbient()).toEqual(ambientBefore);
});

let h: Harness | undefined;
let configDir: string | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

function writeConfig(config: object) {
  fs.writeFileSync(path.join(configDir!, 'config.json'), JSON.stringify(config));
}

async function boot(
  config: object,
  opts?: { idleTimeoutMs?: number; delay?: boolean; env?: Record<string, string> },
): Promise<Harness> {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-post-upload-cfg-'));
  writeConfig(config);
  return startHarness({
    initial: { kind: 'reply', text: 'hi' },
    idleTimeoutMs: opts?.idleTimeoutMs ?? 0,
    env: {
      WHEREVER_CONFIG_DIR: configDir,
      ...(opts?.delay ? { WHEREVER_TEST_COLD_BUILD_DELAY_MS: String(BUILD_DELAY_MS) } : {}),
      ...opts?.env,
    },
  });
}

/** Create a session in `cwd` with one real turn; optionally drop its viewer so it is evicted (cold). */
async function seedSession(harness: Harness, cwd: string, opts?: { cold?: boolean }) {
  fs.mkdirSync(cwd, { recursive: true });
  const c = await harness.connect();
  await c.waitForType('connected');
  c.send({ type: 'session_new', cwd });
  const created = await c.waitForType('session_created', 30_000);
  c.send({ type: 'message', message: 'hello', sessionId: created.sessionId });
  await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant', 30_000);
  await c.waitForType('agent_end', 30_000);
  if (opts?.cold) {
    c.close();
    await sleep(400);
  }
  return { c, sessionFile: created.sessionFile as string, sessionId: created.sessionId as string };
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true } as any) as any[]) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path ?? dir, entry.name));
  }
  return out.sort();
}

async function post(harness: Harness, sessionId: string, body: string | Buffer = PAYLOAD) {
  const res = await fetch(
    `http://127.0.0.1:${harness.port}/session/upload?sessionId=${encodeURIComponent(sessionId)}&filename=note.txt`,
    { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body },
  );
  return { status: res.status, body: (await res.json()) as { error?: string; savedPath?: string } };
}

const uploadsOf = (cwd: string) => path.join(cwd, '.wherever', 'uploads');

describe('POST /session/upload: target folder and write gate', () => {
  it('accepts an upload for a cold session with no live agent and lands it in that session\'s upload dir', async () => {
    h = await boot({ uploads: { type: 'session' } });
    const proj = path.join(h.workspace, 'cold-project');
    const { sessionId } = await seedSession(h, proj, { cold: true });

    const r = await post(h, sessionId);
    expect(r.status).toBe(200);
    // Without the header fallback this was os.tmpdir().
    expect(String(r.body.savedPath).startsWith(uploadsOf(proj) + path.sep)).toBe(true);
    expect(fs.readFileSync(String(r.body.savedPath), 'utf8')).toBe(PAYLOAD);
  }, 90_000);

  it('accepts an upload while the session\'s agent is still building, before session_ready', async () => {
    h = await boot({ uploads: { type: 'session' } }, { delay: true });
    const proj = path.join(h.workspace, 'building-project');
    const { sessionFile } = await seedSession(h, proj, { cold: true });

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_load', sessionFile });
    const painted = await c.waitForType('session_created', 10_000);
    expect(painted.pending).toBe(true);

    const r = await post(h, painted.sessionId as string);
    expect(r.status).toBe(200);
    expect(c.messages.some((m) => m.type === 'session_ready')).toBe(false);
    expect(String(r.body.savedPath).startsWith(uploadsOf(proj) + path.sep)).toBe(true);
    await c.waitForType('session_ready', 30_000);
  }, 90_000);

  it('accepts an upload for a loaded session', async () => {
    h = await boot({ uploads: { type: 'session' } }, { idleTimeoutMs: 60_000 });
    const proj = path.join(h.workspace, 'live-project');
    const { sessionId } = await seedSession(h, proj);
    const r = await post(h, sessionId);
    expect(r.status).toBe(200);
    expect(String(r.body.savedPath).startsWith(uploadsOf(proj) + path.sep)).toBe(true);
  }, 90_000);

  it('answers 404 for an unknown session and writes nothing', async () => {
    h = await boot({ uploads: { type: 'session' } });
    const before = filesUnder(h.workspace);
    const r = await post(h, 'no-such-session-id');
    expect(r.status).toBe(404);
    expect(String(r.body.error)).toMatch(/not found/i);
    expect(filesUnder(h.workspace)).toEqual(before);
  }, 60_000);

  it('refuses an upload into a sessions.readOnly folder, loaded or not', async () => {
    h = await boot({ uploads: { type: 'session' } }, { idleTimeoutMs: 60_000 });
    const proj = path.join(h.workspace, 'fleet-project');
    const live = await seedSession(h, proj);
    const coldProj = path.join(h.workspace, 'fleet-cold');
    const cold = await seedSession(h, coldProj, { cold: true });
    // Configured after seeding (the config is read per call).
    writeConfig({ uploads: { type: 'session' }, sessions: { readOnly: [`${h.workspace}/fleet-*/**`, `${h.workspace}/fleet-*`] } });
    const before = filesUnder(h.workspace);

    for (const sessionId of [live.sessionId, cold.sessionId]) {
      const r = await post(h, sessionId);
      expect(r.status).toBe(403);
      expect(String(r.body.error)).toMatch(/read-only/i);
    }
    expect(filesUnder(h.workspace)).toEqual(before);
  }, 120_000);

  it('refuses an upload into a MISSING folder, and does not recreate it', async () => {
    h = await boot({ uploads: { type: 'session' } });
    const proj = path.join(h.workspace, 'doomed-project');
    const { sessionId } = await seedSession(h, proj, { cold: true });
    fs.rmSync(proj, { recursive: true, force: true });

    const r = await post(h, sessionId);
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toMatch(/missing/i);
    expect(fs.existsSync(proj)).toBe(false);
  }, 90_000);

  it('refuses an upload into a folder a restore job is materialising', async () => {
    h = await boot(
      { uploads: { type: 'session' } },
      // A restore target must live under the server's HOME, so give it a throwaway one.
      { env: { ...GIT_ENV, GIT_TEMPLATE_DIR: slowTemplateDir, HOME: fakeHome } },
    );
    const proj = path.join(fakeHome, 'dev', `restoring-project-${Date.now()}`);
    const { sessionId, sessionFile } = await seedSession(h, proj, { cold: true });
    fs.rmSync(proj, { recursive: true, force: true });

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_load', sessionFile });
    await c.waitForType('folder_missing', 20_000);
    c.send({ type: 'restore_start', targetPath: proj, action: 'clone', url: repoUrl });
    await c.waitForType('restore_started', 20_000);
    // git creates the target in its first breath and the hook holds the job open,
    // so the folder EXISTS but is not usable yet.
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(path.join(proj, 'README.md')) && Date.now() < deadline) await sleep(100);
    expect(fs.existsSync(proj)).toBe(true);
    expect(c.messages.some((m) => m.type === 'restore_complete')).toBe(false);

    const r = await post(h, sessionId);
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toMatch(/restor/i);
    expect(fs.existsSync(uploadsOf(proj))).toBe(false);

    const done = await c.waitFor((m) => m.type === 'restore_complete', 60_000);
    expect((done.job as { state: string }).state).toBe('done');
    // Once the job is over the folder is a normal one again.
    const after = await post(h, sessionId);
    expect(after.status).toBe(200);
  }, 120_000);
});

describe('POST /session/upload: uploads.maxBytes', () => {
  it('refuses an oversized upload declared by Content-Length, writing nothing', async () => {
    h = await boot({ uploads: { type: 'session', maxBytes: 8 } }, { idleTimeoutMs: 60_000 });
    const proj = path.join(h.workspace, 'size-project');
    const { sessionId } = await seedSession(h, proj);
    const r = await post(h, sessionId, 'way more than eight bytes');
    expect(r.status).toBe(413);
    expect(String(r.body.error)).toMatch(/too large/i);
    expect(filesUnder(uploadsOf(proj))).toEqual([]);
  }, 90_000);

  it('refuses a chunked body that outgrows the limit mid-stream and unlinks the partial file', async () => {
    const LIMIT = 1024;
    h = await boot({ uploads: { type: 'session', maxBytes: LIMIT } }, { idleTimeoutMs: 60_000 });
    const proj = path.join(h.workspace, 'stream-project');
    const { sessionId } = await seedSession(h, proj);

    const port = h.port;
    const response = new Promise<{ status: number; body: { error?: string } }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/session/upload?sessionId=${encodeURIComponent(sessionId)}&filename=big.bin`,
          // No Content-Length: Node sends `Transfer-Encoding: chunked`, so only
          // the running count can catch it.
          headers: { 'Content-Type': 'application/octet-stream' },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
          res.on('error', reject);
        },
      );
      // The server closes the connection after refusing; a late write may EPIPE.
      req.on('error', () => {});
      (async () => {
        req.write(Buffer.alloc(600, 1));
        // The partial must really exist before the overflow, or "unlinked" is vacuous.
        const deadline = Date.now() + 10_000;
        while (filesUnder(uploadsOf(proj)).length === 0 && Date.now() < deadline) await sleep(50);
        expect(filesUnder(uploadsOf(proj)).length).toBe(1);
        req.write(Buffer.alloc(600, 2));
        await sleep(200);
        req.end();
      })().catch(reject);
    });

    const r = await response;
    expect(r.status).toBe(413);
    expect(String(r.body.error)).toMatch(/too large/i);
    expect(filesUnder(uploadsOf(proj))).toEqual([]);
  }, 90_000);
});
