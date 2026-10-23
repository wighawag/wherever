---
title: Client: hydrate a cached session, stamp its server identity, and reject a dead cached session
slug: client-hydration-seam-and-server-key
spec: instant-resume-from-cached-conversation
blockedBy: [client-liveness-probes-before-teardown]
covers: [3, 4, 5, 6, 9]
---

## What to build

Everything `@wherever-dev/client` needs so the web can show a cached conversation instantly after a reload. This task file is the full specification (rationale: ADR 0013):

- **`serverKey(config)`**, exported, SYNCHRONOUS and pure: `host:port` plus a non-crypto (FNV-1a) hash of the token. (`connect()` is synchronous, and `crypto.subtle` is async and missing on plain-http LAN origins.)
- **Stamping.** `connect()` captures the key next to the socket it opens. It is stamped on the active session when `session_created` arrives and at hydration, and EXPOSED as `serverKey` in `WhereverState` (`client/src/types.ts`), so the web writes the cache under exactly that key. When `connect()`, including the automatic reconnect via `scheduleReconnect`, computes a key different from the stamped one, it wipes the store instead of preserving it (clearing the stamp too, not re-stamping it), does not rejoin, and clears `resumeSessionFile` / `resumeCwd` / `resumeModel`.
- **`hydrateCachedSession(snapshot)`.** A no-op unless there is no `activeSessionFile`, `pendingLoadFile === null` and not connected. It sets `session`, `sessionId`, `activeSessionFile`, `activeCwd`, `activeModel`, messages, `resyncing: true`, `isStreaming: false`, the stamped key; it leaves `agentPending`, `folderConflict`, `sudoPrompt`, `readOnly` at defaults and does not set `pendingLoadFile`. `onOpen`'s existing rejoin then issues `session_load`.
- **`hydration_rejected`.** On an untagged `session_error` answering the hydrated load itself (only the reply to the rejoin's `session_load` counts: with no session attached, the server's catch-all sends EVERY handler error untagged) (`pendingLoadFile === hydratedFile`, no `session_created` yet), clear the session and emit `{type: 'hydration_rejected', sessionId}` to `onMessage` listeners. NEVER on `folder_missing` or a cold-build `session_error` (both arrive after `session_created`).
- **`historyAuthoritative`** in the store: false at hydration and on every `onOpen` rejoin, true on the matching `message_history`. `loadMoreHistory()` is a no-op while false.
- **Dead code.** Remove `resume()`'s early `armLoadWatchdog()`, which `connect()` → `disconnect(false)` clears immediately.

## Acceptance criteria

- [ ] Hydrate, then `connect(cfg, true)`: messages survive, `session_load` is issued for the hydrated file, and `message_history` replaces them.
- [ ] `hydrateCachedSession` after `session_created` (or while connected / loading) is a no-op.
- [ ] Undelivered-message recovery (`loadPersistedPending`, `delivery` tags) is unchanged with a hydrated cache.
- [ ] An untagged `session_error` answering the hydrated load emits `hydration_rejected` and clears the session; `folder_missing` and a cold-build `session_error` after `session_created` do not.
- [ ] An automatic reconnect after host/port were edited does not preserve or rejoin, and clears the stamp; suspend → resume against a dead socket → edit host → automatic reconnect sends no `session_load`.
- [ ] `serverKey` is synchronous and stable; `historyAuthoritative` and the `loadMoreHistory` gate behave as specified.
- [ ] `resume()` with hydrated data and a socket stuck CONNECTING raises no timeout error (regression guard).
- [ ] All cases are covered by client tests (vitest + `client/test/harness.ts`).

## Blocked by

- `client-liveness-probes-before-teardown` (no design dependency: both edit `client.ts`'s connection code, so they are serialised to avoid conflicts)

## Prompt

> Goal: add the client half of `work/specs/tasked/instant-resume-from-cached-conversation.md` (rationale: ADR 0013) to `client/src/client.ts` (`connect`, `disconnect`, `scheduleReconnect`, `suspend`/`resume`, `onOpen` rejoin, the `session_created` / `message_history` / `session_error` reducers, `loadMoreHistory`) and its exported types in `client/src/types.ts`. The web cache and boot wiring are separate tasks; this task must not touch IndexedDB.
>
> The web's only `onMessage` listener (`web/src/lib/wherever.ts`) and the reducer both ignore unknown types, so a synthesized `hydration_rejected` is safe. Done = every acceptance case tested, existing tests green.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim client-hydration-seam-and-server-key --arbiter origin
git fetch origin && git switch -c work/client-hydration-seam-and-server-key origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/client-hydration-seam-and-server-key.md work/tasks/done/client-hydration-seam-and-server-key.md
```
