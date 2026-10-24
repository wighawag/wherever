# The dorfl acceptance gate cannot pass on `main` (pnpm 11 prepare, and `format:check` is red)

**Observed:** 2026-10-23, during an unattended `drive-tasks` run over the ws-liveness-hardening / resumable-chunked-uploads / instant-resume-from-cached-conversation backlog. Every `dorfl do` built its task, committed, pushed the `work/task-<slug>` branch, then failed the gate at `prepare` and was marked stuck. Not fixed here: both causes are outside every task's scope and are maintenance decisions.

## Blocker 1: `prepare` (`pnpm install --frozen-lockfile`) exits 1 under pnpm 11.25

Same root cause as `pnpm-11-build-fails-and-writes-allowbuilds-stub-into-workspace-yaml.md` (and the duplicate note `pnpm11-ignored-builds-breaks-install.md` that the `upload-write-gate-binds-to-painted-session` build agent wrote on its branch): `pnpm.onlyBuiltDependencies` in the root `package.json` is no longer read, so the install fails with `ERR_PNPM_IGNORED_BUILDS` (esbuild, sharp, protobufjs, @google/genai, svelte-preprocess).

New data point: `pnpm_config_strict_dep_builds=false` in the environment makes the same install exit 0 (scripts stay ignored, as before for everything except esbuild), and with it the full `verify` passes. Note the `npm_config_` spelling does NOT work under pnpm 11; only `pnpm_config_` does. It still writes the `allowBuilds: ... set this to true or false` stub into `pnpm-workspace.yaml`, so it is a diagnostic lever, not a fix. The real fix is still to move the build-script approval into `pnpm-workspace.yaml` (`allowBuilds` with real booleans) and recheck `pnpmDepsHash`.

## Blocker 2: `pnpm format:check` is red on `origin/main` itself

`web/src/lib/core/view-mode.ts` and `web/src/lib/core/view-mode.test.ts` (last touched by `8acafe0 fix(web,client): upload give-up rules and no retry loop on a dead session hash`) are not Prettier-formatted (two `if (...) return ...;` lines over the print width). Because `verify` starts with `pnpm format:check`, every task's gate goes red on these two files even after blocker 1 is cleared, whatever the task's own diff. `npx prettier --write` on the two files fixes it (whitespace only).

## Evidence that the built branches are good

In a throwaway clone, with `pnpm_config_strict_dep_builds=false` and the two files above formatted (neither committed), `pnpm format:check && pnpm build:all && pnpm run -r test` was green on each of the four stuck branches: `work/task-server-reaper-tolerates-a-missed-pong`, `work/task-upload-write-gate-binds-to-painted-session`, `work/task-client-liveness-probes-before-teardown`, `work/task-conversation-cache-indexeddb-module`. `nix/check-pnpm-deps-hash.sh` also passes on the conversation-cache branch (its lockfile change came with a regenerated `pnpmDepsHash`).

## Resolved (2026-10-24)

Fixed on `main`: build-script approval moved to `allowBuilds` in `pnpm-workspace.yaml` (esbuild `true`, the rest `false`) and the dead `pnpm` field removed from `package.json`; verified under pnpm 11.25 (gate `prepare` + `verify` green, no stub written) and pnpm 10.34.5 (esbuild postinstall runs, nothing ignored); `pnpmDepsHash` unchanged (`nix/check-pnpm-deps-hash.sh` OK). The two `view-mode` files were Prettier-formatted in the same commit. See CONTEXT.md (the paragraph after `pnpmDepsHash`).
