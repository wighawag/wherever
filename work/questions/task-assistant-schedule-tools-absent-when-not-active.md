<!-- dorfl-sidecar: item=task:assistant-schedule-tools-absent-when-not-active type=task slug=assistant-schedule-tools-absent-when-not-active allAnswered=false -->

## Q1

**'task:assistant-schedule-tools-absent-when-not-active' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build:all && pnpm run -r test`; its last output was:
>
> server test:  FAIL  test/assistant-tools-server.test.ts > assistant tools (real server) > lock held by another server: no tools and no timezone line (as unset), but the CLI twins answer the lock-state error
> server test: AssertionError: expected 'held' to be 'refused' // Object.is equality
> server test: Expected: "refused"
> server test: Received: "held"
> server test:  ❯ test/assistant-tools-server.test.ts:239:61
> server test:     237|     expect((await assistantStatus(first.port)).active).toBe(true);
> server test:     238|     const second = await boot(root, 'second', { assistantFolder: folde…
> server test:     239|     expect((await assistantStatus(second.port)).lock.state).toBe('refu…
> server test:        |                                                             ^
> server test:     240|     const off = await boot(root, 'off', {});
> server test:     241|
> server test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯
> server test:  Test Files  2 failed | 91 passed (93)
> server test:       Tests  4 failed | 737 passed | 1 skipped (742)
> server test:    Start at  06:21:41
> server test:    Duration  93.43s (transform 785ms, setup 153ms, collect 9.64s, tests 315.21s, environment 9ms, prepare 2.63s)
> server test: Failed
> /tmp/dorfl-fresh-gate-sR3iXe/tip/server:
> [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] wherever-dev@0.24.0 test: `vitest run`
> Exit status 1

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
