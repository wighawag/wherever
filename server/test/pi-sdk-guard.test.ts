import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { piSdkInfo } from '../src/pi-sdk.ts';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('the pi SDK choice cannot be bypassed', () => {
  // A runtime import of the package anywhere but pi-sdk.ts would load the
  // BUNDLED SDK next to the chosen one: a second copy of pi's module-level
  // state, and sessions half on one SDK, half on the other. Types are fine.
  it('no server module imports SDK values except pi-sdk.ts', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      if (file === 'pi-sdk.ts') continue;
      const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
      for (const m of text.matchAll(/^\s*import\s+(?!type\b)([^;]*?)\s+from\s+['"]@earendil-works\/pi-[a-z-]+['"]/gms)) {
        // `import { type A, type B } from ...` is type-only too.
        const names = m[1].replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
        if (names.some((n) => !n.startsWith('type '))) offenders.push(`${file}: ${m[0].trim()}`);
      }
      if (/import\(\s*['"]@earendil-works\/pi-/.test(text)) offenders.push(`${file}: dynamic import of the SDK package`);
    }
    expect(offenders).toEqual([]);
  });

  // The CI job that runs this suite against another pi version sets
  // WHEREVER_PI_SDK. A refused or broken install falls back to the bundled SDK
  // (by design, so a server always starts), which would make that job pass
  // while testing nothing: fail it instead.
  it.runIf(!!process.env.WHEREVER_PI_SDK && process.env.WHEREVER_PI_SDK !== 'bundled')(
    'when WHEREVER_PI_SDK is set, the suite really runs on that SDK',
    () => {
      expect(piSdkInfo.tier, piSdkInfo.why).not.toBe('bundled');
    },
  );
});
