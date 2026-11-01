---
title: Incremental reconnect resync (re-send only the history a reconnecting client does not have)
slug: incremental-reconnect-resync
needsAnswers: true
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

<!-- open-questions -->

## Open questions

1. **Where may a delta start?** Proposed: the server backs the start up from `haveCount` to the nearest CLEAN BOUNDARY at or before it, i.e. an index with no tool call before it still waiting for its result, so the mapped delta never needs a call that lives in the client's held part. The alternative is to seed the client's history mapper with the held part's still-open calls (no overlap, but the mapper gains cross-batch state). Which one? (The first is proposed below; it costs a few re-sent messages and keeps the mapper stateless.)
2. **Should the instant-resume cache (ADR 0013) take part in v1?** A hydrated cached conversation could also resync by delta if the cache record stored `haveCount` + fingerprint. That is the largest win (every cold PWA start), but it also means trusting a record written by an older build. Proposed: v1 covers live reconnects only; the cache is a follow-up.
3. **Delta size cap.** Proposed: if the delta would be larger than `INITIAL_HISTORY_LIMIT` messages, send the normal full window instead (the client would page anyway). Agree, or always send the delta?

<!-- /open-questions -->

## Problem Statement

On a phone the WebSocket drops all the time: the screen locks, the file picker backgrounds the page, the network switches from Wi-Fi to cell. Every reconnect re-joins the session with `session_load`, and the server answers with the WHOLE recent window (the last 60 history messages), even though the client already holds all of them except, typically, the last few. After the slow-link work (chunked frames, images by reference, permessage-deflate; CONTEXT.md "Slow links") that is no longer catastrophic, but it is still 50 to 200 KB per reconnect for a text-heavy session, i.e. several seconds of "Reconnecting and syncing session..." on a weak link, during which sending is blocked. The user pays it on almost every return to the app.

## Solution

