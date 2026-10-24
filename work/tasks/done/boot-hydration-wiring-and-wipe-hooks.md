---
title: Web: show the cached conversation on boot, guard the boot window, and wire the wipe hooks
slug: boot-hydration-wiring-and-wipe-hooks
spec: instant-resume-from-cached-conversation
blockedBy: [client-hydration-seam-and-server-key, conversation-cache-indexeddb-module]
covers: [1, 2, 5, 7, 11]
---

## What to build

Wire the cache and the client seam into the app so a reload after the OS killed the PWA shows the conversation immediately:

- **Boot:** when the URL hash names a session, read the cache (awaiting at most ~300 ms; boot already defers 200 ms). On a hit, `hydrateCachedSession` and connect with `preserveState: true` (`wherever.ts`'s `connect()` gains a preserve option). On a miss, boot is unchanged.
- **Boot window guard:** written around the `noteVisible()` call that `client-liveness-probes-before-teardown` added to the same handlers (that task lands first, via `client-hydration-seam-and-server-key`). A `booting` flag holds off the `pageshow` / `visibilitychange` plain `connect()` (which would reset the store); it clears as soon as boot has ISSUED its own `connect()` call (not when the socket opens, or an offline cache miss would hold the handlers off indefinitely).
- **Writes:** save the active conversation under the STAMPED key (`serverKey` in the client's `WhereverState`) on `message_history`, `agent_end`, `visibilitychange: hidden`, `pagehide`, and throttled while streaming.
- **Wipe hooks:** both Disconnect actions clear the cache, ONLY in the two `handleDisconnect` handlers (`+page.svelte` and `ConnectionSettings.svelte`), NEVER in the shared `disconnect()` in `wherever.ts`: Settings' Connect and the page's Reconnect both call `disconnect()` before `connect()`, and wiping there would break story 7. Every `connect()` calls `retainOnly(serverKey(cfg))`. Reconnect and a same-server Connect wipe nothing.
- **`hydration_rejected`:** clear the hash with `history.replaceState` SYNCHRONOUSLY in the listener, before any await, then evict the record. The page's own hash-writing effect otherwise clears it with `location.hash = ''` (a history entry).
- **"Load older messages"** is hidden or disabled while `historyAuthoritative` is false.
- Decisions go into a pure `web/src/lib/core/` module (history, cache and client injected), following the `decideHashJoin` pattern, because the web tests run in a node environment with no DOM.

## Acceptance criteria

- [ ] After a reload with a cached hash session, the conversation renders before the socket connects, the composer is editable, and Send is blocked until the resync.
- [ ] A cache miss boots exactly as today; a `pageshow` / visibility event during boot does not wipe a hydration in progress.
- [ ] Both Disconnect actions wipe; every connect retains only the current key; Reconnect and same-server Connect wipe nothing; nothing is written under a key other than the stamped one.
- [ ] `hydration_rejected` clears the hash without a history entry and evicts the record; the dead session is not re-joined.
- [ ] 'Load older messages' is unavailable until `historyAuthoritative`.
- [ ] The decision module is unit-tested; the Svelte wiring is checked manually, including a real Android kill-and-reopen.

## Blocked by

- `client-hydration-seam-and-server-key`
- `conversation-cache-indexeddb-module`

## Prompt

> Goal: final slice of `work/specs/tasked/instant-resume-from-cached-conversation.md` (rationale: ADR 0013). Uses the client seam (`hydrateCachedSession`, `serverKey`, `hydration_rejected`, `historyAuthoritative`) from `client-hydration-seam-and-server-key` and the cache module from `conversation-cache-indexeddb-module`; read their done records.
>
> Where to look: `web/src/routes/+page.svelte` (`onMount` boot `connect()`, `handleVisibility`, `handlePageShow`, the hash-writing `wasSessionActive` effect, the hash auto-join with `decideHashJoin` / `hashJoinAttempt`, `handleDisconnect`), `web/src/lib/components/ConnectionSettings.svelte` (`handleDisconnect`, the Connect handler), `web/src/lib/wherever.ts` (`connect`, `disconnect`, the `onMessage` listener), `web/src/lib/components/ChatMessageList.svelte` ("Load older messages"). CONTEXT.md "The URL hash auto-join never retries a failed load" explains the hash rules.
>
> Done = acceptance cases met; decisions unit-tested.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim boot-hydration-wiring-and-wipe-hooks --arbiter origin
git fetch origin && git switch -c work/boot-hydration-wiring-and-wipe-hooks origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/boot-hydration-wiring-and-wipe-hooks.md work/tasks/done/boot-hydration-wiring-and-wipe-hooks.md
```
