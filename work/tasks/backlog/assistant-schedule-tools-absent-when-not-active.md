---
title: Assistant schedule tools are absent on a server whose assistant is not active
slug: assistant-schedule-tools-absent-when-not-active
blockedBy: []
covers: []
needsAnswers: true
---

## What to build

Today the four schedule tools (`assistant_schedule_add`, `assistant_schedule_list`, `assistant_schedule_remove`, `assistant_set_timezone`) are registered in every server session whenever `assistantFolder` is CONFIGURED, and on a server refused by another server's folder lock they only answer a lock-state error (`assistant-schedule-tools-server` decision 4). Decided (grilling 2026-10-31, Q4): align with `assistant_notify` and the CLI twins, so a server whose assistant is NOT active (lock `refused` or `error`) registers none of these tools and adds no timezone line. A refused server is a misconfiguration already reported loudly in the log and status; tools that can only fail add prompt noise and invite retries.

Keep the existing behaviour for the short boot window where the assistant IS active but the scheduler has not started yet (the tools answer "still starting"), and keep the CLI twin ops answering the lock-state error for a state change after activation (a twin cannot be hidden server-side). This reverses the acceptance criterion "With the lock held by another server, the tools return a clear lock-state error" of `work/tasks/done/assistant-schedule-tools-server.md`; say so in the decisions note.

## Requeue 2026-11-17

Gate-3 (conductor): the implementation is approved as is; the gate went red for a TEST-HARNESS bug, not this task's code. Diagnosis, reproduced in a scratch clone: the full server suite fails 3/3 on this branch, both failing files pass alone, and main passes. server/test/free-port.ts keys its port band on process.env.VITEST_WORKER_ID, but in vitest 2.1.9 that id is ++id per test FILE (1..93 over a run), so `(workerId - 1) % 12` puts concurrently running files 12 ids apart in the SAME band. The bind-probe-then-spawn window lasts the whole child startup, so two files get the same port and one test's requests reach another file's server (here the 'second' server reports lock 'held' because /config is answered by another file's active server). Fix exactly this root cause: key the band on process.env.VITEST_POOL_ID (bounded 1..maxWorkers, unique among concurrently running workers), falling back to VITEST_WORKER_ID only if POOL_ID is unset, and update the comment block to say why (WORKER_ID is per file, not per concurrent slot). With that one change the full suite passed 2/2 in the scratch clone. Do NOT relax any assertion, add retries or raise timeouts. Record it as an extra item in the decisions note and the done record's Decisions section. Also fix one nit: the new comment in server/src/index.ts says the boot-window tools answer "not active", but the code answers "the assistant scheduler is still starting", so make the comment say "still starting".

## Acceptance criteria

- [ ] On a server refused by the folder lock, server sessions have none of the four schedule tools and no timezone line; tools, extension factories and system prompt are identical to an unset server (test).
- [ ] An active server is unchanged: the tools are registered in every server session and the timezone line still applies in the folder and `jobs/`.
- [ ] CLI twin ops on a configured-but-not-active server still answer the lock-state error.
- [ ] With `assistantFolder` unset, behaviour is exactly as before (guard test).
- [ ] Tests isolate `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR` in temp dirs and assert the real `~/.wherever` is untouched.
- [ ] Changeset (`"wherever-dev": patch`); `CONTEXT.md` ("The assistant tools and the timezone line") updated.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: assistant schedule tools are absent on a server whose assistant is not active (follow-up to spec `assistant-session-and-channels`, decided in a grilling session on 2026-10-31). The "What to build" section above is the decision; do not re-open it.
>
> Where to look: server start wiring of the assistant session hooks (`setAssistantSessionHooks`), `composeServerAgentParts` / `assistantSessionParts`, `assistantNotActiveError`, the existing real-server test for the lock-refused case in the assistant tools tests.
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
