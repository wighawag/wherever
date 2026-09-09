---
title: Missing session folder is a first-class read-only state (no agent built)
slug: folder-missing-read-only-state
spec: restore-missing-folder
blockedBy: []
covers: [1, 2, 3, 18, 19, 20, 23]
---

## What to build

A session whose working folder no longer exists on this machine currently loads as if nothing were wrong: the transcript paints from the cheap header/history read, and the server then builds a live agent against a directory that is not there. Verified: pi's settings manager and resource loader both succeed against a nonexistent cwd, so nothing throws and the user only discovers the problem when every tool call misbehaves.

Make it an explicit state, end to end:

- The cheap session meta read (the same place the read-only verdict is already computed from the cwd) also reports whether the folder EXISTS.
- When it does not, the transcript still paints (reading never needed the folder), the client is marked read-only with a distinct folder-missing reason, and the cold path does NOT build the live agent at all.
- A new server frame carries the state and the absolute missing path (later tasks extend it with remote candidates and any running restore job).
- Read-only precedence is explicit and tested: a configured read-only folder rule is hard and never lifted; folder-missing is hard and lifted only by a successful restore plus a reload; a folder conflict remains the only dismissible one. The existing "Continue anyway" path must NOT lift a folder-missing lock.
- The shared client package carries the new frame and flag so the VS Code companion compiles; the web dashboard renders a notice naming the missing absolute path where the composer would be. The restore ACTIONS are a later task: this task ends at an honest, locked, explained state.
- A client that predates the flag simply does not render the notice; the server's own refusal to accept messages while read-only is what protects it.

Two boundaries to state rather than leave to judgement:

- **The warm/resident branch.** The load handler serves an already-resident session from a different branch than a cold one, and the existence check lives in the shared cheap meta read, so it fires for both. A resident session whose folder vanished underneath it is LOCKED read-only like any other, but its live agent is NOT torn down and no attempt is made to detect the disappearance while it runs: mid-session disappearance is explicitly out of scope for this spec, and this task only refuses to hand out a fresh write capability for a folder that is not there.
- **The interim state is deliberate.** Until the restore panel lands (a later task), a folder-missing session is locked with NO remedy offered. That is intentional and is strictly better than today's silent breakage, where the agent runs against a directory that does not exist. It is not a regression and should not be reported as one.

## Acceptance criteria

- [ ] Loading a session whose cwd was removed paints its history, reports the folder-missing read-only verdict, and never builds a live agent (no ready signal, the composer stays disabled).
- [ ] A message sent anyway while in that state is refused by the server (assert the fake LLM never receives a request).
- [ ] A cwd that matches a configured read-only rule AND is missing stays read-only after any dismiss attempt; the folder-conflict continue path does not lift a folder-missing lock.
- [ ] A session whose folder DOES exist loads exactly as before (the existing fast-load and folder-conflict tests stay green).
- [ ] The web dashboard replaces the composer with a notice naming the missing absolute path.
- [ ] A session that is already RESIDENT when its folder is found missing is locked read-only too, and its running agent is not torn down.
- [ ] `CONTEXT.md` documents the new session state: the third read-only reason, its precedence against the configured read-only rule and the folder conflict, and the new frame/flag. The repo's own guidance requires this for protocol and core-behaviour changes, and no later task owns it.
- [ ] The shared client types carry the new frame/flag and the client package builds.
- [ ] Tests cover the new behaviour (mirror the existing harness style: real server, fake LLM, temp agent dir).
- [ ] A changeset is added for `wherever-dev` (the extension package only if `extension/` changes).

## Blocked by

- None, can start immediately. This is the foundation the other restore tasks build on.

## Prompt

> Goal: make "this session's folder does not exist on this machine" an explicit, safe, explained state instead of a silently broken one.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does the session-load path still split into a cheap meta read plus an async agent build, and are the read-only verdict and the folder-conflict banner still computed where this task assumes? If a dependency landed differently, do NOT build on the stale premise, route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> Vocabulary in this codebase: a SESSION has a `cwd` (its working folder); READ-ONLY is a per-client verdict the server owns and re-states authoritatively; a FOLDER CONFLICT is two live sessions in one folder and is dismissible via "Continue anyway"; a configured read-only folder rule is hard. You are adding a THIRD read-only reason, FOLDER MISSING, which is hard but curable (by a later restore task plus a reload).
>
> Where to look, by concept not by path: the session pool's cheap "read session meta" function (header, history window, read-only verdict) versus its agent-building load; the WebSocket session-load handler that paints first and builds asynchronously; the helper that re-states the folder-conflict verdict to a client; the protocol module where client and server frames are declared; the shared client package's types and its frame handling; the web dashboard component that renders the composer and the existing conflict banner.
>
> Two verified facts that motivate this work, do not re-derive them: pi's `SettingsManager.create()` and `DefaultResourceLoader.reload()` against a nonexistent cwd both return successfully without throwing, which is exactly why today's failure is silent; and the cheap meta read already computes a read-only verdict from the cwd, so the existence check belongs beside it and costs one stat call.
>
> Seams to test at: the WebSocket protocol (load a session, assert the frames and the verdict) and the refusal of a send. Do not assert on internal function calls. Prior art: the folder-conflict and fast-session-load tests.
>
> Done means: the state is detected, no agent is built, the client is locked with an explanation naming the path, precedence against the other two read-only reasons is tested, and existing behaviour for present folders is untouched.
>
> RECORD non-obvious in-scope decisions you make while building, durably and linked from the done record (an ADR in `docs/adr/` if it meets the ADR gate, otherwise a JSDoc at the choice site or a `## Decisions` block in the done record). An un-recorded in-scope decision is a review finding, not a silent default.
