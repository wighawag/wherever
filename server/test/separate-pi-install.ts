import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPiPackageFrom } from '../src/pi-sdk-policy.ts';

/**
 * Build a SEPARATE pi install under `dir` from the bundled SDK, offline: a real
 * COPY of the package (package.json + dist, so its modules get their own URLs
 * and load as a second, independent instance) with its dependencies symlinked
 * from the bundled package's own node_modules. That is what a user's terminal
 * pi looks like to the server, without a network install in CI.
 *
 * `version` rewrites the copy's package.json version, to exercise the version
 * policy (the code is still the bundled version's).
 *
 * Returns the directory to hand to `piSdk.source` / `WHEREVER_PI_SDK` (it holds
 * node_modules/@earendil-works/pi-coding-agent).
 */
export function makeSeparatePiInstall(dir: string, opts: { version?: string } = {}): string {
  const bundledPkg = fs.realpathSync(findPiPackageFrom(fileURLToPath(import.meta.url))!);
  // pnpm layout: the package's dependencies are its siblings in this node_modules.
  const depsDir = path.dirname(path.dirname(bundledPkg));
  const nm = path.join(dir, 'node_modules');
  fs.mkdirSync(path.join(nm, '@earendil-works'), { recursive: true });
  for (const entry of fs.readdirSync(depsDir)) {
    if (entry.startsWith('.')) continue;
    if (entry === '@earendil-works') {
      for (const scoped of fs.readdirSync(path.join(depsDir, entry))) {
        if (scoped === 'pi-coding-agent') continue;
        fs.symlinkSync(path.join(depsDir, entry, scoped), path.join(nm, entry, scoped));
      }
    } else {
      fs.symlinkSync(path.join(depsDir, entry), path.join(nm, entry));
    }
  }
  const target = path.join(nm, '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(target);
  fs.cpSync(path.join(bundledPkg, 'dist'), path.join(target, 'dist'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
  });
  const pj = JSON.parse(fs.readFileSync(path.join(bundledPkg, 'package.json'), 'utf8'));
  if (opts.version) pj.version = opts.version;
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pj, null, 2));
  return dir;
}
