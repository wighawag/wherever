---
title: Reading the wherever config never writes it; `wherever config init` / `config show` replace the seeded file
slug: config-read-never-writes
blockedBy: []
covers: []
---

## What to build

Implement ADR 0022 (`docs/adr/0022-reading-the-config-never-writes-it.md`), read it first. Today `getWhereverConfig()` (server, beside the config-dir resolvers) writes a default `config.json` into the config dir whenever none exists, from ANY caller at ANY time. That turned a late background read in the test suite into a write to a CI runner's real home, and it pins the defaults of the release that seeded the file.

New behaviour:

- **No write on read.** A missing `config.json` returns the built-in defaults (the same values the seed wrote today, so the effective config is unchanged) and creates nothing: no file, no directory. A read-only or absent config dir is no longer a warning case. An existing but unparseable file keeps today's behaviour (logged, defaults used).
- **Say where the config comes from.** At server start, log one line naming the config path and whether a file was found (e.g. "config: /home/u/.wherever/config.json (not found, using built-in defaults)").
- **`wherever config init`** writes a starter `config.json` to the resolved config dir (honouring `WHEREVER_CONFIG_DIR`), creating the dir if needed. It REFUSES to overwrite an existing file (non-zero exit, clear message), and reports the path it wrote. Content: the built-in defaults, pretty-printed.
- **`wherever config show`** prints the resolved config path, whether the file exists, and the EFFECTIVE config as JSON (the file's contents, or the defaults when absent). It must not print secrets verbatim: redact values of keys that hold credentials (at least `assistantTelegram.token`, the Telegram bot token, which may live in `config.json`), and say so.
- Both verbs are listed in `wherever help`. `config` with no/unknown subcommand prints its usage and exits non-zero.

## Acceptance criteria

- [ ] With no `config.json`, calling the config reader any number of times writes nothing: the config dir (and its parent) is not created (test with a temp `WHEREVER_CONFIG_DIR` pointing at a non-existent path, and with a read-only dir: no warning logged).
- [ ] The effective config with no file equals today's seeded defaults (test pins the values).
- [ ] Server start logs the config path and found / not found (real-server test).
- [ ] `wherever config init` creates the file with the defaults; a second run refuses with a non-zero exit and leaves the file byte-identical (test spawns the CLI).
- [ ] `wherever config show` prints path, existence and the effective config, with credential values redacted (test).
- [ ] Existing files are untouched by an upgrade: nothing rewrites or deletes a previously seeded file.
- [ ] Tests isolate the config dir in temp dirs (the suite's `setup-isolate-env.ts` already gives every test file a temp HOME and unsets `WHEREVER_CONFIG_DIR`); the suite's global real-home guard stays green.
- [ ] Docs: README "Configuration File" section and `docs/USAGE.md` say the file is optional and created by `wherever config init`; `CONTEXT.md` (the config/state dir section, which today mentions the best-effort seed) updated with targeted edits, linking ADR 0022. Changeset `"wherever-dev": minor` (user-visible: no starter file on first run, two new CLI verbs).

## Blocked by

- None, can start immediately.

## Prompt

> Goal: implement ADR 0022, "Reading the config never writes it" (`docs/adr/0022-reading-the-config-never-writes-it.md`). The "What to build" and "Acceptance criteria" sections of `work/tasks/backlog/config-read-never-writes.md` are the decision; do not re-open it.
>
> Context: wherever is a pi remote-control server (`server/`, published as `wherever-dev`). Its config is `config.json` in the config dir (`WHEREVER_CONFIG_DIR`, default `~/.wherever`), which is READ-only by design (ADR 0006: everything the server writes goes to the state dir, `WHEREVER_STATE_DIR`). `getWhereverConfig()` is the single reader, and today it seeds a default file when none exists. That is the behaviour to remove. Background: a late read in the test suite seeded a CI runner's real home config (commit "fix(server): a disposed pool skips its startup warm-up..."), and the suite now isolates every test file's HOME (`server/test/setup-isolate-env.ts`, `server/test/global-setup.ts`).
>
> Where to look: `getWhereverConfig` and the config/state dir resolvers in the server; the CLI verb dispatch (`dispatch()` in the server entry, beside `start` / `install` / `status` / `version`) and the help text it prints (`printInstallHelp` in the install command module); the README "Configuration File" section, `docs/USAGE.md`, and the `CONTEXT.md` config/state dir section. Look at how existing tests spawn the CLI (e.g. the read-only config deployment test's `startServer`, and the install/status command tests) and reuse that style.
>
> Work test-first: write each failing test, then the code. Keep the effective defaults identical to today's seed so nothing else changes. Find every place that relied on the file existing after a read (search the server for callers and the tests for assertions about a seeded file or the "could not seed" warning) and update them.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, ADR 0006 and ADR 0022? If a premise no longer holds (e.g. the server now writes config from a settings UI), stop and route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions (the exact redaction rule for `config show`, the log wording, the exit codes) in `work/notes/observations/config-read-never-writes-decisions.md`, and end your final report with a `## Decisions` block written AS the done-record section, e.g. `The non-obvious in-scope decisions (...) are recorded in [work/notes/observations/config-read-never-writes-decisions.md](../../notes/observations/config-read-never-writes-decisions.md).`
>
> Rules: never write to a real home or config dir in tests; bound exploratory shell commands with `timeout` and cap output; `CONTEXT.md` is ~800 lines, so edit it with targeted edits only and check `git diff --stat -- CONTEXT.md` before finishing; never use the em dash character; one changeset (`"wherever-dev": minor`); do not stage or commit unless asked.

---

### Claiming this task

```sh
dorfl claim config-read-never-writes --arbiter origin
git fetch origin && git switch -c work/config-read-never-writes origin/main
git mv work/tasks/ready/config-read-never-writes.md work/tasks/done/config-read-never-writes.md   # on completion
```
