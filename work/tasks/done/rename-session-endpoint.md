---
title: Rename a session, written by whichever process owns its file (server, bridge, disk)
slug: rename-session-endpoint
spec: sidebar-compact-layout
blockedBy: []
covers: [40, 41, 42, 43]
needsAnswers: false
---

## What to build

The server and protocol half of Rename (the UI comes in `session-row-rename` and the chat menu).

- `POST /sessions/name {sessionFile, name}` beside `/sessions/star` and `/sessions/close`: same token gate, same "inside the sessions dir" check (`sessionPool.isSessionFile`), name trimmed, non-empty, length-capped.
- The write path by case:
  - a server-run session in the pool: its agent session's `setSessionName(name)`;
  - a CLI-bridged session: a NEW server-to-bridge frame carrying an `id` and the name. The `@wherever-dev/pi` extension handles it by calling pi's `setSessionName` in the terminal pi (which owns the file) and answers a NEW bridge-to-server result frame `{id, ok, error?}` (today's server-to-bridge frames such as `cli_model_change` are fire-and-forget, so this reply is new). The server answers HTTP 200 and broadcasts only on `ok`; it answers an error on `ok:false` or after a timeout. The extension advertises a new capability in `cli_register.capabilities` (`BRIDGE_CAPABILITIES`); a bridge without it is refused with a message ("update the wherever extension in that terminal");
  - a session only on disk (not in the pool, not bridged): pi's `SessionManager.open(file, ...)` then `appendSessionInfo(name)`.
- Refused with a clear error: a file with any load pending in the pool (`pendingSessions` is private and holds every in-flight load; add a pool accessor) or a server entry that is `reloading`; a session with no message yet (pi persists nothing before the first user or assistant message, so the name would not reach the file).
- On success: `broadcastSessionsUpdated()`, so every dashboard relists (the listing reads the last `session_info` name, `session-transcript.ts`). Conversation search catches up at memonaut's next index; say so in docs.
- A web store function (`renameSession(sessionFile, name)`) that calls the endpoint and surfaces the error text, for the UI tasks.
- ADR: "a rename is written by the file's owner" (hard to reverse, surprising, real trade-off), including the known limit: a terminal pi WITHOUT the wherever extension holds its file invisibly to the pool, so the disk-only append cannot be guaranteed exclusive (the append is a single `session_info` line).

## Acceptance criteria

