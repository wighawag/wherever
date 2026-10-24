import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PI_SDK_FLOOR,
  TESTED_PI_RANGE,
  decidePiSdkVersion,
  discoverPathPi,
  effectivePiSdkConfig,
  resolvePiSdkPath,
} from '../src/pi-sdk-policy.ts';

// Which pi SDK the server runs on: the version tiers, the config/env merge, and
// finding a pi install from a path or from the `pi` on PATH (a symlinked npm
// bin, a Nix-style shell wrapper, or a standalone binary that has no package).

let root: string;

function fakePiPackage(dir: string, version = '1.4.0'): string {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
  fs.writeFileSync(path.join(dir, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(dir, 'dist', 'cli.js'), 0o755);
  return dir;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-pi-sdk-policy-')));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('version tiers', () => {
  it('uses a tested version, with no opt-in needed', () => {
    expect(decidePiSdkVersion('1.4.0')).toMatchObject({ use: true, tier: 'tested' });
    expect(TESTED_PI_RANGE).toContain('1.4.0');
  });

  it('refuses an untested version by default, and says how to opt in', () => {
    const v = decidePiSdkVersion('1.3.0');
    expect(v).toMatchObject({ use: false, tier: 'untested' });
    expect(v.why).toMatch(/allowUntested|accept/);
    expect(decidePiSdkVersion('1.5.0')).toMatchObject({ use: false, tier: 'untested' });
    expect(decidePiSdkVersion('2.0.0')).toMatchObject({ use: false, tier: 'untested' });
  });

  it('allowUntested accepts any version at or above the floor', () => {
    for (const v of [PI_SDK_FLOOR, '1.3.0', '1.5.0', '2.0.0']) {
      expect(decidePiSdkVersion(v, { allowUntested: true })).toMatchObject({ use: true, tier: 'untested' });
    }
  });

  it('an accept range admits only what it matches (prereleases included)', () => {
    expect(decidePiSdkVersion('1.3.0', { accept: '>=1.2 <2' })).toMatchObject({ use: true, tier: 'untested' });
    expect(decidePiSdkVersion('1.5.0-beta.1', { accept: '>=1.2 <2' })).toMatchObject({ use: true });
    expect(decidePiSdkVersion('2.0.0', { accept: '>=1.2 <2' })).toMatchObject({ use: false });
    expect(decidePiSdkVersion('1.3.0', { accept: 'not a range' }).why).toMatch(/not a valid semver range/);
  });

  it('never uses a version below the floor, whatever the opt-in', () => {
    for (const policy of [{}, { allowUntested: true }, { accept: '*' }]) {
      expect(decidePiSdkVersion('0.80.6', policy)).toMatchObject({ use: false, tier: 'incompatible' });
    }
    expect(decidePiSdkVersion('garbage')).toMatchObject({ use: false, tier: 'incompatible' });
  });
});

describe('config', () => {
  it('reads piSdk from config.json, and the env overrides it field by field', () => {
    const file = { source: 'auto', allowUntested: true, accept: '>=1.2' };
    expect(effectivePiSdkConfig(file, {})).toEqual(file);
    expect(effectivePiSdkConfig(file, { WHEREVER_PI_SDK: '/x', WHEREVER_PI_SDK_ALLOW_UNTESTED: '0' })).toEqual({
      source: '/x',
      allowUntested: false,
      accept: '>=1.2',
    });
    expect(effectivePiSdkConfig(undefined, { WHEREVER_PI_SDK_ACCEPT: '>=1.3', WHEREVER_PI_SDK_ALLOW_UNTESTED: 'true' })).toEqual({
      source: undefined,
      allowUntested: true,
      accept: '>=1.3',
    });
    // Junk is ignored, not trusted.
    expect(effectivePiSdkConfig({ source: 42, allowUntested: 'yes' }, {})).toEqual({ source: undefined, allowUntested: false, accept: undefined });
  });
});

describe('finding an install', () => {
  it('accepts the package dir, a dir holding node_modules/…, or a global prefix (lib/node_modules/…)', () => {
    const pkg = fakePiPackage(path.join(root, 'p1', 'node_modules', '@earendil-works', 'pi-coding-agent'));
    expect(resolvePiSdkPath(pkg).root).toBe(pkg);
    expect(resolvePiSdkPath(path.join(root, 'p1')).root).toBe(pkg);
    const global = fakePiPackage(path.join(root, 'prefix', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'));
    expect(resolvePiSdkPath(path.join(root, 'prefix')).root).toBe(global);
    expect(resolvePiSdkPath(path.join(root, 'nothing-here')).root).toBeUndefined();
  });

  function pathWith(binDir: string): NodeJS.ProcessEnv {
    return { ...process.env, PATH: `${binDir}:/usr/bin:/bin` };
  }

  it('auto: follows a symlinked bin (npm global install)', () => {
    const pkg = fakePiPackage(path.join(root, 'npm', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'));
    const bin = path.join(root, 'npm', 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(pkg, 'dist', 'cli.js'), path.join(bin, 'pi'));
    expect(discoverPathPi(pathWith(bin)).root).toBe(pkg);
  });

  it('auto: reads a shell wrapper for the script it runs (Nix makeWrapper)', () => {
    const pkg = fakePiPackage(path.join(root, 'nix-store', 'pi-1.4.0', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'));
    const bin = path.join(root, 'nix-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pi'), `#! /bin/sh -e\nexec "/usr/bin/node"  ${pkg}/dist/cli.js "$@"\n`);
    fs.chmodSync(path.join(bin, 'pi'), 0o755);
    expect(discoverPathPi(pathWith(bin)).root).toBe(pkg);
  });

  it('auto: a pi that is not a node package (standalone binary) yields no install, with the reason', () => {
    const bin = path.join(root, 'standalone-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pi'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]));
    fs.chmodSync(path.join(bin, 'pi'), 0o755);
    const found = discoverPathPi(pathWith(bin));
    expect(found.root).toBeUndefined();
    expect(found.how).toMatch(/standalone/);
  });

  it('auto: no pi on PATH', () => {
    const empty = path.join(root, 'empty-bin');
    fs.mkdirSync(empty);
    expect(discoverPathPi({ ...process.env, PATH: empty }).how).toMatch(/no `pi` on PATH/);
  });
});
