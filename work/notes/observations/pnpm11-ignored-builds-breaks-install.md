# pnpm 11 `ERR_PNPM_IGNORED_BUILDS` breaks `pnpm install` and dirties pnpm-workspace.yaml

2026-10-23. With pnpm 11.25 (nix store), `pnpm install --frozen-lockfile` (dorfl's `prepare`) exits 1 with `ERR_PNPM_IGNORED_BUILDS` (esbuild, sharp, protobufjs, @google/genai, svelte-preprocess) and appends an `allowBuilds:` block of placeholder values ("set this to true or false") to `pnpm-workspace.yaml`. `pnpm format:check` then fails too, because its deps-status check re-runs that install. Seen while working on `upload-write-gate-binds-to-painted-session`; the workspace file had to be restored by hand. Likely needs an explicit `allowBuilds` (or `onlyBuiltDependencies`) decision in `pnpm-workspace.yaml`.

**Resolved (2026-10-24), duplicate:** same issue as `pnpm-11-build-fails-and-writes-allowbuilds-stub-into-workspace-yaml.md`; fixed on `main` in ccd9791 (`allowBuilds` in `pnpm-workspace.yaml`). Kept only for the history.