A reconnecting client tells the server how much history it already has, with a fingerprint proving it is the same history. When the fingerprint matches the transcript on disk, the server answers with only the messages the client is missing (plus a small overlap back to a clean boundary), and the client replaces just the tail of its conversation. When anything does not match (the file was rewritten, the client's state is not authoritative, the delta would be too big, an older server), the server sends the full window exactly as today. A reconnect after a short drop then costs a few hundred bytes, and the resync banner flashes instead of lingering.

The full window stays the fallback for every doubtful case, so the worst outcome of a bug in the matching is today's behaviour, never a corrupted conversation.

## User Stories

1. As a phone user, I want reconnecting after a short drop to resync in well under a second even on a weak link, so that I can keep reading and sending without staring at a resync banner.
2. As a phone user, I want the conversation after an incremental resync to be EXACTLY what a full reload would show (same messages, same order, same tool-call pairing, same interrupted/streaming markers), so that the optimisation is invisible.
3. As a user whose agent kept working while I was disconnected, I want every message persisted during the gap to appear after the resync, so that nothing that happened while I was away is missing.
4. As a user who was watching a reply stream when the socket dropped, I want the partial, never-persisted text I had on screen to be replaced by the authoritative state (and the live stream to resume), so that I never see a duplicated or half-stale reply.
5. As a user with an unsent or unconfirmed message when the socket dropped, I want the existing delivery reconciliation (confirmed if it is in the transcript, re-surfaced as failed if not) to keep working with a delta, so that a message is never silently lost or shown twice.
6. As a user, I want a queued steer, the folder-conflict / read-only / folder-missing verdicts and the context-usage indicator to be restored on an incremental resync exactly as on a full one, so that only the HISTORY payload changes.
7. As a user, I want "Load older messages" to keep working after an incremental resync (same paging offset, correct total), so that I can still scroll back.
8. As a user of an older cached web build against a new server (or a new web build against an older server), I want reconnects to keep working with the full window, so that mixed versions never break.
9. As a user whose session file was rewritten or replaced (a reload migration, an external edit, a different session at the same path), I want the server to detect the mismatch and send the full window, so that I never get a delta glued onto the wrong history.
10. As a user switching sessions, I want a FRESH load (not a reconnect of the session on screen) to always get the full window, so that the delta path only applies when the client really holds that session's history.
11. As a user whose client state is not authoritative (still showing a cached hydration, or a load still in flight), I want the full window, so that a delta is only ever applied on top of history the server itself sent.
12. As a developer, I want the history mapping of a delta to be a pure, unit-tested function of (held messages, delta), so that the cases in stories 2 to 5 are pinned by tests rather than by manual reconnect testing.
13. As a developer, I want the slow-link bench (`server/test/bench/slow-link.ts`) to report the bytes and time of a reconnect resync before and after, so that the gain is measured, not assumed.

### Autonomy notes

- **`humanOnly`:** not set. The design is mechanical once the open questions are answered; tasks can be agent-built.
- **`needsAnswers`: true.** Three open questions above change the shape of the tasks (boundary policy, cache participation, size cap).

## Implementation Decisions

- **Server stamps a fingerprint; the client never computes one.** Every `message_history` (full window or delta) carries `tailFingerprint`: a short hash of the LAST history message of the transcript at the time of the read (role, timestamp, toolCallId, content). The client stores it next to `historyTotalCount`, and only while `historyAuthoritative` is true.
- **`session_load` gains optional `haveCount` + `haveFingerprint`**, sent by the client only on the onOpen REJOIN of the session it is showing (never on `joinSession` to another session, never while `historyAuthoritative` is false). Absent fields mean today's behaviour, which is what keeps older servers and clients compatible in both directions.
- **Server-side check** (in the transcript reader, one bounded pass like the window read): the message at index `haveCount - 1` exists and its fingerprint equals `haveFingerprint`. Mismatch, `haveCount > total`, or a delta over the cap (Open question 3): full window.
- **Delta frame:** the existing `message_history` with `mode: 'delta'` and `from` (the first index included, the clean boundary at or before `haveCount`, Open question 1), plus the usual `totalCount`; `offset` is not changed by a delta. A client that does not know `mode` cannot receive one (it never sent `haveCount`).
- **Client keeps the raw history index on each mapped message** (the index into the server transcript that produced it), so "replace everything from raw index `from`" is exact. Live-derived messages (built from streaming events since the last history) carry no raw index and are always dropped by a delta, which is what implements story 4.
- **Reducer:** `messages = held messages with raw index < from` + `mapHistory(delta, streaming tail as today)` + the undelivered set, with the delivery reconciliation run against held + delta user messages. One pure function, unit-tested.
- **Everything else in the `session_load` reply is unchanged** (session_created, queue_update, verdict frames, session_ready): only the history payload shrinks.

## Testing Decisions

- Pure client tests (fake socket harness, like `client/test/reconnect-rejoins-session.test.ts`): for a set of transcripts, an incremental resync and a full resync produce deep-equal `messages`; cover a tool call open across the boundary, a dangling call frozen as interrupted, a streaming tail, an unconfirmed outbound message delivered during the gap and one lost in it.
- Server tests on the real harness (`server/test/harness.ts`): a delta for a matching fingerprint, a full window for a wrong one, for `haveCount` beyond the total, for a rewritten file, and when the fields are absent.
- Bench: extend `server/test/bench/slow-link.ts` with a drop-and-reconnect step and report resync bytes and time.

## Out of Scope

- Instant-resume cache participation (Open question 2; follow-up if deferred).
- Incremental "load older" paging (it already fetches only what it asks for).
- Any change to how the live stream resumes after the rejoin (unchanged).

## Further Notes

- Origin: `work/notes/ideas/slow-link-incremental-resync-and-delta-coalescing.md` (the delta-coalescing half of that note shipped).
- The transcript is read linearly as append-only (`readTranscriptWindow` maps every `message` entry in file order), which is what makes "indices before `haveCount` are unchanged" true for an appended file. The fingerprint is the guard for every case where that assumption fails.
