---
title: Conversation search can sort Newest first (memonaut 0.5 search order)
slug: conversation-search-newest-first
spec: conversation-search-newest-first
blockedBy: [conversation-search-date-range]
covers: [1, 2, 3, 4, 5, 6, 7, 8]
---

## What to build

A Relevance / Newest toggle in the conversation search panel (main and read-only views, beside the date range; default Relevance). "Newest" orders results by when the matched message was said, newest first, and returns the newest matches overall: memonaut 0.5's `order: 'recent'` orders BEFORE its result limit (newest matching entry per fork family, distinct families counted), so this is not a re-sort of the most relevant few.

- **Dependency:** bump `memonaut` in `server/package.json` to `^0.5.0` (published 2026-11-24; if pnpm refuses it as too fresh, add `memonaut@0.5.0` to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, the same way shipmates is listed), update the lockfile, and REGENERATE `pnpmDepsHash` in `package.nix` (read the comment there for how; it pins the resolved dependency content, so a stale hash breaks the nix build). Replace the structural `search` query type in `server/src/conversation-search.ts` (today `Record<string, unknown>`, which is why a missed bump would be silent) with a small interface, e.g. `{text; limit?; threadLimit?; since?; order?: 'relevance' | 'recent'}`. Typing does not catch a missed bump; the 0.4-failing test does. Helper scripts for the hash: `./nix/update-pnpm-deps-hash.sh` and `nix/check-pnpm-deps-hash.sh`.
- **Server:** `GET /search` gains `sort=relevance|recent` (absent or empty -> `relevance`). `SearchParams` gains `sort`. Validate inside `searchConversations` next to the `since` check (immediately after the empty-query return, before loading memonaut): an unknown `sort` answers `status: 'error'` with a message. Map `recent` to memonaut `order: 'recent'`.
- **Post-limit filtering (decided by the human):** wherever drops hidden / read-only / closed threads AFTER memonaut's limit, and under `recent` the newest results are the likeliest to be recent agent or closed sessions. So under `sort=recent` ask memonaut for `MAX_LIMIT` (50) and slice to the requested `limit` after the visibility filtering; `relevance` keeps today's behaviour exactly. Stop the visibility loop once `hits.length === limit`, so `hiddenHits` counts only hidden results ABOVE the cut (the same meaning as under relevance; the panel shows it as "N hidden"); `scanned` stays memonaut's value. At a requested `limit` of 50 there is no headroom and a page can come back short: note this in CONTEXT.md, and do NOT raise the over-fetch beyond 50 (the human's decision).
- **Web:** the toggle in `ConversationSearch.svelte`; choice in `localStorage` (`wherever-` prefixed key, shared by both views); the request helper gains `sort`; changing it re-runs the current query like the date range does (clear the pending debounce, respect the minimum query length, existing abort / supersede path).
- Visibility rules (`filterThreads`, incl. closed) unchanged.

## Acceptance criteria

- [ ] memonaut is `^0.5.0` in `server/package.json`, the lockfile is updated, and `pnpmDepsHash` in `package.nix` is regenerated (state in the report how it was regenerated, or that it could not be on this machine and what the human must run).
- [ ] A real throwaway-index test (pattern in `server/test/conversation-search.test.ts`) shows `sort=recent` returns hits by matched-entry `ts` descending, including a recent low-relevance match that the relevance order cuts at the same `limit`. It FAILS on memonaut 0.4 (so it also guards the bump).
- [ ] Unknown `sort` -> `status: 'error'`; absent / empty -> relevance; relevance output unchanged; empty `q` + unknown `sort` -> `ok`; unknown `sort` with no index -> `error`, not `not-indexed` (tests).
- [ ] Under `sort=recent`, `hiddenHits` counts only hidden results above the cut (test).
- [ ] Under `sort=recent`, a page whose newest memonaut results are hidden or closed threads still fills to `limit` from the over-fetched 50 when enough visible matches exist (test, with `includeClosed` absent).
- [ ] Hidden and closed threads are still dropped under `sort=recent` with `includeClosed` absent; with `includeClosed=1` the closed thread is kept and flagged `closed: true` (tests).
- [ ] The 0.4-failing ordering test uses a search word the default fixture does not contain, one old session that repeats it many times and one new session that mentions it once, with `limit=1` (relevance's recency boost is at most 1.25x, so the dense old match wins under relevance and on 0.4).
- [ ] Toggle persists and re-runs immediately (checked by hand and recorded, as for the date range).
- [ ] Tests isolate state dirs and the memonaut index in temp dirs and leave the real ones untouched.
- [ ] `CONTEXT.md` "Conversation search" documents `sort`, the over-fetch under `recent` (and the no-headroom case at 50), and the memonaut 0.5 requirement; `docs/USAGE.md` `GET /search` lists `sort` (`relevance` | `recent`, error on unknown values, `score` informative only under `recent`) AND `since` (if the date-range task did not already add it); changeset (`"wherever-dev": minor`).

## Blocked by

- conversation-search-date-range (serialized: same `/search` route, `conversation-search.ts`, the web search helper and the panel's controls row; also adds the validation spot this task extends).

## Prompt

> Goal: as above; the decisions are in this body (spec for the user stories and the upstream description: `work/specs/tasked/conversation-search-newest-first.md`). memonaut 0.5.0 is published with `SearchQuery.order` (`'relevance' | 'recent'`, exported `SearchOrder` / `SEARCH_ORDERS`); an unknown value throws in memonaut, but wherever validates first so the user gets a well-formed error.
>
> Where to look: `server/src/conversation-search.ts` (`searchConversations`, `SearchParams`, the structural memonaut module type, `MAX_LIMIT`, `filterThreads`) and its test, the `/search` route in `server/src/index.ts` (grep; bounded reads), `searchConversations` in `web/src/lib/session-store.ts`, `web/src/lib/components/ConversationSearch.svelte` (the date-range control from the previous task), `package.nix` (the `pnpmDepsHash` comment), `pnpm-workspace.yaml`. After installing, read memonaut's `.d.ts` in `server/node_modules/memonaut/dist/` to confirm the option; never regex over bundled JS.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): if memonaut's `order` API differs from the above, route to needs-attention.
>
> RECORD non-obvious in-scope decisions in `work/notes/observations/conversation-search-newest-first-decisions.md` and end your final report with a `## Decisions` block linking it. Targeted `CONTEXT.md` edits only. Never write em dashes.
