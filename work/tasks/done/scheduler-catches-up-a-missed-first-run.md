---
title: The scheduler catches up a new job's missed first run, by persisting when it first saw each job
slug: scheduler-catches-up-a-missed-first-run
blockedBy: []
covers: []
needsAnswers: false
---

## What to build

Decided (grilling 2026-10-31, Q6): reverse `assistant-scheduler` decision 4's accepted cost. Today a recurring job with no run yet measures missed runs from when THIS process first saw it (in memory), so a brand-new job whose first occurrence falls while the server is down is never caught up: "a reminder at 9:00, the server restarted at 8:59, nothing happened".

New behaviour: persist, in the STATE dir (never in `schedule.json`), when the scheduler first saw each job and when a re-enable or an edit of `cron` / `at` / `tz` reset that base. After a restart the base survives, so the normal grace rule (fire once if the latest missed run is within the grace window, else skip and record) applies to the first run too. Entries for jobs removed from `schedule.json` are pruned. A job first seen while the server was down (hand-added to the file) still starts from when it is first seen, as today.

## Requeue 2026-11-17

Gate-3 (conductor): the first gate went red ONLY on an environmental cause: server/test/readonly-config-deployment.test.ts's TLS suite reported `openssl` not on PATH in the gate process, although this branch does not touch that test or PATH handling, and the same suite passed in the four gates just before it in this drive. No code change is needed for it: do NOT change, skip or weaken that test. Re-run the gate on the kept work; only fix something if Gate 1 shows a real failure in this task's own tests.

## Requeue 2026-11-17

Conductor (2nd recovery): the gate failed again ONLY because openssl was missing from the gate's PATH. Diagnosed live: dorfl 0.15.1 spawns the gate's `bash -c` with socket stdin, so bash sources /etc/bashrc -> /etc/profile and PATH loses the nix-store openssl (work/notes/findings/bash-c-with-socket-stdin-sources-bashrc-and-resets-path.md). The re-run sets NOSYSBASHRC=1 for the gate. The code is unchanged and needs no change for this.

## Acceptance criteria

- [ ] A job seen at 8:58 with a 9:00 occurrence, server down 8:59 to 9:10: on restart it fires once; down until 11:00 (outside the 1 h grace): it is skipped and recorded (injected clock, no real timers).
- [ ] Re-enable and edits still reset the base, and the reset survives a restart.
- [ ] A one-shot `at` keeps its existing rules; `schedule.json` is never written.
- [ ] A corrupt or missing first-seen file degrades to today's behaviour with a warning, never blocking valid jobs.
- [ ] With `assistantFolder` unset, behaviour is exactly as before (guard test).
- [ ] Tests isolate `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR` in temp dirs and assert the real `~/.wherever` is untouched.
- [ ] Changeset (`"wherever-dev": patch`); `CONTEXT.md` ("The assistant scheduler") updated.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: the scheduler catches up a new job's missed first run, by persisting when it first saw each job (follow-up to spec `assistant-session-and-channels`, decided in a grilling session on 2026-10-31). The "What to build" section above is the decision; do not re-open it.
>
> Where to look: the scheduler's `seen` map and `sinceFor`, `planJob`'s `since` option, the run log and timezone state files in the state dir (follow their atomic-write pattern), the scheduler tests' injected clock.
>
> BEFORE STARTING: this task was written after the assistant drive. A separate hardening change (CLI reconnect race, symlinked `assistantFolder` canonicalisation, openssl test message, CORS DELETE) was planned on the same files. If it has merged, build on its shared folder-canonicalising helper wherever this task compares folders; if it has not, do not re-implement it, just proceed.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a premise no longer holds, route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/<slug>-decisions.md` and end your final report with a `## Decisions` block written AS the done-record section (the runner copies it verbatim into `work/tasks/done/<slug>.md`), e.g. `The non-obvious in-scope decisions (...) are recorded in [work/notes/observations/<slug>-decisions.md](../../notes/observations/<slug>-decisions.md).` Do not address the reviewer in it.
>
> `CONTEXT.md` is ~780 lines: edit it with targeted edits only, never rewrite it whole; check `git diff --stat -- CONTEXT.md` before finishing.

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```

## Decisions

The non-obvious in-scope decisions (the first-seen file's name and shape; persisting the last-seen `enabled` and time spec so an edit or re-enable made while the server was down resets the base after restart; no pruning while `schedule.json` is unreadable or an entry is invalid; the rules for a missing or corrupt file; one-shots tracked too; a `patch` bump) are recorded in [work/notes/observations/scheduler-catches-up-a-missed-first-run-decisions.md](../../notes/observations/scheduler-catches-up-a-missed-first-run-decisions.md).
