---
title: Conversation search leaves out closed sessions unless "Include closed" is on
slug: closed-sessions-in-search
spec: closed-sessions
blockedBy: [closed-sessions-in-the-sidebar, closed-sessions-cascade-and-undo]
covers: [10]
---

## What to build

- **Server:** `GET /search` gains `includeClosed=1`. The rule is applied in `filterThreads()` in `server/src/conversation-search.ts`, the ONE place visibility rules compose (CONTEXT.md "Conversation search"), through an `isClosed(sessionPath)` predicate built once per request like the existing matchers: per THREAD, `threadTotal` recomputed from survivors, a hit left with no visible thread dropped and counted in `hiddenHits`, exactly like the existing rules. Add `closed: boolean` to each returned thread. Export `filterThreads` (or a pure helper around it) so it can be unit-tested; add `isClosed` as a fourth predicate beside `isIgnored` / `isReadOnly`, or move the predicates to an options object. The closed rule applies to BOTH `view=default` and `view=readonly`, with the same `includeClosed` toggle.
- **Web:** an "Include closed" toggle in the search panel, remembered in `localStorage` (`wherever-` prefixed key), passed through the search request helper; included closed threads render dimmed.

## Acceptance criteria

- [ ] Default search drops closed threads; `includeClosed=1` keeps them flagged `closed: true` (tests).
- [ ] A fork family where one thread is closed: the open thread survives, `threadTotal` excludes the closed one by default (test).
- [ ] The existing visibility rules (`sessions.ignore`, `sessions.readOnly`, memonaut `private`) are unchanged under `includeClosed=1` (test).
- [ ] Toggle persists and re-runs the current query through the existing abort/supersede path.
- [ ] Tests isolate the state dir in a temp dir and leave the real one untouched.
- [ ] `CONTEXT.md` "Conversation search" lists the closed rule among the composed axes; changeset (`"wherever-dev": minor`).

## Blocked by

- closed-sessions-in-the-sidebar (serialized: both edit `web/src/lib/session-store.ts`; also needs the store from `closed-sessions-store-and-endpoint`).
- closed-sessions-cascade-and-undo (serialized: both edit `server/src/index.ts`, `web/src/lib/session-store.ts` and CONTEXT.md).

## Prompt

> Goal: as above. The decisions are in this task body and ADR 0025; user story 10 in `work/specs/tasked/closed-sessions.md`.
>
> Where to look: `server/src/conversation-search.ts` (`filterThreads`, `visibility`, `searchConversations`) and its test `server/test/conversation-search.test.ts` (it builds a throwaway index; reuse that pattern), the `/search` route in `server/src/index.ts`, `searchConversations` in `web/src/lib/session-store.ts`, `web/src/lib/components/ConversationSearch.svelte`. The closed set comes from the store's never-throwing read.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED). The date-range control (spec `conversation-search-date-range`, built after this task) will sit beside this toggle.
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/closed-sessions-in-search-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.

## Decisions

All recorded in `work/notes/observations/closed-sessions-in-search-decisions.md`:
1. The checks became one options object rather than a fourth argument, and `filterHits` was pulled out so the counts are testable.
2. Closed is checked last and on the normalized session path, so including closed sessions can't get around the other rules.
3. Only `includeClosed=1` turns it on; any other value means off.
4. The new storage key is separate from the sidebar's `wherever-show-closed`, and one value is shared by the main and read-only search views.
5. Toggling re-runs the query at once (clear the debounce, skip below the minimum query length, same abort path).
6. Dimmed rows use the same `opacity-50` as the sidebar, plus a "· Closed" label and tooltip.
7. The request builder is a pure module, and the options argument leaves room for the date-range task's `since`.
8. The changeset is `minor`.
