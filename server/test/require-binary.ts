import fs from 'node:fs';
import path from 'node:path';

/** The first executable called `name` on `searchPath` (default: this process's PATH), or null. */
export function findOnPath(name: string, searchPath: string = process.env.PATH ?? ''): string | null {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch {}
  }
  return null;
}

/**
 * Fail fast, with one clear message, when a suite needs a system binary that is
 * not on PATH. Call it from `beforeAll` so every test in the suite reports the
 * same reason instead of `spawnSync <name> ENOENT`. Deliberately NOT a skip: a
 * gate that lost the binary must go red, not quietly stop testing.
 */
export function requireBinary(name: string): void {
  if (findOnPath(name)) return;
  throw new Error(
    `\`${name}\` is not on PATH, and these tests shell out to it. Run them inside \`nix develop\` ` +
      `(the flake devshell provides it), or install ${name}. If it IS installed, something reset ` +
      `PATH between your shell and this process (on NixOS, a \`bash -c\` whose stdin is a socket ` +
      `sources /etc/bashrc, which resets PATH: see work/notes/findings/` +
      `bash-c-with-socket-stdin-sources-bashrc-and-resets-path.md).`,
  );
}
