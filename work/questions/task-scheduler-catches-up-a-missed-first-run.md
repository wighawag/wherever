<!-- dorfl-sidecar: item=task:scheduler-catches-up-a-missed-first-run type=task slug=scheduler-catches-up-a-missed-first-run allAnswered=false -->

## Q1

**'task:scheduler-catches-up-a-missed-first-run' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build:all && pnpm run -r test`; its last output was:
>
> server test: ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
> server test:  FAIL  test/readonly-config-deployment.test.ts > TLS material at absolute paths
> server test: Error: `openssl` is not on PATH, and these tests shell out to it. Run them inside `nix develop` (the flake devshell provides it), or install openssl. If it IS installed, something reset PATH between your shell and this process (on NixOS, a `bash -c` whose stdin is a socket sources /etc/bashrc, which resets PATH: see work/notes/findings/bash-c-with-socket-stdin-sources-bashrc-and-resets-path.md).
> server test:  ❯ Module.requireBinary test/require-binary.ts:25:9
> server test:      23| export function requireBinary(name: string): void {
> server test:      24|   if (findOnPath(name)) return;
> server test:      25|   throw new Error(
> server test:        |         ^
> server test:      26|     `\`${name}\` is not on PATH, and these tests shell out to it. Run …
> server test:      27|       `(the flake devshell provides it), or install ${name}. If it IS …
> server test:  ❯ test/readonly-config-deployment.test.ts:566:19
> server test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
> server test:  Test Files  1 failed | 94 passed (95)
> server test:       Tests  763 passed | 7 skipped (770)
> server test:    Start at  07:34:02
> server test:    Duration  94.76s (transform 841ms, setup 148ms, collect 9.19s, tests 318.24s, environment 9ms, prepare 2.53s)
> server test: Failed
> /tmp/dorfl-fresh-gate-2cQdjV/tip/server:
> [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] wherever-dev@0.24.0 test: `vitest run`
> Exit status 1

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
