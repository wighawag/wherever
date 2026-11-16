---
title: Messages dropped from the assistant session are shown in the web, not only on channels
slug: web-sees-messages-dropped-from-the-assistant-session
blockedBy: [retired-assistant-session-is-read-only]
covers: []
---

## What to build

Decided (grilling 2026-10-31, Q5): keep the rule that an abort or reset of the assistant session drops pi's queued messages (`assistant-scheduler` decision 10), but make every drop VISIBLE. Today the channel dispatcher reports each dropped text to the channel of its routing origin, and web-origin (`none`) drops are reported to nobody, so a web user who pressed stop with a steer queued never learns it was discarded.

New behaviour: when the controller records dropped messages, the web viewers of that session get a notice listing the dropped web-origin texts (e.g. "Stopped before it read: ..."), and the dropped messages disappear from the queued-steer UI consistently (they must not stay shown as pending). Scheduler-origin drops are recorded in the scheduler's run log or logged, so they are not silent either; channel-origin drops keep going to their channel.

## Acceptance criteria

- [ ] Stop in the web with a web steer queued: the steer is dropped and the viewer sees a notice naming it; the pending-steer UI clears (test).
- [ ] A reset with web messages queued shows the same notice to viewers of the retired session.
- [ ] Telegram-origin drops are still reported on Telegram only; nothing is reported for an empty drop.
- [ ] Non-assistant sessions are unchanged: their queues still behave as before on abort (existing tests pass).
- [ ] With `assistantFolder` unset, behaviour is exactly as before (guard test).
- [ ] Tests isolate `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR` in temp dirs and assert the real `~/.wherever` is untouched.
- [ ] Changeset (`"wherever-dev": patch`); `CONTEXT.md` updated.

## Blocked by

- retired-assistant-session-is-read-only (serialised: both edit the server start wiring in `server/src/index.ts`)

## Prompt

> Goal: messages dropped from the assistant session are shown in the web, not only on channels (follow-up to spec `assistant-session-and-channels`, decided in a grilling session on 2026-10-31). The "What to build" section above is the decision; do not re-open it.
>
> Where to look: the controller's dropped-message record and `onDropped`, the channel dispatcher's `reportDropped` grouping by origin, the web's queued-steer state (`queue_update`, `pendingSteering`), the session notice / banner components.
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
