---
title: Telegram files both ways (inbound to upload staging as paths, attach_file out)
slug: telegram-files
spec: assistant-session-and-channels
blockedBy: [telegram-conversation]
covers: [17]
---

## What to build

Files flow both ways on Telegram.

- **Inbound.** Photos, albums and documents from the paired user are downloaded into upload staging (the same place web uploads land) and passed to the assistant as file paths in the message text, exactly as web uploads are, with origin `telegram`. A caption becomes the message text.
- **Outbound.** When the assistant calls `attach_file` during output whose current destination is `telegram`, the file is sent to Telegram with the reply (photo for images, document otherwise), respecting Bot API size limits with a clear note when a file is too large.

> FORWARD-POINTER (drive conductor, 2026-10-30): (1) when you record non-obvious decisions in a note, the done record must link it: end your final report with a `## Decisions` block (the runner copies that block verbatim into `work/tasks/done/<slug>.md`), written AS the done-record section itself, e.g. `The non-obvious in-scope decisions (...) are recorded in [work/notes/observations/<slug>-decisions.md](../../notes/observations/<slug>-decisions.md).` Do not address the reviewer in it. An unlinked note fails review. (2) Earlier tasks in this chain established conventions to build on: gate assistant behaviour on the `/config` `assistant.active` flag (configured AND lock held), not on `configured`; see the `## Decisions` links in `work/tasks/done/assistant-*.md`.

## Acceptance criteria

- [ ] An image or document sent on Telegram reaches the assistant as a staged path; a caption becomes the text.
- [ ] `attach_file` in a Telegram-routed reply delivers the file on Telegram; an oversize file produces a clear note instead.
- [ ] Files from non-Telegram turns are never sent to Telegram.
- [ ] Tests cover the new behaviour with the Bot API mocked and temp staging/state dirs, real ones untouched.
- [ ] A changeset (`"wherever-dev"`); `CONTEXT.md` updated.

## Blocked by

- telegram-conversation

## Prompt

> Goal: file transfer both ways on the wherever assistant's Telegram channel (spec `assistant-session-and-channels` in `work/specs/tasked/`).
>
> Where to look: upload staging and how web uploads become paths in the message, the `attach_file` tool and how its call reaches clients over `tool_start` / `tool_end`, the Telegram adapter and routing destination. The MIT `badlogic/pi-telegram` `index.ts` shows download and `telegram_attach` mechanics. Seams: the inbound download-to-staging step and the outbound attach mapping, with the Bot API mocked.
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```
