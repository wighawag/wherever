---
'wherever-dev': patch
---

Fix the web unit suite failing to resolve `$lib` imports.

`web/vitest.config.ts` is a standalone config that deliberately does not load the SvelteKit vite plugin, so nothing registered the `$lib` alias. This went unnoticed until `src/lib/session-store.ts` gained an `import ... from '$lib/theme'`, which put an aliased specifier on a module the tests actually load, breaking all 6 tests in `session-store.test.ts` and `remote-candidates.test.ts`.

The alias is now registered directly in the vitest config, keeping the no-plugin property intact. Its target is read from SvelteKit's own `svelte-kit sync` output rather than hardcoded as `src/lib`, so it cannot drift from what SvelteKit resolves `$lib` to if `kit.files.lib` is ever changed.
