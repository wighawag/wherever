<!-- dorfl-sidecar: item=task:new-session-clone-via-registry type=task slug=new-session-clone-via-registry allAnswered=false -->

## Q1

**'task:new-session-clone-via-registry' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm build:all && pnpm run -r test`; its last output was:
>
> server test:    ✓ token from the environment (nothing secret in argv) > warns loudly when binding a non-loopback address with no authentication 2082ms
> server test:    ✓ TLS material at absolute paths > serves HTTPS from a key and cert given as absolute paths outside any home dir 2219ms
> server test:    ✓ TLS material at absolute paths > accepts the same pair through WHEREVER_SSL_KEY / WHEREVER_SSL_CERT 2252ms
> server test:    ✓ TLS material at absolute paths > REFUSES to start when explicitly-configured TLS material cannot be loaded 10744ms
> server test:    ✓ TLS material at absolute paths > expands ~ in the SSL paths, which a systemd Environment= line would not 2232ms
> server test:    ✓ TLS material at absolute paths > generates its self-signed pair under the STATE dir, not the real home 2130ms
> server test:    ✓ TLS material at absolute paths > warns instead of silently substituting when only one half of the pair is given 2156ms
> server test: ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
> server test:  FAIL  test/session-transcript.test.ts > readTranscriptWindow > costs the same for a deep "load older" page as for the tail
> server test: Error: Test timed out in 5000ms.
> server test: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
> server test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
> server test:  Test Files  1 failed | 27 passed (28)
> server test:       Tests  1 failed | 210 passed (211)
> server test:    Start at  11:03:29
> server test:    Duration  186.50s (transform 20.77s, setup 0ms, collect 93.94s, tests 1918.97s, environment 33ms, prepare 9.62s)
> server test: Failed
> /tmp/dorfl-fresh-gate-ywaiJv/tip/server:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  wherever-dev@0.13.0 test: `vitest run`
> Exit status 1

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
