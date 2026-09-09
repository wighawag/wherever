---
title: Mark folders that do not exist locally in the session browser
slug: missing-folder-badge-in-session-list
spec: restore-missing-folder
blockedBy: [restore-clone-panel]
covers: [17]
---

## What to build

On a freshly migrated machine most folders are missing, and today the only way to find out is to open each conversation. Surface it in the list instead.

The sessions listing gains a per-folder existence flag, and the session browser renders a "not cloned" chip on those folders, so the user can see the scale of what still needs restoring before opening anything.

Cost control matters here because the listing is served often and can cover thousands of sessions: compute existence ONCE per distinct folder path with a short-lived cache, in the same spirit as the existing per-folder probes in the session scan, and invalidate it when a restore job completes so a restored folder loses its chip without a manual refresh.

## Acceptance criteria

- [ ] The sessions listing reports, per folder, whether that folder exists on this machine.
- [ ] Existence is computed once per distinct folder path per listing pass, not once per session, and is cached briefly rather than re-stat'ed on every request.
- [ ] Completing a restore invalidates the cache so the chip disappears without a manual refresh.
- [ ] The session browser renders the marker distinctly from the existing read-only folder treatment (a missing folder and a configured read-only folder are different things and must not look the same).
- [ ] The listing's existing behaviour, ordering, and the ignore and read-only filters are unchanged, and the existing session-list tests stay green.
- [ ] Tests cover a listing containing both an existing and a removed folder, and the post-restore invalidation.
- [ ] **Shared-write isolation:** tests run the server with `HOME` at a temp directory and assert the real home is untouched.
- [ ] A changeset is added for `wherever-dev`.

## Blocked by

- `restore-clone-panel`: both tasks touch the listing and browser surfaces, so this is serialised behind it. Note that the completion signal itself comes from the restore job registry's subscription seam (which that task also consumes), NOT from the panel: subscribe to the registry directly rather than routing invalidation through the WebSocket layer.

## Prompt

> Goal: let a user see, from the session list alone, which conversations point at folders this machine does not have.
>
> FIRST, check this task against current reality (launch snapshot, may have DRIFTED): does the sessions listing still group sessions by folder with a per-folder read-only flag, and did restore completion land as an observable server-side event? If not, route to needs-attention.
>
> Vocabulary: a FOLDER entry in the listing groups sessions by cwd and already carries a read-only flag derived from configuration. You are adding a second, orthogonal per-folder fact: does it exist locally. Do not conflate the two in the UI.
>
> Where to look, by concept: the session pool's cached, incremental disk scan and its existing per-directory probes and caches (that scan is performance-sensitive and documented as such, with measured cold and warm pass numbers, so respect its caching discipline rather than adding a stat per session); the sessions HTTP endpoint and its response shape; the session browser component and how it renders the read-only folder treatment today.
>
> Performance constraint, stated because it is easy to get wrong: a naive existence check per session on a directory of thousands of sessions turns a warm listing pass into a syscall storm. One check per distinct folder path, cached, invalidated on restore completion.
>
> Seams to test at: the sessions endpoint response, and the invalidation behaviour after a restore completes.
>
> Done means: a migrated machine shows at a glance which folders still need restoring, at no meaningful cost to listing performance.
>
> RECORD non-obvious in-scope decisions durably and link them from the done record.
