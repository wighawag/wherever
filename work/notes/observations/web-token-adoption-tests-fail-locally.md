# web token-adoption tests fail on a clean checkout (2026-11-24)

`web/src/lib/core/token-adoption.test.ts` ("getConfig() adoption wiring", 5 tests) fails in `pnpm --filter ./web test` with and without the closed-sessions changes, seen while working on `closed-sessions-store-and-endpoint`. Not investigated.
