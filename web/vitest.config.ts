import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';

// Standalone vitest config that deliberately does NOT load the SvelteKit vite
// plugin (vite.config.ts). These are fast, pure-TS unit tests for the app's
// framework-agnostic logic (e.g. src/lib/core/*). Loading the SvelteKit plugin
// would spin up a dev-server pipeline we do not need and pulls in a conflicting
// vite version. Component-level tests (if added later) would use their own
// jsdom + svelte setup.

// Not loading the plugin also means nothing teaches vite about `$lib`, which is
// how this codebase imports across src/lib everywhere (session-store.ts ->
// $lib/theme, src/lib/core/utils/web/path.ts -> $lib/core/config, ...). So the
// alias is registered here instead: the suite keeps its no-plugin property and
// still resolves the repo's normal import style, rather than the tests dictating
// that src/lib must import itself by relative path.
//
// The target is READ FROM SvelteKit's own `svelte-kit sync` output instead of
// being spelled out again as 'src/lib', because `$lib` is configurable
// (kit.files.lib): a literal here would be a second source of truth that keeps
// passing while pointing at the wrong directory the day someone moves it. That
// generated file is already a hard prerequisite of this suite -- web/tsconfig.json
// extends it, so without it every test file fails to transform -- and `prepare`
// runs `svelte-kit sync`, so depending on it adds no new setup step.
const svelteKitDir = fileURLToPath(new URL('./.svelte-kit/', import.meta.url));
let libTarget: string | undefined;
try {
	const generated = JSON.parse(
		readFileSync(resolve(svelteKitDir, 'tsconfig.json'), 'utf8'),
	);
	libTarget = generated.compilerOptions?.paths?.$lib?.[0];
} catch {
	// Fall through to the same message as a present-but-unusable file: from the
	// caller's side "never synced" and "synced into something unexpected" have
	// one fix, and guessing src/lib instead would resurrect the drift this
	// whole indirection exists to prevent.
}
if (!libTarget) {
	throw new Error(
		"Could not read the '$lib' path from web/.svelte-kit/tsconfig.json, " +
			'which this suite needs in order to resolve $lib imports. ' +
			'Run `pnpm --filter ./web exec svelte-kit sync` and try again.',
	);
}
// Paths in the generated tsconfig are relative to that file, not to the project.
const lib = resolve(svelteKitDir, libTarget);

export default defineConfig({
	resolve: {
		// Two entries, not one prefix match, so a future `$libsomething` specifier
		// cannot be silently swallowed by a loose `$lib` alias.
		alias: [
			{find: /^\$lib$/, replacement: lib},
			{find: /^\$lib\//, replacement: `${lib}/`},
		],
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
});
