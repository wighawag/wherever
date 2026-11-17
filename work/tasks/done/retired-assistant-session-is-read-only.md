---
title: A retired assistant session is read-only for web viewers and never blocks the current one
slug: retired-assistant-session-is-read-only
blockedBy: [web-timezone-report-only-when-the-device-moves]
covers: []
---

## What to build

Implement ADR 0020 (`docs/adr/0020-a-retired-assistant-session-is-read-only-and-never-occupies-the-assistant-folder.md`), read it first. Today, after a reset, a tab still viewing the old assistant session makes the new current session open read-only behind the folder-conflict banner, because both live in the assistant folder.

New behaviour: a session whose cwd is the assistant folder (not `jobs/`) and which is not the current pointer session is RETIRED. Its web viewers get a HARD, non-dismissible read-only verdict (a new reason beside the configured read-only folder and the missing folder; `folder_conflict_continue` must not lift it) with a notice that the assistant was reset and an action that opens the current session (`assistant_open`). Retired sessions never count as occupants in the folder-conflict check, so the current session opens writable even while a retired one is viewed. When the pointer moves, viewers of the newly retired session are told live (no reload needed). Terminal `pi -c` on a retired session is not blocked.

## Acceptance criteria

- [ ] After a reset with a tab on the old session, the new session opens writable (no conflict banner) and the old tab becomes read-only with the notice and an open-current action (real-server test).
- [ ] The retired verdict cannot be dismissed with "Continue anyway"; `hasHardReadOnly`-style precedence includes it (test).
- [ ] Opening an old assistant session from the list (retired before this change) is read-only too; `jobs/` sessions are never retired.
- [ ] Two sessions in an ordinary folder still get today's folder-conflict behaviour (existing tests pass).
- [ ] With `assistantFolder` unset, behaviour is exactly as before (guard test).
- [ ] Tests isolate `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR` in temp dirs and assert the real `~/.wherever` is untouched.
- [ ] Changeset (`"wherever-dev": minor`); `CONTEXT.md` (read-only reasons section and the assistant pointer section) updated, linking ADR 0020.

## Blocked by

- web-timezone-report-only-when-the-device-moves (serialised: both edit the server start wiring in `server/src/index.ts`)

## Prompt

> Goal: a retired assistant session is read-only for web viewers and never blocks the current one (follow-up to spec `assistant-session-and-channels`, decided in a grilling session on 2026-10-31). The "What to build" section above is the decision; do not re-open it.
>
> Where to look: the read-only verdict and its precedence (`hasHardReadOnly`, `resolveFolderConflictState`, `folder_conflict_continue` in the server), the assistant controller's pointer and its `onChange` / `assistant_status` broadcast, the web's read-only banner and the Assistant entry point.
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

The non-obvious in-scope decisions are recorded in [work/notes/observations/retired-assistant-session-is-read-only-decisions.md](../../notes/observations/retired-assistant-session-is-read-only-decisions.md):
- With no pointer yet, every session in the assistant folder counts as retired.
- A new `assistant_retired` frame plus a `session_created.assistantRetired` flag carry the state, instead of the web working it out itself.
- The check is keyed on the session the viewer has on screen, so a slow load is covered when the pointer moves.
- A retired session takes no part in folder conflicts.
- `session_new` waits for the controller only in the assistant folder.
- A viewed session that becomes current again is made writable.
- `POST /session/upload` is unchanged.
- Sends to a retired session get their own refusal message.
- The changeset bump is `minor`.