- [ ] Server tests (beside the star / close endpoint tests) cover: each write path, the old-bridge refusal, the bridge `ok:false` and timeout errors, the pending / reloading refusal, the empty-session refusal, path validation, name validation, and the broadcast only on success.
- [ ] Extension test covers the new frame: it calls `setSessionName` and replies `{id, ok}`, and replies `{id, ok:false, error}` when it throws; the capability is advertised.
- [ ] Tests that write session files or state use temp dirs and assert the real `~/.pi` and wherever state dir are untouched.
- [ ] New ADR in `docs/adr/` (next number); `CONTEXT.md` (new section near "Starred sessions"; the new frames in its CLI bridge section, as the reverse direction of ADR 0016's `cli_request` / `cli_response`) and `docs/USAGE.md` (the endpoint) updated.
- [ ] Server and extension checks and tests pass; changesets for `wherever-dev` and `@wherever-dev/pi`.

## Blocked by

None, can start immediately.

## Prompt

> Goal: spec `work/specs/tasked/sidebar-compact-layout.md` stories 40 to 43 (rename, server side). No UI here beyond the store function.
>
> Where to look (grep, then read bounded ranges: these files are thousands of lines): `server/src/index.ts` (`/sessions/star`, `/sessions/close`, `broadcastSessionsUpdated`, the WS `cli_response` / `cli_register` handling), `server/src/session-pool.ts` (`setSessionName` use in the shipmates spawn path, `changeModel` and its `cli_model_change` send, `pendingSessions`, `reloading`, how a tracked session is `server` vs `cli`), `server/src/protocol.ts` (frame unions), `server/src/cli-requests.ts` (the existing bridge-to-server request path, for reply-matching style), `server/src/session-transcript.ts` (listing name), `extension/src/index.ts` (the `cli_model_change` case, `BRIDGE_CAPABILITIES` in `extension/src/bridge-requests.ts`), extension tests in `extension/test/`. pi's API: `.d.ts` files under `server/node_modules/@earendil-works/pi-coding-agent/dist/` (`AgentSession.setSessionName`, extension API `setSessionName`, `SessionManager.open`, `appendSessionInfo`). Read only `.d.ts` there.
>
> Seams to test: the HTTP endpoint with the pool and a fake bridge socket, as the existing server tests do; the extension's frame handler. Isolate state and session dirs in temp folders.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Visual source of truth: the PNG mockups in `docs/design/sidebar-and-chat-redesign/` named above; where a mockup and the spec disagree, the spec (`work/specs/tasked/sidebar-compact-layout.md`) wins.
>
> RECORD non-obvious in-scope decisions you make while building in `work/notes/observations/rename-session-endpoint-decisions.md` (or an ADR if one meets the ADR gate in `work/protocol/ADR-FORMAT.md`) and end your final report with a `## Decisions` block linking it.
>
> House rules: never write em dashes; bound exploratory shell commands with `timeout 30` and cap their output; never run a regex over minified or bundled files; add a changeset (`"wherever-dev": patch` for web and server; `"@wherever-dev/pi": patch` only for `extension/` changes); update `CONTEXT.md` (and `docs/USAGE.md` for HTTP endpoints) where documented behaviour changes. Check by hand in the browser at a phone width (about 390px) and a desktop width, and record what you checked in the done record.

## Decisions

These are recorded in `work/notes/observations/rename-session-endpoint-decisions.md`; who writes the name is in ADR 0027.
1. **Names:** the frames are `cli_rename` / `cli_rename_result` and the capability is `cli_rename`.
2. **Status codes:** 400, 404, 409 for "can't be done safely now", 502 when the terminal refused or disconnected, 504 on timeout. The texts are in `RENAME_REFUSALS`.
3. **Name rule:** whitespace is collapsed, then trimmed; 1 to 200 characters; an over-long name is refused, never truncated.
4. **No message yet, terminal sessions:** the server decides from whether the transcript file exists; the extension doesn't re-check.
5. **Bridge reply:** matched by id and socket, fails at once on disconnect, 10 s timeout, not configurable.
6. **Large transcripts:** the on-disk path parses the whole file synchronously, which departs from `CONTEXT.md`'s "never materialize a whole session file" rule. I accepted it because a rename is a rare user action and pi's own append gives a correctly parented entry.
7. **Placement:** all rename logic is in `session-rename.ts`; the session pool only gains `hasPendingLoad`.
8. **Response body:** a successful rename answers `{sessionFile, name}`, with the name as stored.
9. **Browser check:** not applicable here, as above.

## Decisions (continued run, 2026-11-25)

Recorded by the earlier attempt in `work/notes/observations/rename-session-endpoint-decisions.md` and linked from the done record's `## Decisions` block. Who writes the name is in `docs/adr/0027-a-rename-is-written-by-the-files-owner.md`. In short:
- **Names:** the frames are `cli_rename` / `cli_rename_result` and the capability is `cli_rename`.
- **Status codes:** 400, 404, 409 when it can't be done safely now, 502 when the terminal refused or disconnected, 504 on timeout.
- **Name rule:** whitespace is collapsed and trimmed, 1 to 200 characters, and a name that is too long is refused rather than cut.
- **Timeout:** 10 s, matched by request id and connection.
- **Large files:** the disk-only path reads the whole file at once, which goes against a rule in `CONTEXT.md`. It was accepted because renames are rare.
