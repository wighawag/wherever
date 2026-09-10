import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  annotateFolderExistence,
  invalidateFolderExistence,
  clearSessionIndexCache,
  getFolderExistenceCheckCount,
} from '../src/session-pool.js';
import type { FolderWithSessions } from '../src/session-types.js';

// The LISTING half of the folder-missing state: `/sessions` reports, per FOLDER,
// whether that folder still exists on this machine, so a freshly migrated
// machine shows the scale of what needs restoring without opening anything.
//
// The property this file guards is the COST. A session directory can hold
// thousands of sessions, the dashboard refetches the whole list on every
// `sessions_updated`, and the scan behind it is deliberately cached against
// (mtime, size) so a warm pass reads no bodies at all. An existence check per
// SESSION would put a syscall storm back into exactly that pass, so the check is
// per DISTINCT FOLDER, cached with a short TTL, and invalidated when a restore
// completes.

let root: string;

/** A listing-shaped folder with `n` sessions in it (the sessions are irrelevant
 *  to existence and are only here to prove they are not each checked). */
function folder(dir: string, n = 1): FolderWithSessions {
  return {
    path: dir,
    name: path.basename(dir),
    sessions: Array.from({ length: n }, (_, i) => ({
      path: path.join(dir, `s${i}.jsonl`),
      id: `s${i}`,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hi',
      isActive: false,
      clientCount: 0,
    })),
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-folder-exists-')));
  clearSessionIndexCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('annotateFolderExistence', () => {
  it('marks a removed folder missing and leaves an existing one alone', async () => {
    const present = path.join(root, 'present');
    const gone = path.join(root, 'gone');
    fs.mkdirSync(present);

    const folders = [folder(present), folder(gone)];
    await annotateFolderExistence(folders);

    expect(folders[0].missing).toBeFalsy();
    expect(folders[1].missing).toBe(true);
  });

  it('counts as missing a path that exists but is not a directory', async () => {
    // Same rule as the session-load check: a file cannot be a working folder
    // either, so the honest answer is "not there".
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'not a folder\n');

    const folders = [folder(file)];
    await annotateFolderExistence(folders);

    expect(folders[0].missing).toBe(true);
  });

  it('checks once per distinct folder, never once per session', async () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.mkdirSync(a);

    // 500 sessions across two folders: the naive implementation costs 500 stats.
    const before = getFolderExistenceCheckCount();
    await annotateFolderExistence([folder(a, 300), folder(b, 200)]);

    expect(getFolderExistenceCheckCount() - before).toBe(2);
  });

  it('serves a second listing pass from the cache', async () => {
    const a = path.join(root, 'a');
    fs.mkdirSync(a);

    await annotateFolderExistence([folder(a)]);
    const before = getFolderExistenceCheckCount();
    const second = [folder(a)];
    await annotateFolderExistence(second);

    expect(getFolderExistenceCheckCount() - before).toBe(0);
    expect(second[0].missing).toBeFalsy();
  });

  it('re-checks a folder whose entry was invalidated (what a completed restore does)', async () => {
    const a = path.join(root, 'restored');

    const first = [folder(a)];
    await annotateFolderExistence(first);
    expect(first[0].missing).toBe(true);

    // The restore lands...
    fs.mkdirSync(a);

    // ...and WITHOUT the invalidation the cached "missing" would still be served.
    const stale = [folder(a)];
    await annotateFolderExistence(stale);
    expect(stale[0].missing).toBe(true);

    invalidateFolderExistence(a);
    const fresh = [folder(a)];
    const before = getFolderExistenceCheckCount();
    await annotateFolderExistence(fresh);

    expect(getFolderExistenceCheckCount() - before).toBe(1);
    expect(fresh[0].missing).toBeFalsy();
  });

  it('invalidates by the same path key however the path is written', async () => {
    const a = path.join(root, 'keyed');
    const listed = [folder(a)];
    await annotateFolderExistence(listed);
    expect(listed[0].missing).toBe(true);

    fs.mkdirSync(a);
    // The registry hands back a resolved absolute path; a caller may hold a
    // cosmetically different spelling of the same folder.
    invalidateFolderExistence(path.join(a, '..', path.basename(a)) + '/');

    const fresh = [folder(a)];
    await annotateFolderExistence(fresh);
    expect(fresh[0].missing).toBeFalsy();
  });
});
