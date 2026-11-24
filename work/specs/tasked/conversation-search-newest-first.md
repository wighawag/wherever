---
title: Sort conversation search Newest first (needs a memonaut release with search order)
slug: conversation-search-newest-first
taskedAfter: [conversation-search-date-range]
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + `CONTEXT.md` + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

> **Entry gate (cross-repo, not a slug): do NOT promote this spec to `ready/` until memonaut has published a release whose `search()` accepts `order: 'relevance' | 'recent'` with the newest-per-lineage, ordered-before-limit rules (now documented in memonaut's `docs/DESIGN.md`).** A `blockedBy` cannot express this (memonaut has no `work/` folder), and wherever's structural `search` type takes `Record<string, unknown>`, so passing `order` to memonaut 0.4 compiles and is silently ignored: "Newest" would quietly return relevance order. When promoting, fill in the released version below.
>
> Released memonaut version with `order`: **0.5.0** (memonaut-pi 0.3.0), published to npm on 2026-11-24 from memonaut `ad7d3b0`. Gate satisfied. memonaut 0.5 THROWS on an unknown `order`, so a typo fails loudly once wherever is on 0.5.

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
3. **Under Newest, wherever over-fetches to compensate for its own post-limit filtering:** it asks memonaut for the maximum (50) and cuts to the requested limit after hiding ignored / read-only / closed threads (decided by the human at promotion).

> Tasked: the implementation and testing detail moved into the task `conversation-search-newest-first` (`work/tasks/`). The upstream change shipped as memonaut 0.5.0 (memonaut `2d3c28b` / `ad7d3b0`); its rules are documented in memonaut's `docs/DESIGN.md`.

## Out of Scope

- Custom sort keys beyond relevance and recency.
