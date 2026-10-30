---
title: Assistant controller skeleton (current-session pointer, reset, Assistant entry point in the web)
slug: assistant-pointer-and-reset
spec: assistant-session-and-channels
blockedBy: [assistant-folder-opt-in-and-lock]
covers: [3, 4, 19]
---

## What to build

An assistant controller in the server that owns WHICH session is the current assistant session, and the web surfaces to reach and reset it.

- **Pointer.** Exactly one session in `assistantFolder` (never in `jobs/`) is current. The pointer (a session file path) is server state in the STATE dir. If none exists yet, opening the assistant creates one.
- **Session-created hook.** The pool gains a session-created callback (today it has only the single `onEvent` slot), fired from `createNewSession` ONLY on a real creation (not when it returns an existing viewed session). A new session created in `assistantFolder` itself moves the pointer. The web composer's local `/new` / `/reset` already create with `forceNew` (via `session_new`), so inside the assistant session they become an assistant reset with no composer change. (CLI-created sessions moving the pointer belongs to `cli-bridge-foundation`.)
- **Reset.** Abort the old pointer session's running turn if any, then call `clearQueue` on it (an abort leaves pi's steer/followUp queues populated, ADR 0014) and RECORD the dropped messages (reported to their channels once `channel-seam-notify-and-web-push` exists), then `createNewSession(assistantFolder, ..., forceNew=true)`, then move the pointer. The move is idempotent (the controller's own creation also fires the callback), so one reset aborts exactly once.
- **Sending.** Expose a controller `send(text, origin)` for later tasks. Before every send it calls `loadSession` on the pointer (the pool's `sendUserMessage` silently no-ops on a non-resident session). The controller pins the current session against the CLI idle-teardown race (an idle CLI session with no viewers is destroyed and reconnects with backoff; a message in that window would build a server agent on the same file).
- **Web.** The assistant status gains the current session id. An "Assistant" entry point (sidebar/home) opens the current assistant session; a Reset action on it calls the controller's reset.

## Acceptance criteria

- [ ] The Assistant entry point opens the current session; with none yet, one is created and becomes the pointer.
- [ ] Reset (button, or web `/new` / `/reset` in the assistant session) yields a NEW session even while a tab views the old one, moves the pointer, aborts a running turn exactly once, and clears and records any queued messages of the old session.
- [ ] A session created in `jobs/` or elsewhere never moves the pointer; `createNewSession` returning an existing session does not fire the callback.
- [ ] The pointer survives restart and idle eviction (the next send reloads it).
- [ ] With `assistantFolder` unset, no session-created callback and no controller are registered, the Assistant entry point is hidden, `session_new` and web `/new` / `/reset` behave exactly as today, and idle teardown of every session is unchanged (existing idle tests pass).
- [ ] The callback fires only on a real creation (not the existing-viewed-session return, not when joining a pending create), and a throwing callback never fails `createNewSession`.
- [ ] Tests cover the new behaviour with temp assistant/config/state dirs, asserting the real ones are untouched.
- [ ] A changeset (`"wherever-dev"`); `CONTEXT.md` documents the pointer, callback and reset.

## Blocked by

- assistant-folder-opt-in-and-lock

## Prompt

> Goal: give the wherever assistant (spec `assistant-session-and-channels` in `work/specs/tasked/`; ADRs `0014` to `0017`) a CURRENT session and a reset, plus the web entry point. The session is disposable; the folder is the memory, so reset is cheap and frequent.
>
> Where to look: the session pool (`createNewSession` and its `forceNew` / viewed-session dedupe, `loadSession`, CLI idle teardown, the single `onEvent` slot), the server's `session_new` handler, the web composer's local `/new` / `/reset`, the sidebar/home components, and the assistant status from the previous task. State dir: `getWhereverStateDir()` (ADR 0006). Seams: the controller with an injected pool fake; the pool callback; the status payload.
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

The non-obvious in-scope decisions taken while building this task (status shape, pointer file location and foreign-folder handling, dangling-pointer replacement, CLI-only pinning, steer-by-default `send`, in-memory dropped-message record, the new `assistant_open` / `assistant_reset` / `assistant_current` / `assistant_status` frames, the serial queue with own-creation skip, web placement, changeset bump) are recorded in [work/notes/observations/assistant-pointer-and-reset-decisions.md](../../notes/observations/assistant-pointer-and-reset-decisions.md), with JSDoc at each choice site in `server/src/assistant-controller.ts`, `server/src/session-pool.ts` and `server/src/index.ts`.
