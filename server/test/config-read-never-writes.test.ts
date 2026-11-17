import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWhereverConfig } from '../src/session-pool.ts';
import { defaultWhereverConfig, getWhereverConfigPath } from '../src/config-dir.ts';

/**
 * ADR 0022: reading the config never writes it. A missing config.json means the
 * built-in defaults and creates nothing (no file, no directory, no warning),
 * however many times it is read. Every config dir here is a temp dir; the
 * suite's setup file already gives this file a temp HOME.
 */

// The values the seed used to write (pinned: changing a default is a decision,
// not a side effect of this refactor).
const SEEDED_DEFAULTS = { gitInitDefault: false, remoteRepoRules: [], commonFolders: [] };

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const savedConfigDir = process.env.WHEREVER_CONFIG_DIR;
const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-cfg-read-')));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (savedConfigDir === undefined) delete process.env.WHEREVER_CONFIG_DIR;
  else process.env.WHEREVER_CONFIG_DIR = savedConfigDir;
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.chmodSync(d, 0o700);
    } catch {}
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('getWhereverConfig with no config.json', () => {
  it('returns the built-in defaults and creates neither the dir nor its parent', () => {
    const root = tmpDir();
    const parent = path.join(root, 'parent');
    process.env.WHEREVER_CONFIG_DIR = path.join(parent, 'config');
    for (let i = 0; i < 5; i++) expect(getWhereverConfig()).toEqual(SEEDED_DEFAULTS);
    expect(fs.existsSync(parent)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('pins the defaults to what the old seed wrote', () => {
    expect(defaultWhereverConfig()).toEqual(SEEDED_DEFAULTS);
  });

  it('hands out a fresh defaults object per read, so a caller mutating it changes nothing', () => {
    process.env.WHEREVER_CONFIG_DIR = path.join(tmpDir(), 'absent');
    const first = getWhereverConfig();
    first.commonFolders!.push('/x');
    expect(getWhereverConfig()).toEqual(SEEDED_DEFAULTS);
  });

  it.skipIf(isRoot)('logs nothing for a read-only config dir without a file', () => {
    const dir = tmpDir();
    fs.chmodSync(dir, 0o500);
    process.env.WHEREVER_CONFIG_DIR = dir;
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    expect(getWhereverConfig()).toEqual(SEEDED_DEFAULTS);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('getWhereverConfig with a config.json', () => {
  it('reads an existing file and never rewrites it', () => {
    const dir = tmpDir();
    process.env.WHEREVER_CONFIG_DIR = dir;
    const file = getWhereverConfigPath();
    expect(file).toBe(path.join(dir, 'config.json'));
    // A previously seeded file (old defaults, no trailing newline) stays as is.
    const bytes = JSON.stringify(SEEDED_DEFAULTS, null, 2);
    fs.writeFileSync(file, bytes);
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);
    expect(getWhereverConfig()).toEqual(SEEDED_DEFAULTS);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(fs.statSync(file).mtime.getTime()).toBe(past.getTime());
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('keeps today\'s behaviour for an unparseable file: logged, empty config', () => {
    const dir = tmpDir();
    process.env.WHEREVER_CONFIG_DIR = dir;
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getWhereverConfig()).toEqual({});
    expect(error).toHaveBeenCalledWith('Failed to parse wherever config file:', expect.anything());
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe('{ not json');
  });
});
