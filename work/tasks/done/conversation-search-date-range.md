---
title: Conversation search can be bounded to the last 24 hours, 7 days or 30 days
slug: conversation-search-date-range
spec: conversation-search-date-range
blockedBy: [closed-sessions-in-search]
covers: [1, 2, 3, 4, 5, 6, 7, 8, 9]
---

## What to build

A date range selector (Any time, last 24 hours, last 7 days, last 30 days; default Any time) in the conversation search panel, for both the main and read-only views, beside the "Include closed" toggle. It bounds results by when the MATCHED MESSAGE was said (memonaut's entry `ts`), not by the session's last activity; relevance order is unchanged. memonaut 0.4 already supports `since`, so there is no upstream change.

- **Web:** pure `rangeToSince(range, now)` in `web/src/lib/core/` (Any time -> undefined; else `now - range` as ISO, computed at request time so re-running moves the window). Choice persisted in `localStorage` (`wherever-` prefixed key), one value shared by the main and read-only views. Changing the range re-runs the current query immediately: clear any pending debounce as `submit()` does, do nothing below the minimum query length, and go through the existing abort / supersede path. Results still show their relative time (already true: a regression guard).
- **Server:** `GET /search` passes `since` through; `SearchParams` gains `since?: string`. Inside `searchConversations`, IMMEDIATELY after the empty-query early return and BEFORE loading memonaut or the not-indexed check (an empty `q` with a garbage `since` still answers `ok`; a garbage `since` answers `error` even with no index). An absent or empty `since` means no bound. Otherwise, if `Number.isNaN(Date.parse(since))` answer `status: 'error'` with a message (new behaviour; `view` and `limit` keep coercing as today); else normalize with `new Date(since).toISOString()` (memonaut compares `ts` as TEXT and pi writes `Z`-suffixed timestamps, so an offset form would compare wrongly) and forward to memonaut's `search()` `since`. Visibility rules (`filterThreads`, incl. closed) unchanged.
- Entries with no `ts` are excluded whenever a range is set (memonaut behaviour); document it.

## Acceptance criteria

- [ ] `rangeToSince` unit tests (each range, Any time).
- [ ] Server tests: garbage `since` -> `status: 'error'`; empty `q` + garbage `since` -> `ok`; offset form normalized to `Z`; a real throwaway-index test (pattern in `server/test/conversation-search.test.ts`) showing `since` excludes an older match and keeps a newer one; hidden and closed threads still dropped with `since` set.
- [ ] Range persists; changing it re-runs immediately without a stale debounce firing afterwards (checked by hand and recorded in the decisions file, unless you extract a small pure scheduler and test it).
- [ ] Server tests also cover: absent and empty `since` -> no bound; garbage `since` with no index -> `error`, not `not-indexed`.
- [ ] Tests isolate state dirs and the memonaut index in temp dirs and leave the real ones untouched.
- [ ] `docs/USAGE.md` `GET /search` lists `since` (ISO date, absent or empty = no bound, error on an unparseable value).
- [ ] `CONTEXT.md` "Conversation search" documents `since` (semantics: matched entry `ts`; inherited fork history keeps its original `ts`; `otherHits` counts only in-window matches; no-`ts` entries excluded; the new error case); changeset (`"wherever-dev": minor`).

## Blocked by

- closed-sessions-in-search (serialized: same `/search` route, `conversation-search.ts`, the web search helper and the panel's controls row).

## Prompt

> Goal: as above; the decisions are in this body (spec for the user stories: `work/specs/tasked/conversation-search-date-range.md`). "Newest first" sorting is a SEPARATE, staged spec (`conversation-search-newest-first`); do not add a sort here.
>
> Where to look: the `/search` route in `server/src/index.ts` (grep `/search`; read bounded ranges, the file is several thousand lines), `searchConversations` / `SearchParams` in `server/src/conversation-search.ts` and its test, `searchConversations` in `web/src/lib/session-store.ts` (abort / supersede), `web/src/lib/components/ConversationSearch.svelte` (`submit()`, the debounce, `MIN_QUERY`, the "Include closed" toggle). memonaut's `since` is in `server/node_modules/memonaut/dist/search.d.ts` (read `.d.ts` only; never regex over bundled JS).
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): if memonaut was bumped and `since` semantics changed, route to needs-attention.
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/conversation-search-date-range-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.

## Decisions

All recorded in `work/notes/observations/conversation-search-date-range-decisions.md`:
1. **Range values and storage:** `'any' | '24h' | '7d' | '30d'`. Any time removes the key rather than storing it, and an unknown stored value reads as Any time.
2. **Separate module:** the range logic lives in its own `search-range.ts`; `SearchRequest` only gained `since`.
3. **Whitespace `since`:** treated as empty, so no bound.
4. **Error wording:** the message for an unparseable `since`.
5. **Any time sends nothing:** with no bound, `since` is left out of the memonaut call entirely.
6. **Re-run check by code reading:** how the no-stale-debounce behaviour was verified without a browser, plus a short manual check for a human (type, change the range within 250 ms, confirm one request with the new `since`).
7. **Placement:** where the dropdown sits and how it is styled.
