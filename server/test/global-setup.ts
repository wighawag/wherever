import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Suite-wide isolation (runs once, in the main vitest process, before any
 * worker starts):
 *
 * 1. Creates ONE temp root for the whole run and hands it to the workers
 *    through `WHEREVER_TEST_ISOLATION_ROOT` (forked workers inherit this env).
 *    `setup-isolate-env.ts` gives every test file its own HOME under it. The
 *    root is removed at teardown, after every worker has exited, so background
 *    work that outlives a test file still writes into the temp tree, never into
 *    a real home.
 * 2. Guards the REAL home: `~/.wherever` (found through `os.userInfo()`, which
 *    ignores HOME) is snapshotted before the run and must be unchanged after it,
 *    or the run fails. This catches a leak on any machine, not only on a CI
 *    runner whose home happens to start empty, and also writes that land after
 *    a file's own afterAll.
 */

const REAL_HOME = os.userInfo().homedir;
const GUARDED = [path.join(REAL_HOME, '.wherever')];

/** Content-hash snapshot (not mtimes: a rewrite with identical bytes is no leak). Symlinks are recorded, not followed. */
function snapshot(dir: string): string {
  if (!fs.existsSync(dir)) return 'ABSENT';
  const entries: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) entries.push(`${prefix}${name} -> ${fs.readlinkSync(full)}`);
      else if (st.isDirectory()) {
        entries.push(`${prefix}${name}/`);
        walk(full, `${prefix}${name}/`);
      } else if (st.isFile()) {
        const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
        entries.push(`${prefix}${name}:${h}`);
      }
    }
  };
  walk(dir, '');
  return entries.join('\n');
}

export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-test-run-'));
  process.env.WHEREVER_TEST_ISOLATION_ROOT = root;
  const before = GUARDED.map((d) => [d, snapshot(d)] as const);

  return () => {
    fs.rmSync(root, { recursive: true, force: true });
    const changed = before.filter(([d, snap]) => snapshot(d) !== snap).map(([d]) => d);
    if (changed.length > 0) {
      throw new Error(
        `The test run wrote into the REAL home: ${changed.join(', ')} changed. A test (or background work it ` +
          `started) resolved a path from the real home instead of the isolated one; see server/test/setup-isolate-env.ts.`,
      );
    }
  };
}
