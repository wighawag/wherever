---
title: Presence says which session a waiting session waits on, and the Live strip names it
slug: live-strip-names-the-session-waited-on
spec: session-list-live-strip
blockedBy: [live-strip-in-session-list]
covers: [3]
---

## What to build

shipmates' presence `waitingOn` is not a session: for `waiting-for-session` it is the id of the QUESTION the session asked (set by `@shipmates/pi`'s `session_wait`), for `waiting-for-human` an inbox item id. `ShipmatesService` passes it through raw in `presenceView` / `snapshot()`, so the web cannot say who a session is waiting on.

Server: add `waitingOnSession: string | null` (normalized session path, the same `path.resolve` form the listing uses) to `ShipmatesPresenceView`. For `waiting-for-session`: `q = question(p.waitingOn)`; if `q.to.kind === 'session'` use `q.to.target`, else (`'role'`) use `roleHolder(q.to.target)`; normalize with `normalizeSessionFile`; any null (missing question, a role nobody holds) gives `waitingOnSession: null`, and so does every other state. `send()` already stores the resolved target, so NEVER call shipmates' `resolve()` here: it throws (`ambiguous`, `not-found`), and a throw inside `snapshot()` is caught by a handler that returns an EMPTY inbox and presence, blanking the web. No lookup may throw out of `snapshot()`. Web: carry the field in `ShipmatesPresence` (parse it defensively like the others) and show "waiting on <label>" on the strip's `waiting-for-session` rows, labelled like the sidebar labels sessions, falling back to "waiting on a session".

## Acceptance criteria

- [ ] `shipmates_update` presence entries carry `waitingOnSession` (server unit test: resolved to a session, unresolvable role -> null, other states -> null).
- [ ] The web parser accepts the field and tolerates its absence (older server) (unit test in `shipmates.test.ts`).
- [ ] A `waiting-for-session` row in the Live strip names the waited-on session; unresolvable -> "waiting on a session" (pure-function unit test).
- [ ] A waited-on session that is not in the CURRENT listing is NOT named (label falls back), so the strip never reveals a hidden session: check membership in the listing before labelling (the sidebar's `sessionLabel` falls back to `seenLabels`, labels of sessions listed earlier and now hidden, so it must not be used unguarded). Unit test with a seen-but-no-longer-listed path.
- [ ] A question whose lookup fails (missing, role unheld) never empties the inbox or presence (test).
- [ ] `CONTEXT.md` "Inbox and presence on the web" documents the field; changeset (`"wherever-dev": minor`).
- [ ] Tests that open a shipmates database use a temp `shipmatesStateDir` (the option, as `shipmates-service.test.ts` does, or `SHIPMATES_STATE_DIR`) and leave the real one untouched.

## Blocked by

- live-strip-in-session-list (the strip and `liveSessions` must exist).

## Prompt

> Goal: as above; the design is this task's body. Spec for the user story: `work/specs/tasked/session-list-live-strip.md` (story 3).
>
> Where to look: `server/src/shipmates-service.ts` (`ShipmatesPresenceView`, `presenceView`, `snapshot`), shipmates' core API types in `server/node_modules/shipmates/dist/*.d.ts` (read the `.d.ts` files only; never regex over bundled JS) for `question(id)`, `Question.to` and `roleHolder(role)`. What `waitingOn` holds is verified: `@shipmates/pi` sets it to the question id for `waiting-for-session` and to the inbox item id for `waiting-for-human` (sibling repo `~/dev/github/wighawag/shipmates/packages/shipmates-pi/src/tools.ts`; `@shipmates/pi` is not installed under `server/node_modules`). Web: `web/src/lib/core/shipmates.ts` (parser, `ShipmatesPresence`) and `web/src/lib/core/live-sessions.ts` from the previous task. Prior art for server tests: `server/test/shipmates-service.test.ts`, `server/test/shipmates-inbox-server.test.ts`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If shipmates already exposes the waited-on session, use it and say so; if `waitingOn` semantics differ from the above, route to needs-attention with the discrepancy.
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/live-strip-names-the-session-waited-on-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.

## Decisions

These are recorded in `work/notes/observations/live-strip-names-the-session-waited-on-decisions.md`:
1. **Badge:** the "waiting on X" text replaces the badge text instead of sitting in a second span next to it. The folder list's presence line is unchanged and still says "waiting on a session".
2. **Label:** the waited-on session is named by its first role, else its name, else its first message, else the fallback. "Empty session" is not used, and the sidebar's `sessionLabel` is not used because it falls back to labels of hidden sessions.
3. **Listing:** "the current listing" means the whole unfiltered listing, so a session hidden only by the filter box is still named.
4. **Lookup errors:** the server catches errors per session, so one bad question can't blank the snapshot.
