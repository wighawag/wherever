import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-test-file isolation, run before each test file loads (vitest
 * `setupFiles`). Every file starts from the environment a clean CI runner has:
 *
 * - HOME is a fresh temp dir of its own, under the run's root from
 *   `global-setup.ts`. `os.homedir()` follows HOME, so `~/.wherever`,
 *   `~/.pi/agent` and every other home-relative default resolve there.
 * - `WHEREVER_CONFIG_DIR`, `WHEREVER_STATE_DIR` and `PI_CODING_AGENT_DIR` are
 *   UNSET, so they fall back to that temp HOME, exactly as on CI. A shell inside
 *   a wherever session inherits them from the unit (`/run/wherever`,
 *   `/var/lib/wherever`), which used to hide leaks locally and could point a
 *   test at the live server's state.
 *
 * Why the baseline matters: a test that saves an env var, overrides it and
 * restores it in afterAll now restores THIS isolated value, so background work
 * that finishes late (the leak this was added for: a session-index warm-up that
 * seeded a default config.json) lands in the temp tree, not in a real home.
 *
 * Test files that snapshot "the real ~/.wherever" with `os.homedir()` now watch
 * this per-file home; the real one is guarded once for the whole run in
 * `global-setup.ts`.
 */

const root = process.env.WHEREVER_TEST_ISOLATION_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-test-run-'));
fs.mkdirSync(root, { recursive: true });
const home = fs.mkdtempSync(path.join(root, 'home-'));

process.env.HOME = home;
delete process.env.WHEREVER_CONFIG_DIR;
delete process.env.WHEREVER_STATE_DIR;
delete process.env.PI_CODING_AGENT_DIR;
// kenning's database (`KENNING_STATE_DIR`, else `$XDG_STATE_HOME/kenning`) is
// shared by every pi process on the machine, so a server under test must never
// open the developer's real one: point it into this file's home. A test that
// wants a kenning database creates it there (or sets its own dir).
process.env.KENNING_STATE_DIR = path.join(home, '.local', 'state', 'kenning');
