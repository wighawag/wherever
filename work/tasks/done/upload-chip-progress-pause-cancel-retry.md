---
title: Composer attachment chips show progress, paused state, Cancel, Retry and 'pick again'
slug: upload-chip-progress-pause-cancel-retry
spec: resumable-chunked-uploads
blockedBy: [chunked-upload-client-state-machine]
covers: [1, 3, 4, 5, 8]
---

## What to build

The composer's attachment chips (`ChatInput.svelte`) render upload state fed ONLY by the `onProgress({acked, size, state, error?})` callback of `uploadFile()` (`ChatInput` never sees an `uploadId`, and POST uploads never enter the client's store, so the callback is the one source for both). A chip not yet handed to `uploadFile` (later files of a multi-pick wait for earlier ones, since `handleFileChange` uploads one at a time) is in a local PRE-START state: spinner with no waiting label, and it blocks Send like the in-flight states. A failure thrown before `uploadFile` runs (e.g. 'No active session') renders as `failed` with Retry. Retry reads the CURRENT `sessionInfo.sessionId` at retry time, not the one captured at pick time.

- a progress bar with a percentage (acked bytes / size) while sending; an indeterminate spinner (not 0%) while `sending` with nothing acked yet, which is all the legacy WS and pre-XHR POST paths ever report;
- "Paused, waiting for connection" while `paused` AND while `queued` (held: no socket, a rejoin pending, or capabilities not yet known), replacing today's label derived from `!connected || resyncing`, so a file picked while offline still says it is waiting;
- `finishing`: the bar at 100% with the spinner;
- a Cancel control while in flight (aborts via the existing `AbortSignal`), and removing the chip still cancels; an upload reporting `aborted` removes its chip (no error, no Retry);
- on failure: the reason, and a Retry control that restarts the upload from the same `File` (no re-pick). Today an attachment drops its `file` once uploading starts; keep the retry `File` under a SEPARATE field (e.g. `retryFile`), NOT `file`: `file` doubles as the search-mode marker (the leave-search-mode effect drops attachments that have it, search submit collects it, and the 📎 "Will be uploaded with the search" chip branch renders BEFORE the error branch), so reusing it would show a failed upload as a search-held 📎. Every failure keeps `retryFile` and shows Retry, EXCEPT `error.code === 'not_readable'` (never matched on message text): drop `retryFile`, show no Retry, and tell the user to pick the file again;
- Send stays disabled while any attachment is pre-start, `queued`, `sending`, `paused` or `finishing` (a failed chip does not block Send), and the in-flight chip is visually obvious.

Decisions that can be expressed as pure logic (chip state from upload state) go into a `web/src/lib/core/` module with unit tests, following the existing pure-module test pattern (the web vitest config is `environment: 'node'`).

## Acceptance criteria

- [ ] Queued/paused (waiting), sending (progress or indeterminate), finishing, failed (with reason), and done states render distinctly on the chip; aborted removes it.
- [ ] Cancel and Retry work; Retry reuses the picked `File`.
- [ ] Send is disabled while any attachment is in flight.
- [ ] The chip-state mapping is unit-tested in a pure `lib/core` module; the Svelte wiring is checked manually on a phone or a throttled desktop browser.

## Blocked by

- `chunked-upload-client-state-machine`

## Prompt

> Goal: surface the upload state machine from `chunked-upload-client-state-machine` in the composer UI (`web/src/lib/components/ChatInput.svelte`: attachments list, `handleFileChange`, `removeAttachment`, `uploadControllers`). Spec: `work/specs/tasked/resumable-chunked-uploads.md` stories 1, 3, 4, 5, 8.
>
> Keep attachments keyed by their stable `id` (never by array index). Match the existing visual language of the chips. Done = all states render, Cancel/Retry work, and the mapping is unit-tested.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR in `docs/adr/` if it meets the `ADR-FORMAT.md` gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). Update `CONTEXT.md` (and `docs/USAGE.md` for protocol changes), and add a changeset per `AGENTS.md` (`"wherever-dev"` for web/server, plus `"@wherever-dev/client"` when the client package changes).

---

### Claiming this task

```sh
dorfl claim upload-chip-progress-pause-cancel-retry --arbiter origin
git fetch origin && git switch -c work/upload-chip-progress-pause-cancel-retry origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/upload-chip-progress-pause-cancel-retry.md work/tasks/done/upload-chip-progress-pause-cancel-retry.md
```

## Decisions

Please link these from the done record:
1. **"Not started yet" is a separate state (`pre-start`), not a reuse of the client's `queued`.** `queued` means the connection is down and shows "Paused, waiting for connection", which would be wrong for a file that simply hasn't had its turn. Recorded in the module comment of `upload-chip.ts`.
2. **A finished upload keeps Send disabled until its saved path arrives.** The "done" callback fires just before `uploadFile` resolves with the path, and the message needs the path. Recorded in `upload-chip.ts`.
3. **Percentages round down**, so 100% only shows once every byte is acknowledged. Recorded in `upload-chip.ts`.
4. **Each upload attempt has its own abort controller**, and updates from an attempt that has been removed or replaced by a Retry are ignored. Recorded at `runUpload` in `ChatInput.svelte`.
5. **Cancel and × both stay on an in-progress chip.** Cancel only aborts and lets the "cancelled" report remove the chip; × aborts and removes at once. The task asks for both; the alternative was showing only one of them while uploading. Recorded at `cancelUpload` in `ChatInput.svelte`.
6. **Retry starts immediately**, even if other files from the same pick are still uploading one at a time. The alternative was queueing it behind them. Recorded at `retryUpload` in `ChatInput.svelte`.
7. **The existing `[Test Link]` diagnostics link stays on ordinary failures**, but is hidden on a "pick the file again" failure. Recorded in the chip markup.
