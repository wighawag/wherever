import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

/**
 * `GET /config` `appearance`: the per-instance visual identity of the web
 * dashboard. Machines that mirror the same pi sessions over cloned folders
 * need to be told apart at a glance, so the server reports a label (defaulting
 * to the machine hostname, which differs per machine with zero config) plus
 * the accent and per-token color overrides the frontend applies as CSS
 * variables. The property under test is that /config reflects THIS server's
 * config.json, not the client's localStorage or a build-time value.
 */

let harness: Harness | undefined;
const tmpDirs: string[] = [];

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-appearance-'));
  tmpDirs.push(dir);
  return dir;
}

async function getConfig(port: number): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/config`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('/config appearance (instance identity)', () => {
  it('defaults the label to the machine hostname when appearance is unset', async () => {
    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: makeConfigDir() } });

    const appearance = (await getConfig(harness.port)).appearance;
    expect(appearance).toBeDefined();
    expect(appearance.label).toBe(os.hostname());
    expect(appearance.accent).toBeNull();
    expect(appearance.colors).toBeNull();
    // No accent -> no top frame by default, no pattern.
    expect(appearance.frame).toBe(false);
    expect(appearance.pattern).toBe('none');
  }, 60_000);

  it('serves the configured label, accent, and per-token color overrides', async () => {
    const configDir = makeConfigDir();
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        appearance: {
          label: 'desktop-ahead',
          accent: '#8b5cf6',
          pattern: 'stripes',
          colors: { brandBorder: '#123456', brandTextMuted: '#654321' },
        },
      }),
    );
    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir } });

    const appearance = (await getConfig(harness.port)).appearance;
    expect(appearance).toEqual({
      label: 'desktop-ahead',
      accent: '#8b5cf6',
      colors: { brandBorder: '#123456', brandTextMuted: '#654321' },
      // frame defaults on when an accent is set; the configured pattern is
      // passed through.
      frame: true,
      pattern: 'stripes',
    });
  }, 60_000);

  it('lets an explicit empty label opt out (exact pre-appearance look)', async () => {
    const configDir = makeConfigDir();
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ appearance: { label: '' } }),
    );
    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir } });

    const appearance = (await getConfig(harness.port)).appearance;
    expect(appearance.label).toBe('');
    expect(appearance.accent).toBeNull();
    expect(appearance.frame).toBe(false);
    expect(appearance.pattern).toBe('none');
  }, 60_000);

  it('normalizes an unknown pattern and honours an explicit frame override', async () => {
    const configDir = makeConfigDir();
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        appearance: { accent: '#8b5cf6', frame: false, pattern: 'checkerboard' },
      }),
    );
    harness = await startHarness({ env: { WHEREVER_CONFIG_DIR: configDir } });

    const appearance = (await getConfig(harness.port)).appearance;
    expect(appearance.frame).toBe(false);
    expect(appearance.pattern).toBe('none');
  }, 60_000);
});