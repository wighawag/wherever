---
"wherever-dev": patch
---

Build tooling: move the build-script approval from `package.json`'s `pnpm.onlyBuiltDependencies` (no longer read by pnpm 11, which then failed `pnpm install` with `ERR_PNPM_IGNORED_BUILDS`) to `allowBuilds` in `pnpm-workspace.yaml`, which pnpm 10 and 11 both honour. Only esbuild may run its install script, as before. Also Prettier-format `web/src/lib/core/view-mode.ts` and its test, which were failing `pnpm format:check`.
