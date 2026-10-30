---
title: CLI twins of the assistant_* tools (always registered, via cli_request) and the CLI timezone line
slug: cli-assistant-tool-twins
spec: assistant-session-and-channels
blockedBy: [cli-bridge-foundation, assistant-schedule-tools-server, channel-seam-notify-and-web-push]
covers: [12, 13, 20]
---

## What to build

Make all five `assistant_*` tools work in a terminal pi session attached to wherever. `docs/adr/0016` is the design.

- **Extension twins.** `pi.registerTool` for `assistant_schedule_add`, `assistant_schedule_list`, `assistant_schedule_remove`, `assistant_set_timezone`, `assistant_notify`, ALWAYS registered (even when not configured or the server is old). Each calls the server with `cli_request` and returns its result; on disconnected / disabled bridge, "not configured", or timeout (old server) it returns a clear `isError` result. Descriptions, `promptSnippet` and `promptGuidelines` match the server tools' shared text, held together by a drift test like `say-tool.test.ts`.
- **Server ops.** `cli_request` ops `schedule_add`, `schedule_list`, `schedule_remove`, `set_timezone`, `notify`, executed through the same controller / scheduler / notify code as the server tools, with the calling session resolved from the bridge registration.
- **CLI timezone line.** The extension's `before_agent_start` appends `User's current timezone: <tz>` from the cached `assistant_info` when the session's cwd is `assistantFolder` or its `jobs/`; it never waits on the network.

## Acceptance criteria

- [ ] In a CLI-bridge session each tool round-trips with the same effect as its server twin, origin = that CLI session.
- [ ] Timeout (old server), disconnected / disabled bridge and not-configured each give a clear tool error.
- [ ] The drift test fails if server and extension texts diverge.
- [ ] A CLI session in the assistant folder gets the timezone line every turn; a pushed change appears next turn without a network wait.
- [ ] Tests cover the new behaviour (mirror the repo's test style), with temp assistant/config/state dirs (these ops write `schedule.json` and the timezone state) and an assertion that the real ones are untouched.
- [ ] Changesets `"@wherever-dev/pi"` and `"wherever-dev"`; `CONTEXT.md` documents the twins.

## Blocked by

- cli-bridge-foundation
- assistant-schedule-tools-server
- channel-seam-notify-and-web-push

## Prompt

> Goal: complete CLI-bridge support for the wherever assistant (spec `assistant-session-and-channels` in `work/specs/tasked/`): extension twins of the five `assistant_*` tools, their server `cli_request` handlers, and the CLI timezone line. Read `docs/adr/0016` first.
>
> Where to look: the extension's `say` / `attach_file` registrations and the drift test against their server twins, the extension's `cli_request` client and `assistant_info` cache (`cli-bridge-foundation`), the server's `cli_request` handler, and the shared tool-text module (`assistant-schedule-tools-server`, `channel-seam-notify-and-web-push`). Seams: each twin against a fake request client; the server op handlers; the drift test; the `before_agent_start` append with a primed cache.
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```
