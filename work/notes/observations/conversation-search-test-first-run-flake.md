# conversation-search.test.ts flaked once on a first run (2026-11-24)

On the very first `vitest run test/conversation-search.test.ts` in a fresh worktree (right after `pnpm install`), the first two tests failed: the not-indexed test got `index.path` under the isolated HOME's default `~/.local/share/memonaut/index.db` instead of the fixture's `MEMONAUT_DB`, as if the spawned server did not see the fixture env. Every later run (whole file, twice, and the test alone, twice) passed. Not investigated; possibly cold tsx/first-boot timing in `test/harness.ts`.
