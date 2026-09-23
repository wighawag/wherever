# `pnpm build` fails under pnpm 11 AND mutates `pnpm-workspace.yaml`

**Observed:** 2026-09-22, while building `web/` for the Capacitor spike (`work/tasks/backlog/capacitor-webview-socket-spike.md`). Not investigated further; recorded because it is a trap with a second-order consequence.

## What happens

`cd web && pnpm build` never reaches vite. pnpm 11.25.0 runs a deps-status check which runs `pnpm install`, and that fails:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @google/genai@1.52.0, esbuild@0.20.2,
  esbuild@0.21.5, esbuild@0.27.7, esbuild@0.28.0, protobufjs@7.6.0, sharp@0.33.5,
  svelte-preprocess@5.1.4
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
[ERROR] Command failed with exit code 1: pnpm install
```

pnpm also warns that the `"pnpm"` field in `package.json` is no longer read and that `pnpm.onlyBuiltDependencies` was IGNORED, which is the underlying cause: the repo's existing approval lives in a location this pnpm version no longer honours.

`./node_modules/.bin/vite build` works fine, so this is purely the pnpm wrapper, not the build.

## The part that matters more: it WRITES to a tracked file

The failed install appended a placeholder block to `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@google/genai': set this to true or false
  esbuild: set this to true or false
  protobufjs: set this to true or false
  sharp: set this to true or false
  svelte-preprocess: set this to true or false
```

Note the values are the literal string `set this to true or false`, i.e. a stub that is not valid configuration and that a distracted person could easily commit. It was reverted with `git checkout pnpm-workspace.yaml`.

**Why this is worse than an annoyance:** `pnpm-workspace.yaml` is in `package.nix`'s `topLevelAllowed` source allowlist. A modified copy therefore changes the derivation's `src`, hence the store path, for a file nobody edited on purpose. Combined with the fact that a stale `pnpmDepsHash` does not fail a warm build (`nix/check-pnpm-deps-hash.sh`), an accidentally-committed stub is exactly the shape of change that is easy to make and hard to notice.

## Not fixed here

The fix is presumably migrating `pnpm.onlyBuiltDependencies` from `package.json` to whatever pnpm 11 reads (the `allowBuilds` key it is trying to write, with real booleans), then regenerating `pnpmDepsHash` if the lockfile moves. That is a maintenance decision with a Nix consequence, not a thing to slip into an unrelated spike, so it is recorded rather than done.

**Workaround meanwhile:** invoke the tool directly (`./node_modules/.bin/vite build`) and check `git status` afterwards.
