---
title: Images parameter on the pool send, so Telegram photos reach the model as images
slug: pool-send-images
spec: assistant-session-and-channels
blockedBy: [telegram-files, cli-assistant-tool-twins]
covers: [17]
---

## What to build

The pool's send takes text only today, so Telegram photos reach the model as file paths. Add an optional images parameter to the pool send (and the controller's `send`) that passes images to pi as model image inputs, for server sessions and, through `cli_message`, CLI-bridge sessions (the extension passes them to `pi.sendUserMessage` if its API accepts images; if it does not, the CLI path keeps paths only and this is recorded). Telegram inbound photos then go as images plus their staged path. Routing (`pool-per-message-routing`) is unaffected: one send, one origin entry.

## Acceptance criteria

- [ ] A Telegram photo reaches a server-built assistant session as an image input (visible to the model), with its path still available.
- [ ] The CLI-bridge path either carries images or is documented as paths-only, with a test of whichever holds.
- [ ] Sends without images behave exactly as before; routing attribution is unchanged.
- [ ] Tests cover the new behaviour (mirror the repo's test style).
- [ ] Changesets: `"wherever-dev"`, plus `"@wherever-dev/pi"` if the extension changes; `CONTEXT.md` updated.

## Blocked by

- telegram-files
- cli-assistant-tool-twins (both may edit the extension and add a `@wherever-dev/pi` changeset; serialized)

## Prompt

> Goal: let the wherever pool send images as model inputs, so the assistant's Telegram channel (spec `assistant-session-and-channels` in `work/specs/tasked/`) can show the model a photo rather than only its path.
>
> Where to look: the pool's `sendUserMessage` / `prompt()` path (as reshaped by `pool-per-message-routing`), pi's `prompt()` / `sendUserMessage` image options in the installed SDK (read specific files, bounded), the `cli_message` relay and the extension's handler, and the Telegram inbound path from `telegram-files`. Seams: the pool send with the fake LLM server (ADR 0001), asserting the image reaches the request.
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```
