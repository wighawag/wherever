# `session-transcript.test.ts` deep-page cost test times out under a full-suite run

2026-09-09 — noticed while running the server suite for `restore-remote-candidates`.

`readTranscriptWindow > costs the same for a deep "load older" page as for the tail` failed with "Test timed out in 5000ms" during `vitest run` of the whole `server/` suite, and passes in ~1s when that file is run alone. It looks like a wall-clock assertion competing with the other suites' spawned servers rather than a real regression. Out of scope for this task; flagged in case the timing budget should be raised or the measurement made load-independent.
