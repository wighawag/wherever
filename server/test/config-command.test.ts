import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `wherever config init` / `wherever config show` (ADR 0022), driven through the
 * real CLI entry. Every run gets a temp HOME and a temp WHEREVER_CONFIG_DIR, so
 * nothing here can touch a real home or config dir.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const serverEntry = process.env.WHEREVER_SERVER_ENTRY ?? path.resolve(serverDir, 'src/index.ts');
const tsxBin = process.env.WHEREVER_TSX_BIN ?? path.resolve(serverDir, 'node_modules/.bin/tsx');

const SEEDED_DEFAULTS = { gitInitDefault: false, remoteRepoRules: [], commonFolders: [] };

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wherever-${prefix}-`)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function cli(args: string[], configDir: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(tsxBin, [serverEntry, ...args], {
    cwd: serverDir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmpDir('home'),
      WHEREVER_CONFIG_DIR: configDir,
      WHEREVER_STATE_DIR: '',
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('wherever config init', () => {
  it('writes the built-in defaults, creating the dir, and reports the path', () => {
    const configDir = path.join(tmpDir('cfg'), 'nested', 'wherever');
    const file = path.join(configDir, 'config.json');
    const r = cli(['config', 'init'], configDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(SEEDED_DEFAULTS);
    // Pretty-printed, like the old seed.
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(SEEDED_DEFAULTS, null, 2) + '\n');
  }, 60_000);

  it('refuses to overwrite an existing file: non-zero exit, file byte-identical', () => {
    const configDir = tmpDir('cfg');
    const file = path.join(configDir, 'config.json');
    expect(cli(['config', 'init'], configDir).status).toBe(0);
    // A user edit since: init must not undo it.
    fs.writeFileSync(file, '{"commonFolders":["~/dev"]}');
    const before = fs.readFileSync(file);
    const r = cli(['config', 'init'], configDir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(file);
    expect(r.stderr).toMatch(/already exists/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  }, 60_000);
});

describe('wherever config show', () => {
  it('shows the path, that no file exists, and the defaults, writing nothing', () => {
    const root = tmpDir('cfg');
    const configDir = path.join(root, 'absent');
    const r = cli(['config', 'show'], configDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(path.join(configDir, 'config.json'));
    expect(r.stdout).toMatch(/not found/);
    const json = r.stdout.slice(r.stdout.indexOf('{'));
    expect(JSON.parse(json)).toEqual(SEEDED_DEFAULTS);
    expect(fs.readdirSync(root)).toEqual([]);
  }, 60_000);

  it('shows the file\'s effective config with credential values redacted', () => {
    const configDir = tmpDir('cfg');
    const file = path.join(configDir, 'config.json');
    const TELEGRAM = '123456:telegram-bot-secret-xyz';
    const REMOTE = 'remote-bridge-secret-abc';
    fs.writeFileSync(
      file,
      JSON.stringify({
        commonFolders: ['~/dev'],
        assistantTelegram: { enabled: true, token: TELEGRAM, userId: 42 },
        remote: { host: '127.0.0.1', token: REMOTE },
      }),
    );
    const r = cli(['config', 'show'], configDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(file);
    expect(r.stdout).toMatch(/\(found\)/);
    expect(r.stdout).toMatch(/redacted/);
    expect(r.stdout).not.toContain(TELEGRAM);
    expect(r.stdout).not.toContain(REMOTE);
    const shown = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(shown).toEqual({
      commonFolders: ['~/dev'],
      assistantTelegram: { enabled: true, token: '<redacted>', userId: 42 },
      remote: { host: '127.0.0.1', token: '<redacted>' },
    });
  }, 60_000);

  it('exits non-zero for a file that is not valid JSON', () => {
    const configDir = tmpDir('cfg');
    fs.writeFileSync(path.join(configDir, 'config.json'), '{ not json');
    const r = cli(['config', 'show'], configDir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not valid JSON/);
  }, 60_000);
});

describe('wherever config usage', () => {
  it('prints usage and exits non-zero for a bare or unknown subcommand', () => {
    const configDir = path.join(tmpDir('cfg'), 'absent');
    for (const args of [['config'], ['config', 'bogus']]) {
      const r = cli(args, configDir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/wherever config init/);
      expect(r.stderr).toMatch(/wherever config show/);
    }
    expect(fs.existsSync(configDir)).toBe(false);
  }, 60_000);

  it('lists both verbs in `wherever help`', () => {
    const r = cli(['help'], path.join(tmpDir('cfg'), 'absent'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/wherever config init/);
    expect(r.stdout).toMatch(/wherever config show/);
  }, 60_000);
});
