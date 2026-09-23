# The test harness reads and WRITES the operator's live drafts, via an inherited `WHEREVER_STATE_DIR`

**Observed:** 2026-09-23, while running the full server suite during the unix-socket work. 8 tests in `test/drafts.test.ts` failed against an unmodified tree, and the assertion diffs contained the operator's REAL drafts, including a day-old one naming a `my-boxes` session.

## What happens

`getWhereverStateDir()` (`src/session-pool.ts`) prefers `WHEREVER_STATE_DIR` and only falls back to the config dir:

```ts
const override = process.env.WHEREVER_STATE_DIR;
return override && override.trim() ? path.resolve(override.trim()) : getWhereverConfigDir();
```

`test/harness.ts` isolates `WHEREVER_CONFIG_DIR` (with a comment explaining why) but never mentions `WHEREVER_STATE_DIR`, and it spreads `...process.env` into the child. Drafts live in the STATE dir, so the isolation misses them entirely.

That is harmless on a developer laptop where the variable is unset. It is not harmless **when the suite is run from inside a wherever session**, which is the normal way this project is now worked on: the NixOS unit sets `WHEREVER_STATE_DIR=/var/lib/wherever`, agent sessions are hosted IN-PROCESS by that server, so every descendant shell inherits it. Measured in such a session:

```
$ echo $WHEREVER_STATE_DIR
/var/lib/wherever
$ echo $WHEREVER_CONFIG_DIR
/run/wherever
```

The harness server therefore resolves its state to `/var/lib/wherever` and operates on `/var/lib/wherever/drafts.json`, the live one behind the operator's own dashboard.

## It is a WRITE, not just a read

The failures are the visible half and the benign half. The invisible half is that `addDraft` appended four test drafts to the live file, which then showed up in the operator's actual UI:

```
2026-09-23T13:32:35Z | "same text"
2026-09-23T13:32:35Z | "other"
2026-09-23T13:32:34Z | "precious"
2026-09-23T13:32:31Z | "survive me"
2026-09-22T13:12:11Z | "I did `What is left, and it needs root` ..."   <- the real one
```

The deletion tests are the dangerous shape rather than these: they delete by id and happened to delete only their own, but nothing in the design confines them to it.

## Why `readonly-config-deployment.test.ts` passes

Because it neutralises the variable explicitly, in a block that lists every channel one by one:

```ts
WHEREVER_STATE_DIR: '',
```

So the repo already knows the rule; the harness is the one place that does not apply it. Any suite built on `startHarness` inherits the gap, which is most of them. `drafts.test.ts` is simply the one that stores its data in the state dir and therefore notices.

## The fix

One line in `test/harness.ts`, alongside the `WHEREVER_CONFIG_DIR` isolation it already does, applied 2026-09-23. Note the ordering constraint: the harness spreads `...(opts?.env ?? {})` last, so a caller can still point the state dir wherever a test needs it.

The deeper lesson is the one worth keeping: **this project is now developed from inside an instance of itself**, so the ambient environment is no longer a neutral laptop shell. It carries the production server's own configuration, and any test that forgets one variable inherits production rather than a default. The neutralising block in `readonly-config-deployment.test.ts` is the pattern; it should not have to be repeated per-suite.
