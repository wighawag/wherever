---
title: Telegram channel skeleton (token resolution and scrub, long polling, pairing by one-time code)
slug: telegram-token-and-pairing
spec: assistant-session-and-channels
blockedBy: [channel-seam-notify-and-web-push]
covers: [14, 23]
---

## What to build

The Telegram channel's secure base: it connects, and only the paired user can reach it. Conversation comes in `telegram-conversation`.

- **Token (ADR 0007 shape).** Resolution: `WHEREVER_TELEGRAM_TOKEN`, then `WHEREVER_TELEGRAM_TOKEN_FILE` (trimmed content), then a config-file value; never argv. After reading, both env variables are SCRUBBED from `process.env` (the agent's `bash` inherits the server environment). An unreadable token file DISABLES Telegram with a loud error rather than failing the server (ADR 0007's fatal rule protects a fail-open auth token, which an optional channel is not). Telegram is enabled per the config's channel list, and starts only while `assistantFolder` is configured AND the folder lock is held (two servers must never poll the same bot). The non-fatal departure from ADR 0007 is recorded in `docs/adr/0018`.
- **Adapter skeleton.** A channel (interface from `channel-seam-notify-and-web-push`) using Bot API long polling, with the polling offset persisted in the STATE dir so restarts neither replay nor lose updates.
- **Pairing.** While unpaired, the server generates a one-time code shown in the web UI; the user sends `/pair <code>` to the bot, and that Telegram user id is stored in the state dir. A user id set in config takes precedence over a stored pairing. Once paired, `/start` and `/pair` are refused; re-pairing is an explicit web action (invalidates the stored pairing and issues a new code). Messages from any other user are ignored (not answered).
- **Web.** The assistant status gains Telegram state (disabled / unpaired + code / paired user); a settings section shows the code, the paired user, and a re-pair action.

> FORWARD-POINTER (drive conductor, 2026-10-30): (1) when you record non-obvious decisions in a note, the done record must link it: end your final report with a `## Decisions` block (the runner copies that block verbatim into `work/tasks/done/<slug>.md`), written AS the done-record section itself, e.g. `The non-obvious in-scope decisions (...) are recorded in [work/notes/observations/<slug>-decisions.md](../../notes/observations/<slug>-decisions.md).` Do not address the reviewer in it. An unlinked note fails review. (2) Earlier tasks in this chain established conventions to build on (see the `## Decisions` links in `work/tasks/done/`): the assistant status has an `active` flag (configured AND this server holds the folder lock); anything that RUNS or WRITES assistant state (scheduler, channels, polling, keys, pointer) gates on `active`. Where THIS task says a tool is registered when `assistantFolder` is configured, keep that and make the tool return a clear lock-state error when not active. This task's own text and acceptance criteria always win over this note.

## Acceptance criteria

- [ ] Token resolution order holds; the env variables are absent from `process.env` after startup; an unreadable token file disables Telegram, logs loudly, and the server keeps running.
- [ ] Pairing succeeds only with the current code; the configured id wins over a stored pairing; `/start` and `/pair` are refused once paired; re-pair issues a new code; unpaired senders are ignored.
- [ ] The polling offset survives a restart.
- [ ] With `assistantFolder` unset, or the lock held by another server, there is no polling and no offset or pairing state is written.
- [ ] With `assistantFolder` unset or Telegram not enabled, the token file is not read and no error is logged (scrubbing the env variables is still allowed), and the Telegram settings section is hidden.
- [ ] Tests cover the new behaviour with the Bot API mocked at the HTTP boundary and temp config/state dirs, real ones untouched.
- [ ] A changeset (`"wherever-dev"`); `CONTEXT.md` documents the token variables, pairing and offset.

## Blocked by

- channel-seam-notify-and-web-push

## Prompt

> Goal: the secure base of the Telegram channel for the wherever assistant (spec `assistant-session-and-channels` in `work/specs/tasked/`). The bot gives a shell-capable agent an internet-reachable inbox, so pairing and token handling are the point of this task.
>
> Where to look: ADR 0007 and the auth-token resolution + env scrub it describes, ADR 0006 (state dir), the channel interface, the assistant status / settings UI. The MIT `badlogic/pi-telegram` extension (`index.ts`) shows the long-polling mechanics worth porting; its first-`/start` pairing is exactly what NOT to copy. Seams: a pure token resolver, a pure pairing state machine, the poller with a mocked Bot API.
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```
