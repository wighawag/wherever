<!-- dorfl-sidecar: item=task:live-strip-two-line-rows type=task slug=live-strip-two-line-rows allAnswered=false -->

## Q1

**'task:live-strip-two-line-rows' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build:all && pnpm run -r test`; its last output was:
>
> server test: Error: connect ECONNREFUSED 127.0.0.1:21001
> server test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯
> server test:  FAIL  test/restore-clone-panel.test.ts > restoring a missing folder from the panel > cancels a running clone, cleans up the folder it created, and offers to restore again
> server test: Error: timeout waiting for message; saw: connected, shipmates_update, session_created, message_history, folder_missing, restore_rejected, sessions_updated
> server test:  ❯ Timeout._onTimeout test/harness.ts:354:13
> server test:     352|         () =>
> server test:     353|           reject(
> server test:     354|             new Error(
> server test:        |             ^
> server test:     355|               `timeout waiting for message; saw: ${this.messages.map((…
> server test:     356|             ),
> server test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯
> server test:  Test Files  3 failed | 103 passed (106)
> server test:       Tests  3 failed | 889 passed | 1 skipped (893)
> server test:    Start at  08:52:03
> server test:    Duration  142.20s (transform 1.09s, setup 254ms, collect 13.78s, tests 492.23s, environment 13ms, prepare 3.60s)
> server test: Failed
> /tmp/dorfl-fresh-gate-hxFAPX/tip/server:
> [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] wherever-dev@0.29.0 test: `vitest run`
> Exit status 1

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
