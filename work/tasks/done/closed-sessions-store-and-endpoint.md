---
title: The server keeps a closed-sessions set, reports it in the listing, and closes/reopens through one endpoint
slug: closed-sessions-store-and-endpoint
spec: closed-sessions
blockedBy: []
covers: [3, 15, 17, 18, 20]
---

## What to build

The server side of "close a session" for ONE session (no cascade, no auto-reopen, no web UI yet).

- A new store module, the ONE writer of `<state dir>/closed-sessions.json` `{version, closed: [{sessionFile, closedAt, batch?, unstarred?}]}`, built like the starred-sessions store: keyed by normalized session path, atomic write (tmp + rename, 0600), a corrupt file FAILS CLOSED on mutation (`ClosedUnavailableError`, never overwritten as empty), and a never-throwing `readClosedSet()` for the listing. Keep an in-memory set (the auto-reopen task checks it per agent event): load it lazily from disk on first use, key it by the resolved `closed-sessions.json` path (the state dir is re-read from `WHEREVER_STATE_DIR` on every call, so a plain module-level cache would leak between tests), and refresh it after every mutation.
- **Cap without silent reopen:** about 20,000 entries with a matching byte cap. At the cap, first prune entries whose transcript no longer exists; never drop an entry for an existing transcript (refuse the close with a clear error instead). Dropping the oldest, as stars do, would silently reopen a closed session.
- `POST /sessions/close {sessionFile, closed: boolean}`: explicit boolean, idempotent, refuses paths outside the sessions dir (same check as the star endpoint), broadcasts `sessions_updated`, answers `{batch, sessions}` (one fresh batch id per close). Same token gate as the other API routes.
- `/sessions` reports `closed: true` per session and ALWAYS returns closed sessions (the client hides them). Closed sessions are never added to the retention keep set: the pool's starred injection stays stars-only.
- **Close and star are exclusive.** Closing a starred session clears its star and records `unstarred: true` on the closed entry (so a later undo can restore it); starring a closed session clears its close flag. One writer per file: each endpoint calls its own store first, then the other store's setter. The close write is authoritative; clearing the star is best effort and logged, so a broken stars file cannot block closing.
- Deleting a session drops its close flag (`forgetClosed`) in BOTH delete paths: the direct `/session/delete` (beside its `forgetStar`) and `purgeShipmatesDeletes` (beside its `forgetStar`).
- Web package: add `closed?: boolean` to `SessionInfo` in the web session store and a `setSessionClosed(path, closed)` helper (optimistic with rollback like `setSessionStarred`; the optimistic close also clears `starred` locally and rolls that back too), unused by UI yet. Every close answers a `batch` id, even for a single session (the undo task relies on it): answer `{batch, sessions}`.

## Acceptance criteria

- [ ] Store unit tests mirroring the stars tests: round trip, idempotency, corrupt file fails closed, cap prunes only missing transcripts and refuses otherwise, `unstarred` round trip.
- [ ] Endpoint tests: close, reopen, refusal of a non-session path, `sessions_updated` broadcast, listing carries `closed: true` and still returns the session.
- [ ] Star exclusivity tests both ways, including a corrupt stars file not blocking a close.
- [ ] A closed session is NOT retention-exempt (test with `maxSessions`).
- [ ] Both delete paths drop the close flag (test).
- [ ] Tests point `WHEREVER_STATE_DIR` (and config dir) at temp dirs and assert the real `~/.wherever` is untouched.
- [ ] `CONTEXT.md` gains a "Closed sessions" section next to "Starred sessions" (store, endpoint, exclusivity, retention); changeset (`"wherever-dev": minor`).

## Blocked by

- None, can start immediately.

## Prompt

> Goal: as above. The decisions are in this task body and ADR `docs/adr/0025-closing-a-session-is-a-wherever-flag-not-a-shipmates-archive.md`; the user stories in `work/specs/tasked/closed-sessions.md`. Do not re-open them.
>
> Where to look: `server/src/session-stars.ts` (the template, and its test `server/test/session-stars.test.ts`), the `/sessions` handler and `/sessions/star`, `/session/delete` and the cascade-archive purge in `server/src/index.ts` (grep; the file is several thousand lines, read bounded ranges), `getStarred` / retention keep in `server/src/session-pool.ts`, `FolderSessionInfo` in `server/src/session-types.ts` and its client mirror, `setSessionStarred` in `web/src/lib/session-store.ts`. CONTEXT.md "Starred sessions" describes the discipline to copy.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED). If a premise no longer holds, route to needs-attention with the discrepancy (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions (exact cap numbers, the refusal shape at the cap, how `unstarred` is represented) in `work/notes/observations/closed-sessions-store-and-endpoint-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.

## Decisions

Recorded in `work/notes/observations/closed-sessions-store-and-endpoint-decisions.md`:
1. The cap is 20,000 entries and 8 MiB. The byte limit also acts as the read guard: a file found above it is treated as corrupt.
2. A refusal at the cap answers HTTP 409; a corrupt store stays 500, as with stars. The sessions being closed in the same request are never pruned.
3. `unstarred: true` is stored only when the close actually removed a star; otherwise the key is left out.
4. Closing an already-closed session gets a fresh batch id but `sessions: []`, and the stored entry keeps its original batch. The undo and cascade tasks rely on this shape.
5. The listing gets the closed set through a `getClosed` option on the pool, next to `getStarred`, and it never affects cleanup.
6. Reopening on star is best effort, so a corrupt closed store doesn't block starring.
7. The module is named `session-closed.ts`, beside `session-stars.ts`.
