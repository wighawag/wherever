import { defineConfig } from 'vitest/config';
import { cpus } from 'node:os';

// BOUND the number of test files running at once.
//
// Most files in this suite boot a REAL server process against the fake LLM, and
// several of those spawn git children on top. Left alone, vitest forks one
// worker per core (16 on this machine), so a full run has tens of live node
// processes competing for CPU -- and the per-test timeouts all assume a fair
// share of it. The observed failure mode is not a wrong assertion but "whichever
// timing-sensitive test happens to lose the race": the same file passes in
// isolation in a fraction of its limit and times out under a full run.
//
// A guard that goes red for a reason unrelated to the property it guards teaches
// people to re-run until green, which is how a real regression gets waved
// through. So cap concurrency rather than tune timeouts file by file. This also
// makes the suite's cost predictable on a CI runner, which has far fewer cores
// than a dev box and would otherwise oversubscribe just as badly.
const MAX_TEST_WORKERS = Math.max(1, Math.min(4, cpus().length));

export default defineConfig({
  test: {
    maxWorkers: MAX_TEST_WORKERS,
    minWorkers: 1,
    // `--expose-gc` so the memory regression tests (session-transcript.test.ts)
    // can settle the heap before measuring. Without it `global.gc` is undefined
    // and those assertions would be measuring uncollected garbage rather than
    // what the reader RETAINS, which is the property that matters: the readers
    // exist so a 2 GB sessions directory costs tens of MB, not gigabytes.
    poolOptions: {
      forks: { execArgv: ['--expose-gc'] },
      threads: { execArgv: ['--expose-gc'] },
    },
  },
});
