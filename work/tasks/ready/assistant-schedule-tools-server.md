---
title: Server-side assistant schedule and timezone tools, timezone line per turn, web reports its timezone
slug: assistant-schedule-tools-server
spec: assistant-session-and-channels
blockedBy: [assistant-scheduler]
covers: [6, 7, 8, 12]
---

## What to build

Let any server-built session's agent manage the assistant's schedule and the user's timezone.

- **Tools**, registered in `buildServerAgent()` only when `assistantFolder` is configured, in EVERY server session (not only the assistant's): `assistant_schedule_add` (through the scheduler's write queue, stamping the calling session as `originSessionId` / `originCwd`), `assistant_schedule_list` (all jobs, marking the caller's, showing done and invalid entries and last/next run), `assistant_schedule_remove`, `assistant_set_timezone` (validated IANA name). Self-contained in the `say` / `attach_file` style, calling the controller/scheduler directly. This task CREATES and owns the shared tool-text module (each tool's description, `promptSnippet` and `promptGuidelines`) that `channel-seam-notify-and-web-push` extends and the CLI twins reuse under a drift test. When the folder lock is held by another server, the tools return a clear error naming the lock state.
- **Timezone line.** Every turn of a session whose cwd is `assistantFolder` or its `jobs/` gets a system-prompt append `User's current timezone: <tz>` at `before_agent_start`, using the conversation-mode inline-extension pattern (ADR 0004): append to the prompt the event carries, never replace it.
- **Web reports its timezone.** On connect the web client sends `Intl.DateTimeFormat().resolvedOptions().timeZone`; the server updates the user's timezone when it differs (recorded). Every timezone change, whether from the web report or `assistant_set_timezone`, goes through the scheduler's timezone setter, which pushes `assistant_info_changed` to connected CLI bridges (message from `cli-bridge-foundation`). This task also makes `assistant_info` return the current timezone, and adds it to the assistant status shown in the web.

## Acceptance criteria

- [ ] With `assistantFolder` unset, server sessions have none of these tools.
- [ ] From a non-assistant session, `assistant_schedule_add` writes to the assistant's `schedule.json` with origin stamped, and the job runs as the assistant.
- [ ] `assistant_schedule_list` marks the caller's jobs and shows done and invalid entries; `assistant_schedule_remove` removes; bad input returns `isError: true` and writes nothing.
- [ ] `assistant_set_timezone` and a web connect from another timezone both shift a follows-the-user job; the assistant's next turn carries the new timezone line.
- [ ] Both kinds of timezone change push `assistant_info_changed`; `assistant_info` and the assistant status report the current timezone.
- [ ] With the lock held by another server, the tools return a clear lock-state error.
- [ ] Tests cover the new behaviour with temp assistant/config/state dirs, real ones untouched.
- [ ] A changeset (`"wherever-dev"`); `CONTEXT.md` documents the tools and the timezone line.

## Blocked by

- assistant-scheduler

## Prompt

> Goal: expose the wherever assistant's scheduler (spec `assistant-session-and-channels` in `work/specs/tasked/`; ADR `0015`) to agents as tools, and keep the assistant aware of the user's timezone. Every job belongs to and runs as the assistant, whoever schedules it; the origin is context, not the execution location.
>
> Where to look: `buildServerAgent()` and its `customTools`, the `say` / `attach_file` factories and their drift test, the conversation-mode inline extension (ADR 0004), the scheduler's write API and timezone state, the web connect path, and the `assistant_info_changed` push. Seams: each tool's `execute` against a temp scheduler; the inline extension's append; the timezone-report handler.
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```
