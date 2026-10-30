---
title: Assistant folder opt-in (assistantFolder config, first-time seeding, folder lock, status exposed to the web)
slug: assistant-folder-opt-in-and-lock
spec: assistant-session-and-channels
blockedBy: []
covers: [1, 5, 9, 21, 23]
---

## What to build

The opt-in foundation of the assistant feature. A new config key `assistantFolder` with NO default: when unset, the feature is entirely off (nothing registered, started or written). When set:

- On server start the folder is created if missing and seeded ONCE (never overwritten) with a default `AGENTS.md`, a `jobs/AGENTS.md` and a `.gitignore` excluding `.assistant.lock`, following the `searchFolder` / `maybeSeedSearchWorkspace` precedent.
- The server takes a folder lock `<assistantFolder>/.assistant.lock` (pid, host, boot id, process start time). A live lock held by another server makes this server refuse the assistant (logged clearly, reported in status). A same-host lock is stale, and taken over, when the boot id differs, the pid is dead, or the pid now belongs to a process with a different start time. Linux reads `/proc`; darwin uses `sysctl kern.boottime` and `ps -o lstart=`; elsewhere degrade to pid-only. A lock from another host is never taken over: the log says to remove it by hand.
- An assistant status (configured, folder, lock state) is exposed to the web the way `searchFolder` is today; later tasks add fields to it.
- Changing `assistantFolder` takes effect on restart only.

Default `AGENTS.md`: you are a long-lived general assistant; the session may be reset at any time, so save anything worth keeping into files here AS YOU GO (`memory/`, `profile.md`, ...) and read them at the start of a fresh session; use `assistant_schedule_*` for anything time-based (no `tz` = follows the user; set `tz` only for things pinned to a place); DELEGATE long or slow work to an isolated job (`at: "now"`) that notifies when done instead of blocking the conversation, and make anything possibly urgent isolated; the user hears from you only through replies and `assistant_notify`, so in a `[schedule:...]` turn call `assistant_notify` if the user should hear about it; when the user says where they are, call `assistant_set_timezone`; if a `recall_search` tool is available, prefer it over asking the user to repeat themselves.

Default `jobs/AGENTS.md`: you are an isolated job run by the assistant: do the task, save anything worth keeping under `../memory/`, call `assistant_notify` if the user should know the result, and do not start conversations.

## Acceptance criteria

- [ ] With `assistantFolder` unset, nothing is created, locked or written, and status reports "not configured".
- [ ] With it set, the folder and the three seed files are created once and never overwritten.
- [ ] Lock: a live foreign lock makes a second server refuse the assistant with a clear log line and status; a same-host lock with a dead pid, a reused pid or a different boot id is taken over; a foreign-host lock is not.
- [ ] Status is exposed to the web alongside `searchFolder`.
- [ ] Tests cover the new behaviour (mirror the repo's test style), isolating every write: `assistantFolder`, `WHEREVER_CONFIG_DIR` and `WHEREVER_STATE_DIR` point at temp dirs, and the tests assert the real home folders and `~/.wherever` are untouched.
- [ ] A changeset (`"wherever-dev"`); `CONTEXT.md` documents the key, seeding and lock.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: the opt-in foundation for the wherever "assistant", a dedicated folder that is the home and memory of a long-lived, resettable general-assistant session (spec `assistant-session-and-channels` in `work/specs/tasked/`; ADRs `docs/adr/0014` to `0017`). Later tasks add the pointer, scheduler, tools and channels; this one makes the feature switchable, seeds the folder, takes the lock and exposes status.
>
> Where to look: server config (`assistantFolder` beside `searchFolder`), `maybeSeedSearchWorkspace` in the session pool, how `searchFolder` reaches the web, the config vs state dir split (ADR 0006). The lock is in the ASSISTANT folder on purpose: two servers on one folder is a user misconfiguration to report loudly, and a state-dir lock would miss a second server with a different state dir. Seams: a pure lock-decision function plus thin `/proc` and darwin probes; the seeding function; the status payload.
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```
