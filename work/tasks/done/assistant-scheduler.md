---
title: Assistant scheduler (schedule.json intent, run log, timezones, inline and isolated firing)
slug: assistant-scheduler
spec: assistant-session-and-channels
blockedBy: [cli-bridge-foundation]
covers: [6, 7, 8, 9, 16, 19, 21]
---

## What to build

A scheduler inside the wherever server that fires the assistant's jobs. `docs/adr/0015` is the design. The tools that write jobs come next; this task reads `schedule.json` (hand-written in tests) and provides the single in-process write API the tools will use.

- **Format.** `<assistantFolder>/schedule.json` holds intent only: `{id, name, cron? | at?, tz?, mode: "inline"|"isolated", prompt, enabled, originSessionId?, originCwd?}`. Exactly one of `cron` (5-field, recurring) or `at` (ISO 8601 date-time, or `"now"`, one-shot). An `at` without a UTC offset is read in the job's effective timezone.
- **Validation and writes.** Validated on every read; a malformed entry is logged and marked invalid (for listing), never starts a turn, and does not stop valid ones. Writes go through ONE in-process queue, atomic (tmp + rename), re-reading and retrying if the file changed on disk since it was read. Hand edits are picked up (watcher or re-read per tick).
- **Run log.** Append-only `assistant-runs.jsonl` in the STATE dir (job id, time, mode, session file, outcome); last/next run derive from it; nothing is ever written back into `schedule.json`. A completed one-shot stays in the file and is reported done.
- **Timezones.** Effective timezone = job `tz`, else the user's CURRENT timezone: server state in the state dir, initialised to the system timezone, with a setter for later tasks; changes are recorded.
- **Restart rules.** A recurring job that missed runs while down fires ONCE on startup if the latest missed run is within a grace window (default 1 h, configurable), else it is skipped and recorded; a missed one-shot follows the same rule, then counts done.
- **Inline firing.** Waits until the current assistant session is SETTLED with nothing queued (`agent_settled`, not `agent_end`; for a CLI session lacking the `agent_settled` capability, fall back to `agent_end`), then sends via the controller with origin `schedule:<jobId>` as `[schedule:<name>] (from <originCwd>, session <originSessionId>) <prompt>`. A prompt starting with `/` is sent WITHOUT that prefix so command and skill expansion work. After an ABORTED settle (`aborted: true`) pi still holds queued messages, so the controller calls `clearQueue` and records the dropped messages (channel reporting arrives with the channel tasks), making settled-and-empty reachable again.
- **Isolated firing.** Starts immediately, in parallel, in a fresh `forceNew` session in `<assistantFolder>/jobs/`, recording the job-to-session mapping (used later by `assistant_notify`).
- **`!` refusal.** A prompt starting with `!` or `!!` is refused (a failed run), never reaching the shell path. Neither mode notifies on its own. The scheduler runs only while the folder lock is held.

> FORWARD-POINTER (drive conductor, 2026-10-30): (1) when you record non-obvious decisions in a note, the done record must link it: end your final report with a `## Decisions` block (the runner copies that block verbatim into `work/tasks/done/<slug>.md`), written AS the done-record section itself, e.g. `The non-obvious in-scope decisions (...) are recorded in [work/notes/observations/<slug>-decisions.md](../../notes/observations/<slug>-decisions.md).` Do not address the reviewer in it. An unlinked note fails review. (2) Earlier tasks in this chain established conventions to build on: gate assistant behaviour on the `/config` `assistant.active` flag (configured AND lock held), not on `configured`; see the `## Decisions` links in `work/tasks/done/assistant-*.md`.

## Acceptance criteria

- [ ] Next-run derivation for `cron` and `at` (including `"now"` and offset-less `at`) from the run log, with an injected clock and no real timers.
- [ ] Follows-the-user vs pinned `tz`, including a user timezone change and a DST transition.
- [ ] Restart grace: fire once inside the window, skip outside, one-shot done.
- [ ] Inline waits for settled and never merges into a running exchange; `/` prompts go without the prefix and still expand; an aborted settle with a queued message clears it and inline jobs fire afterwards.
- [ ] Isolated starts immediately in `jobs/` while the assistant is busy, and records its mapping.
- [ ] For a CLI-bridge assistant session whose extension lacks the `agent_settled` capability, inline jobs fall back to `agent_end`.
- [ ] A malformed entry is listed invalid without a turn while valid ones fire; a concurrent on-disk edit is not clobbered; `!` prompts are refused.
- [ ] With `assistantFolder` unset, or the lock held by another server, the scheduler never starts: no watcher, no timer, no run log and no timezone state are created (a test asserts the state dir is unchanged).
- [ ] Tests use temp assistant/config/state dirs and assert the real ones are untouched.
- [ ] A changeset (`"wherever-dev"`); `CONTEXT.md` documents the format and firing rules.

## Blocked by

- cli-bridge-foundation (provides the CLI `capabilities` list used for the `agent_end` fallback; transitively after `pool-per-message-routing`, whose routing and settle events this task uses)

## Prompt

> Goal: the server-owned scheduler for the wherever assistant (spec `assistant-session-and-channels` in `work/specs/tasked/`). Read `docs/adr/0015` (intent in the folder, run state in the state dir, times follow the user) and `docs/adr/0014` (why scheduled sends carry an origin and stay silent).
>
> Where to look: the controller's `send(text, origin)` (`assistant-pointer-and-reset`), the pool's routing and settle events (`pool-per-message-routing`), `createNewSession` with `forceNew`, and how existing server JSON stores write atomically (drafts, stars). Use a small maintained cron parser with timezone support, or a minimal 5-field parser if none fits; record the choice. Seams: a pure next-run function (entry, timezone, run log, now), the schedule store (validation, write queue, conflict retry), the firing loop with an injected clock and a controller fake.
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```

## Decisions

The non-obvious in-scope decisions taken while building this task (hand-written cron parser instead of a library, DST gap/overlap semantics, the `{ "jobs": [...] }` file shape with required `name`/`enabled` and refusal to write over an unreadable file, when a missed run counts and the first-seen/re-enable/edit base, grace applied on every tick, the `assistantScheduleGraceMinutes` config key, the run-log outcome vocabulary and fired-at-dispatch entries, the prefix on isolated jobs too, one inline job per exchange with in-memory pending and the 60 s CLI start timeout, the unconditional clear after an aborted settle with the new `aborted` drop reason, the timezone state file and the not-yet-wired `onTimezoneChange`, re-reading per tick instead of a watcher, the `!` check on trimmed text, the changeset bump) are recorded in [work/notes/observations/assistant-scheduler-decisions.md](../../notes/observations/assistant-scheduler-decisions.md), with JSDoc at the choice sites in `server/src/assistant-cron.ts`, `server/src/assistant-schedule.ts`, `server/src/assistant-scheduler.ts` and `server/src/assistant-controller.ts`.
