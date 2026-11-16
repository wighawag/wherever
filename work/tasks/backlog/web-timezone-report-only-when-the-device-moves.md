---
title: The web reports its timezone only when the device moved, and never overrides an explicit setting on a first report
slug: web-timezone-report-only-when-the-device-moves
blockedBy: [assistant-schedule-tools-absent-when-not-active]
covers: []
---

## What to build

Implement ADR 0019 (`docs/adr/0019-the-users-timezone-follows-an-explicit-setting-until-a-device-actually-moves.md`), read it first. Today the web sends `client_timezone` on every `connected` frame and the server applies it whenever it differs, so a web reconnect undoes `assistant_set_timezone` and two devices in different zones alternate.

New behaviour: the web remembers, on the device, the last zone it reported. It sends a report only when the browser's resolved zone differs from that remembered value, and marks whether this is the device's FIRST report (nothing remembered). The server applies a non-first report when it differs from the current zone; it applies a first report only when the current zone was not set by `assistant_set_timezone` (its latest history source). Ignored reports change nothing and are not recorded. Every applied change still goes through the scheduler's setter (history source `web`, `assistant_info_changed` push, `assistant_status` broadcast).

## Acceptance criteria

- [ ] Reconnecting a device whose zone did not change sends no report and changes nothing (test).
- [ ] After `assistant_set_timezone`, a new device's first report does not override it; a known device whose zone actually changed does (test).
- [ ] Two devices in different zones that never move no longer alternate the setting (test).
- [ ] With no explicit setting, a first report applies as before.
- [ ] An older server (drops the new field) and an older web (no first-report flag, treated as non-first) keep working; document the compatibility choice.
- [ ] With `assistantFolder` unset, behaviour is exactly as before (guard test).
- [ ] Tests isolate `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR` in temp dirs and assert the real `~/.wherever` is untouched.
- [ ] Changeset (`"wherever-dev": minor`); `CONTEXT.md` documents the rule and links ADR 0019.

## Blocked by

- assistant-schedule-tools-absent-when-not-active (serialised: both edit the server start wiring in `server/src/index.ts`)

## Prompt

> Goal: the web reports its timezone only when the device moved, and never overrides an explicit setting on a first report (follow-up to spec `assistant-session-and-channels`, decided in a grilling session on 2026-10-31). The "What to build" section above is the decision; do not re-open it.
>
> Where to look: the web's timezone report (`web/src/lib/core/timezone-report.ts` and where it is sent on connect), the server's `client_timezone` handling (`onClientTimezone`), `setTimezone` and the timezone state history in the assistant schedule module, `WEB_TIMEZONE_SOURCE`.
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
