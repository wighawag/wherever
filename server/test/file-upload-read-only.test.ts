import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

// An upload WRITES a file to disk, so it is a write capability and must sit
// behind the same read-only verdict as a send.
//
// It did not. `case 'file_upload'` never consulted `client.readOnly`, so a
// client on an observe-only session could not send a message referencing an
// attachment but could still drop the attachment itself into the upload dir --
// a write from a connection the server had already told "you may not write
// here". Spotted while adding the folder-missing read-only reason.
//
// These tests drive the two read-only reasons that are deterministic to
// produce: a configured `sessions.readOnly` folder (a policy rule) and a
// missing folder (a fact about the disk). Both are HARD, and neither may
// accept an upload.

let h: Harness | undefined;
let configDir: string | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAYLOAD = Buffer.from('this must never reach the disk\n').toString('base64');

/** Create a session in `cwd` and give it one real turn, so it has history to paint. */
async function seedSession(harness: Harness, cwd: string) {
  const c = await harness.connect();
  await c.waitForType('connected');
  c.send({ type: 'session_new', cwd });
  const created = await c.waitForType('session_created');
  c.send({ type: 'message', message: 'hello', sessionId: created.sessionId });
  await c.waitFor((m) => m.type === 'message_end' && m.role === 'assistant');
  await c.waitForType('agent_end');
  return { c, sessionFile: created.sessionFile as string, sessionId: created.sessionId as string };
}

/** Every file anywhere under `dir`, so "nothing was written" is checked, not assumed. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true } as any) as any[]) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path ?? dir, entry.name));
  }
  return out;
}

describe('file_upload is gated by the read-only verdict', () => {
  it('refuses an upload from a session whose folder is MISSING, and writes nothing', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'hi' }, idleTimeoutMs: 0 });
    const doomed = path.join(h.workspace, 'doomed-project');
    fs.mkdirSync(doomed, { recursive: true });

    const { c, sessionFile } = await seedSession(h, doomed);
    c.close();
    await sleep(300);

    // The machine migration, in one line: the transcript survives, the clone does not.
    fs.rmSync(doomed, { recursive: true, force: true });
    const before = filesUnder(h.workspace);

    const c2 = await h.connect();
    await c2.waitForType('connected');
    c2.send({ type: 'session_load', sessionFile });
    const painted = await c2.waitForType('session_created', 10_000);
    expect(painted.readOnly).toBe(true);
    expect(painted.folderMissing).toBe(true);

    c2.send({
      type: 'file_upload',
      uploadId: 'u1',
      sessionId: painted.sessionId,
      filename: 'note.txt',
      data: PAYLOAD,
    });

    // Refused OUT LOUD: a client only hides its composer when it agrees it is
    // read-only, so a desync must be visible rather than swallowed.
    const refusal = await c2.waitForType('file_upload_error', 10_000);
    expect(refusal.uploadId).toBe('u1');
    expect(String(refusal.error)).toMatch(/read-only/i);
    // ...and never answered as though it had worked.
    await sleep(500);
    expect(c2.messages.some((m) => m.type === 'file_uploaded')).toBe(false);

    // Nothing landed on disk.
    expect(filesUnder(h.workspace)).toEqual(before);
  }, 90_000);

  it('refuses an upload from a configured sessions.readOnly folder, and writes nothing', async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-upload-cfg-'));
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({}));
    h = await startHarness({
      initial: { kind: 'reply', text: 'ok' },
      idleTimeoutMs: 0,
      env: { WHEREVER_CONFIG_DIR: configDir },
    });
    const fleet = path.join(h.workspace, 'fleet-project');
    fs.mkdirSync(fleet, { recursive: true });

    const { c, sessionFile } = await seedSession(h, fleet);
    c.close();
    await sleep(300);

    // The rule is configured AFTER seeding (the config is read per call), so the
    // session could be created and given history while still writable.
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ sessions: { readOnly: [`${fleet}/**`] } }),
    );
    const before = filesUnder(h.workspace);

    const c2 = await h.connect();
    await c2.waitForType('connected');
    c2.send({ type: 'session_load', sessionFile });
    const painted = await c2.waitForType('session_created', 10_000);
    expect(painted.readOnly).toBe(true);
    // The folder is right there; this is the POLICY reason, not the disk one.
    expect(painted.folderMissing).toBeFalsy();

    c2.send({
      type: 'file_upload',
      uploadId: 'u2',
      sessionId: painted.sessionId,
      filename: 'note.txt',
      data: PAYLOAD,
    });

    const refusal = await c2.waitForType('file_upload_error', 10_000);
    expect(refusal.uploadId).toBe('u2');
    expect(String(refusal.error)).toMatch(/read-only/i);
    await sleep(500);
    expect(c2.messages.some((m) => m.type === 'file_uploaded')).toBe(false);
    expect(filesUnder(h.workspace)).toEqual(before);
  }, 90_000);

  it('still accepts an upload on a normal, writable session', async () => {
    // The guard must refuse the read-only cases WITHOUT breaking the feature.
    h = await startHarness({ initial: { kind: 'reply', text: 'hi' }, idleTimeoutMs: 60_000 });
    const project = path.join(h.workspace, 'live-project');
    fs.mkdirSync(project, { recursive: true });

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: project });
    const created = await c.waitForType('session_created', 30_000);
    expect(created.readOnly).toBeFalsy();

    c.send({
      type: 'file_upload',
      uploadId: 'u3',
      sessionId: created.sessionId,
      filename: 'note.txt',
      data: PAYLOAD,
    });

    const saved = await c.waitForType('file_uploaded', 20_000);
    expect(saved.uploadId).toBe('u3');
    expect(fs.readFileSync(String(saved.savedPath), 'utf8')).toBe('this must never reach the disk\n');
  }, 90_000);
});
