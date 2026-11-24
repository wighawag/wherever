---
title: Sort conversation search Newest first (needs a memonaut release with search order)
slug: conversation-search-newest-first
taskedAfter: [conversation-search-date-range]
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + `CONTEXT.md` + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

> **Entry gate (cross-repo, not a slug): do NOT promote this spec to `ready/` until memonaut has published a release whose `search()` accepts `order: 'relevance' | 'recent'` with the rules in "Upstream change" below.** A `blockedBy` cannot express this (memonaut has no `work/` folder), and wherever's structural `search` type takes `Record<string, unknown>`, so passing `order` to memonaut 0.4 compiles and is silently ignored: "Newest" would quietly return relevance order. When promoting, fill in the released version below.
>
> Released memonaut version with `order`: _not yet_

## Problem Statement

Conversation search ranks by relevance (with only a gentle recency nudge). The date-range filter (`conversation-search-date-range`) bounds the window, but inside it a recent match can still sit below older, denser ones, and the user often wants simply "the most recent place this was said". memonaut applies its result limit to the relevance ranking, so wherever cannot fix this by re-sorting what it gets back: a recent match ranked 30th would never arrive.

## Solution

A **Relevance / Newest** sort toggle in the search panel. "Newest" is passed to `GET /search` as `sort=recent`, forwarded to memonaut's new `order: 'recent'`, which orders by the matched entry's own timestamp BEFORE applying the limit. Results keep their current shape.

## User Stories

1. As a user, I want a "Newest" sort option in conversation search, so that the most recent matching conversation is at the top.
2. As a user, I want "Relevance" to stay the default, so that existing behaviour is unchanged unless I ask.
3. As a user, I want "Newest" to mean the newest matches overall (ordered before the result limit, not a re-sort of the most relevant few), so that a recent match ranked low by relevance still appears.
4. As a user, I want a result ordered by when the matched message was said (its entry `ts`), not by its session's last activity, so that "newest" means newest mention.
5. As a user, I want my sort choice to persist on this device and to apply to both the main and read-only search views, so that it behaves like the date range.
6. As a user, I want changing the sort to re-run the current query immediately through the existing supersede path, so that the control feels instant.
7. As a maintainer, I want an unknown `sort` to answer `status: 'error'` with a message, so that a typo never silently falls back to relevance.
8. As a maintainer, I want the privacy and visibility rules (`filterThreads()`) applied unchanged, so that a time sort never surfaces a hidden, private or closed thread.

### Autonomy notes

- **`humanOnly`:** omitted.
- **`needsAnswers`:** omitted (the entry gate above is a release precondition, not an open question).
- **`taskedAfter: [conversation-search-date-range]`:** same files (route, `conversation-search.ts`, the search helper, the controls row).

## Resolved decisions

1. **Ordering happens in memonaut**, not by a wherever-side over-fetch and re-sort.
2. **A hit is ordered by its matched entry's own `ts`.**

## Upstream change (memonaut, made and released in `~/dev/github/wighawag/memonaut`)

Add `order?: 'relevance' | 'recent'` (default `relevance`) to `SearchQuery` in `packages/memonaut`. Today the SQL fetches the best rows by `bm25` (`ORDER BY bm LIMIT fetch`, `fetch = clamp(limit*20, 200, 2000)`), groups rows one hit per lineage (fork family) keeping the best-scoring row, sorts hits by score, then applies `limit`. Swapping only the `ORDER BY` is NOT enough. Under `recent`:

- each lineage is represented by its NEWEST matching entry (the group takeover must compare `ts`, not score, or an older higher-scoring row replaces the newest and the newer match folds into `otherHits`);
- hits are sorted by that entry's `ts` descending, null `ts` last (no final score re-sort);
- up to `limit` DISTINCT lineages are returned even when one busy lineage has more than `fetch` newer matching chunks (e.g. a two-step query: newest matching entry per lineage, then snippet for each chosen entry; or stream rows ordered by `e.ts DESC` with no fetch cap until `limit` distinct lineages; or page. A plain `GROUP BY` with `MAX(e.ts)` likely cannot carry `bm25()` / `snippet()`, which FTS5 does not allow in aggregates), so many recent agent sessions with a common term cannot crowd the result down to a few conversations;
- state what `score` and `scanned` mean under `recent` (the regex path uses `score: 0` and `scanned` = number of groups; the web does not show `score`), and avoid confusing the new `query.order` with the existing local `order` array in `search()`;
- `since` / `until`, the private rules and threads-within-a-hit ordering (by `lastActivity`) are unchanged;
- `recall_search` in `memonaut-pi` gains the same `order` option (agents can ask "most recent mention");
- the regex path is ALREADY newest-first with a newest-per-lineage representative (`regex.ts` sorts candidates by `entry.ts` desc); it accepts `order` for symmetry and treats `relevance` as `recent` (no bm25 there), documented. It is also the precedent for the FTS `recent` rules.

Tests there: ordering by `ts`, newest-per-lineage representative, distinct-lineage count under a busy lineage, `since`/`until` still honoured.

## Implementation Decisions (wherever side)

- `GET /search` gains `sort=relevance|recent` (default `relevance`; unknown value -> `status: 'error'`), mapped to `order`. Bump `server/package.json` to the released memonaut version and add `order?: 'relevance' | 'recent'` to the structural `search` type.
- **Post-limit filtering:** wherever drops hidden / read-only / closed threads AFTER memonaut's limit, and under `recent` the newest lineages are the likeliest to be recent agent or closed sessions. So under `sort=recent` the endpoint asks memonaut for `MAX_LIMIT` and slices to `limit` after `filterThreads`. (Proposed default; confirm at promotion.)
- Web: a Relevance / Newest toggle beside the date range in `ConversationSearch.svelte`; preference in `localStorage`; the request helper gains `sort`.
- Documented in CONTEXT.md "Conversation search".

## Testing Decisions

- A real throwaway-index test (pattern in `server/test/conversation-search.test.ts`) asserting `ts`-descending order under `sort=recent`, including a recent low-relevance match that relevance order would cut. It fails on memonaut 0.4, so it also catches a missed dependency bump.
- `filterThreads` still drops hidden/closed threads under `sort=recent`.

## Out of Scope

- Custom sort keys beyond relevance and recency.
