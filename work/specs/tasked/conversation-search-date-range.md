---
title: Bound conversation search by date (Any time, 24 h, 7 days, 30 days)
slug: conversation-search-date-range
taskedAfter: [closed-sessions]
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + `CONTEXT.md` + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Problem Statement

Conversation search (`GET /search`, the memonaut-backed panel) ranks by relevance, with only a gentle recency nudge (memonaut boosts a match from today by up to 1.25x, decaying to about 1.0x after a year). Very often the user remembers roughly WHEN something was discussed ("we talked about this yesterday", "last week's session about X"), and with agents spawning many sessions the same terms appear in many transcripts, so older, denser matches bury the recent one. There is no way to say "only the last 7 days" from the web.

## Solution

A **date range** selector in the search panel (Any time, last 24 hours, last 7 days, last 30 days), passed to `GET /search` as `since` and forwarded to memonaut's existing `since` filter (memonaut 0.4 already supports it, so no upstream change is needed). Results keep their current shape and relevance order; the set is bounded by time. The range bounds when the MATCHED MESSAGE was said (memonaut's entry `ts`), not the session's last activity: inherited fork history keeps its original time, `otherHits` counts only in-window matches, and entries with no `ts` are excluded whenever a range is set. A "Newest first" sort is a separate spec (`conversation-search-newest-first`) gated on a memonaut release.

## User Stories

1. As a user, I want a date range selector (Any time / 24 h / 7 days / 30 days) in conversation search, so that I can narrow search to when I remember the discussion.
2. As a user, I want "Any time" to stay the default, so that existing behaviour is unchanged unless I ask.
3. As a user, I want my range choice to persist on this device across searches, so that I do not reset it every time.
4. As a user, I want each result to still show its relative time ("3 h ago", already true today; a regression guard), so that the range is legible.
5. As a user, I want the range to apply to both the main and the read-only search views, so that the panels behave the same.
6. As a user, I want changing the range to re-run the current query immediately, through the same supersede-the-in-flight-request path as typing, clearing any pending debounce as `submit()` does and doing nothing below the minimum query length, so that the control feels instant and a stale timer cannot fire after it.
7. As a user, I want the window computed when the request is made (now minus the range), so that re-running a query moves the window with the clock.
8. As a maintainer, I want `since` validated server-side: an unparseable `since` answers `status: 'error'` with a message (new behaviour; `view` and `limit` keep coercing as today), and a valid one is normalized with `new Date(since).toISOString()` before forwarding, because memonaut compares `ts` as strings and pi writes `Z`-suffixed ISO timestamps (an offset form like `+02:00` would compare wrongly).
9. As a maintainer, I want the privacy and visibility rules (`filterThreads()`, including the closed rule) applied unchanged, so that a date bound never surfaces a hidden, private or closed thread.

### Autonomy notes

- **`humanOnly`:** omitted.
- **`needsAnswers`:** omitted.
- **`taskedAfter: [closed-sessions]`:** no logical dependency, but both edit the `/search` route, `conversation-search.ts`, the web search helper and the controls row in `ConversationSearch.svelte`; its task is serialized after `closed-sessions-in-search`.

> Tasked: the implementation and testing detail moved into the task `conversation-search-date-range` (`work/tasks/`).

## Out of Scope

- "Newest first" sorting: spec `conversation-search-newest-first`.
- Custom date pickers (the four ranges cover the stated need).
- Sorting the sidebar filter results (the list is already ordered by modification time).

## Further Notes

Supersedes the date-range half of story 10 of the former `session-search-index` spec (deleted: it predated the memonaut backend; see git history). Known, unchanged behaviour: wherever filters hidden / read-only / closed threads AFTER memonaut's limit, so a narrow range can return a short list with "N hidden".
