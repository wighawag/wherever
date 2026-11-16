import { describe, it, expect } from 'vitest';
import { findOnPath, requireBinary } from './require-binary.js';

/**
 * The fail-fast guard for suites that shell out to a system binary (e.g.
 * `openssl` in readonly-config-deployment.test.ts): a missing binary must fail
 * with ONE clear message naming it and pointing at `nix develop`, never with a
 * cryptic `spawnSync <name> ENOENT` per test, and never by silently skipping.
 */
describe('requireBinary', () => {
  it('names the missing binary and points at nix develop', () => {
    expect(() => requireBinary('wherever-no-such-binary-xyz')).toThrow(/`wherever-no-such-binary-xyz` is not on PATH/);
    expect(() => requireBinary('wherever-no-such-binary-xyz')).toThrow(/nix develop/);
  });

  it('passes for a binary that is on PATH', () => {
    expect(findOnPath('sh')).not.toBeNull();
    expect(() => requireBinary('sh')).not.toThrow();
  });

  it('looks only at the PATH it is given', () => {
    expect(findOnPath('sh', '')).toBeNull();
  });
});
