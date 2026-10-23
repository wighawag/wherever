---
title: Web: bounded on-device conversation cache (IndexedDB)
slug: conversation-cache-indexeddb-module
spec: instant-resume-from-cached-conversation
blockedBy: []
covers: [8, 9, 10, 12]
needsAnswers: true
---

## What to build

A self-contained web module that stores recently viewed conversations on the device. It takes the server key as a plain string and does not depend on the client package:

- IndexedDB store `wherever-conversation-cache`. Records `{ serverKey, sessionId, sessionFile, cwd, model, messages, historyTotalCount, historyOffset, savedAt }`, keyed by `(serverKey, sessionId)`.
- API (shape is the implementer's call, keep it small): `get(serverKey, sessionId)`, `put(record)`, `retainOnly(serverKey)` (delete every other key), `clear()`.
- **Normalization at write time:** drop `delivery`-tagged user messages (recovered separately from localStorage), force `isStreaming: false` on every message, drop tool-image payloads.
- **Bounds:** at most 5 sessions in total across all keys (global LRU by `savedAt`) and ~2 MB per record, trimming the oldest messages (offsets are kept as-is; they only drive an affordance).
- **Write throttling helper:** coalesce writes so a streaming reply costs at most one write every ~5 s, plus immediate flushes on demand (the caller decides the triggers).
- **Failure:** if `indexedDB.open` throws or rejects, the module disables itself for the page and every call is a harmless no-op.
- Multi-tab: last write wins; document it.

## Acceptance criteria

- [ ] Normalization strips `delivery` messages, streaming flags and tool images.
- [ ] The byte cap trims oldest messages; LRU keeps at most 5 sessions.
- [ ] Records are scoped by key string; `retainOnly(key)` deletes every other key.
- [ ] With IndexedDB unavailable, every call is a no-op without throwing.
- [ ] Unit tests use `fake-indexeddb` (added as a web dev dependency) in the existing node-environment vitest setup.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: build `web/src/lib/core/conversation-cache.ts` (or similar) per this task file (the spec `work/specs/tasked/instant-resume-from-cached-conversation.md` has the user stories; the rationale is in ADR 0013). The message shape is the client's `ChatMessage` (`client/src/types.ts`); identify the `delivery` field and tool-image fields there. Follow the style of the existing pure `web/src/lib/core/*.ts` modules and their `*.test.ts` files.
>
> Add `fake-indexeddb` with pnpm in the `web` package. Note the repo's pnpm 11 trap (`work/notes/observations/pnpm-11-build-fails-and-writes-allowbuilds-stub-into-workspace-yaml.md`): do NOT commit an `allowBuilds` stub into `pnpm-workspace.yaml`, and if the lockfile changes, check whether `package.nix`'s `pnpmDepsHash` needs regenerating. Done = acceptance cases tested.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim conversation-cache-indexeddb-module --arbiter origin
git fetch origin && git switch -c work/conversation-cache-indexeddb-module origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/conversation-cache-indexeddb-module.md work/tasks/done/conversation-cache-indexeddb-module.md
```
