---
title: Closing an orchestrator can close everything it spawned, and a close can be undone as one batch
slug: closed-sessions-cascade-and-undo
spec: closed-sessions
blockedBy: [closed-sessions-in-the-sidebar, live-strip-names-the-session-waited-on]
covers: [8, 9, 19]
---

## What to build

- **Owned subtree:** a new `ShipmatesService.ownedSubtree(file): string[]` built on shipmates' `ownedBy(file, {transitive: true})`, normalized like the listing's paths; drops entries whose `Ownership.session` is null, excludes the root itself, and skips members already hidden by a cascade-delete archive; `[]` when shipmates is unavailable. (Today the service only has direct `ownsSessions` and the archiving `deleteCascade`.)
- **Endpoint:** `POST /sessions/close` gains `cascade?: boolean` (only with `closed: true`): closes the session and its transitive owned subtree as one `batch`, answering `{batch, sessions}`. And `{batch, closed: false}` reopens the whole batch and restores every star the batch's closes removed (`unstarred: true`). Every close, single or cascade, already carries a batch id (from `closed-sessions-store-and-endpoint`), so the same undo works after a single close. A way for the web to get the true N before asking (an endpoint field or a small query) since the web's `ownedChildren` only sees listed sessions.
- **Web:** closing a session that owns others asks "Also close the N sessions it owns?" (default yes), with N from the server. After any close, a banner "Closed X (and N owned). Undo", laid out like the existing cascade-delete undo banner; Undo calls the batch reopen.

## Acceptance criteria

- [ ] `ownedSubtree` returns the transitive subtree across folders, normalized; `[]` without shipmates (server unit test).
- [ ] Cascade close marks every member with one `batch`; batch reopen clears them all and restores removed stars (endpoint tests).
- [ ] The prompt shows the server's N, not the listed-children count (pure helper or endpoint test).
- [ ] Undo banner appears after a single close and after a cascade, and Undo reopens the batch; undo of a single close restores the star it removed (test).
- [ ] Tests isolate `WHEREVER_STATE_DIR` and `SHIPMATES_STATE_DIR` in temp dirs and leave the real ones untouched.
- [ ] `CONTEXT.md` "Closed sessions" documents cascade and undo; changeset (`"wherever-dev": minor`).

## Blocked by

- closed-sessions-in-the-sidebar (the web close action this extends).
- live-strip-names-the-session-waited-on (serialized: both edit `server/src/shipmates-service.ts`).

## Prompt

> Goal: as above. The decisions are in this task body and ADR 0025; user stories 8, 9, 19 in `work/specs/tasked/closed-sessions.md`.
>
> Where to look: `ShipmatesService` in `server/src/shipmates-service.ts` (`ownsSessions`, `deleteCascade`), shipmates' `ownedBy` in `server/node_modules/shipmates/dist/*.d.ts` (read `.d.ts` only; never regex over bundled JS), the close endpoint from `closed-sessions-store-and-endpoint`, the cascade-delete undo banner at the top of `web/src/lib/components/SessionBrowser.svelte`. Prior art: `server/test/shipmates-spawn.test.ts` for owned sessions.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED). If shipmates' ownership API differs, route to needs-attention with the discrepancy.
>
> RECORD non-obvious in-scope decisions (how N is fetched, banner lifetime) in `work/notes/observations/closed-sessions-cascade-and-undo-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.
