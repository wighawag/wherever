---
title: The assistant session (an opt-in, resettable, proactive general assistant in a dedicated folder) reachable over pluggable channels (Telegram, Web Push, later WhatsApp) with a server-owned scheduler
slug: assistant-session-and-channels
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Problem Statement

The user wants ONE general-assistant agent they can talk to from anywhere (Telegram first, later WhatsApp, and wherever itself as a chat app via push notifications), that can act PROACTIVELY (scheduled jobs, reminders, "tell me when X"), and that remembers what matters across resets without depending on one ever-growing transcript.

Existing options do not fit:

- **OpenClaw** does this but brings far more than wanted (its own runtime, integrations and conventions), and does not tie into wherever.
- **`badlogic/pi-telegram`** (MIT, a single `index.ts` pi extension) is a Telegram DM bridge INTO one running pi session: it polls only while that session is up and `/telegram-connect`ed, so a reset or restart needs a manual reconnect. It has no scheduler and no way for the agent to start a conversation (purely reactive), and its Telegram-specific inbound, outbound and session ownership are fused together, so it cannot grow a second channel. It is a remote control for a session, not an assistant. Its Telegram mechanics (long polling, draft streaming with `sendMessageDraft` falling back to `sendMessage` + `editMessageText`, 4096-char splitting, inbound file download, `stop`) are good and reusable.

wherever already owns most of the hard parts:

- an always-on server holding pi sessions (`server/src/session-pool.ts`), whose `sendUserMessage` already reaches BOTH server-built sessions and CLI-bridge sessions (relayed as `cli_message`, handled in `extension/src/index.ts`);
- self-contained custom tools registered in both session types (`attach_file`, `say`, with a drift test);
- an opt-in special folder precedent: `searchFolder` in the config, with `maybeSeedSearchWorkspace` dropping a default `AGENTS.md` once;
- web composer `/new` and `/reset`, handled locally in `ChatInput.svelte`, which already create a new session in the current folder;
- a PWA service worker (`web/src/service-worker/index.ts`) that ALREADY handles `push` events (declarative `web_push: 8030` payloads, foreground postMessage vs `showNotification`) and `notificationclick` with a `navigate` target.

What is missing: the assistant folder + session pointer, a channel seam, a scheduler, a way for a CLI-bridge tool to CALL the server, the push subscription + send side, and the web surfaces to reach it all.

## Solution

All inside wherever, opt-in:

1. **The assistant folder + assistant session (opt-in, like `searchFolder`).** A config key `assistantFolder` with NO default: unset = feature off (no tools in server-built sessions, no channels, no scheduler, nothing written; CLI-bridge sessions always carry the tool twins, which then return a "not configured" error, see decision 11). The folder is the assistant's HOME and MEMORY, seeded once with a default `AGENTS.md` (and `jobs/AGENTS.md`, `.gitignore`). The SESSION is disposable; the FOLDER is the memory. Exactly one session in that folder is the CURRENT assistant session (a pointer the server keeps in its state dir). "Reset" = a fresh session in the folder becomes the pointer target.
2. **A channel seam in the server.** One interface every transport implements. v1 adapters: **Telegram** (porting pi-telegram's mechanics) and **Web Push** (wherever as the chat app). WhatsApp later. The web UI is the session as it is today, plus an Assistant entry point.
3. **A server-owned scheduler.** Jobs are written by the `assistant_schedule_*` tools (callable from ANY session) into the assistant folder's `schedule.json` and always RUN as the assistant: **inline** (delivered into the current assistant session once it is settled with nothing queued) or **isolated** (a fresh session in `<assistantFolder>/jobs/`, started immediately, in parallel). NOT the system crontab, whose detached `pi -p` output has nowhere to go.
4. **`assistant_notify` + message-level routing.** A REPLY goes back to the channel of the user message it answers (the web always shows the session). ANYTHING NOT A REPLY reaches the user ONLY through `assistant_notify`, which is delivered IMMEDIATELY (never waits for a running turn) and is visibly distinct from a reply on Telegram. No automatic push on turn end.
5. **A bridge request/response path** so the `assistant_*` tools also work in a CLI-bridge session: the wherever pi extension (which already holds a WebSocket to the server) gains a request message with a correlation id, and the server answers it.

## User Stories

1. As a user, I want the assistant to be OPT-IN with no default folder (I set `assistantFolder` myself, like the search folder), so that nothing changes for an install that does not want it and no `assistant_*` tool appears in server-built sessions unless I enabled it (terminal pi sessions always carry the tools, which then answer "assistant not configured").
2. As a user, I want a single general-assistant conversation I can reach from Telegram, so that I can ask it things from my phone's messaging app without opening wherever.
3. As a user, I want the same assistant reachable from the wherever web app through an Assistant entry point that always opens the CURRENT assistant session, with a push notification when it deliberately tells me something while I am away, so that wherever works as a chat app for it.
4. As a user, I want to reset the assistant's session whenever I like (`/new` or `/reset` on Telegram, `/new` or `/reset` or a Reset button in the web) without losing what it has learned, so that context stays small and fresh.
5. As a user, I want the assistant to keep its durable memory, INCLUDING its schedule, as plain files in its folder, so that I can read, edit, version (git) and back up what it remembers and what it will do.
6. As a user, I want the assistant to schedule its own jobs ("every morning at 8, brief me on X", "remind me Friday about Y", "check Z every hour and tell me if it changes"), so that it can be proactive.
7. As a user who travels, I want "every morning at 8" to mean 8 where I am NOW, while "call mom at 6pm her time" stays pinned to her timezone, so that reminders arrive at the right local time.
8. As a user, I want to see, edit and cancel scheduled jobs (by asking any agent, or by editing the file), so that nothing runs that I do not know about.
9. As a user, I want a heavy, slow or possibly-urgent job to run off to the side (isolated, in parallel) and only notify me with its result, and the assistant to DELEGATE long work that way instead of blocking our conversation, so that the conversation stays responsive and readable.
10. As a user, I want to hear from the assistant ONLY when it deliberately notifies me (or answers something I sent), so that proactivity never turns into noise.
11. As a user, I want a notification to reach me IMMEDIATELY even while the assistant is busy in a Telegram exchange with me, and to be visibly marked as a notification (not part of the current conversation), so that important things are never delayed and never confused with replies.
12. As a user working in ANY wherever session (e.g. a coding session), I want that session's agent to be able to hand a scheduled job to the assistant ("check CI in 30 minutes and tell me"), so that I get follow-ups without switching sessions, and that job lands in the assistant's single schedule where I can see it.
13. As a user working in ANY wherever session, I want that session's agent to be able to notify me through the assistant's channels ("the deploy finished", "tests are red"), and tapping the notification to open THAT session, so that I am made aware of things wherever I am.
14. As a user, I want only ME to be able to talk to the assistant on Telegram, paired with a one-time code shown in the web UI (or a configured user id), with a re-pair action in the web, so that whoever finds the bot handle first cannot claim it.
15. As a user, I want a Telegram message sent while the assistant is mid-turn to STEER that turn (as the web composer does), and Telegram to SHOW me it steered rather than started a new turn, so that I understand what happened to my message.
16. As a user, I want `!command` shell shortcuts refused on channels and in scheduled prompts, so that nothing the assistant controller feeds in can run a shell command or raise a sudo prompt without an agent turn.
17. As a user, I want files to flow both ways on a channel (send an image or document in; the agent's `attach_file` delivers out), so that the assistant is as useful as in the web app.
18. As a user, I want to stop a running turn from any channel (`stop`), so that the channel behaves like the web composer.
19. As a user, I want the assistant to keep working (channels connected, schedules firing) across wherever restarts and session idle eviction, so that proactivity does not depend on a tab or terminal staying open.
20. As a user, I want to be able to attach a terminal pi to the assistant session (CLI bridge) and still have channels AND the `assistant_*` tools work, so that I can drive it from a terminal when I want to.
21. As a user, I want isolated job sessions to live in their own `jobs/` subfolder, so that they group separately in the sidebar and never put the main assistant session into the "folder in use" read-only state.
22. As a maintainer, I want transports behind one channel interface, so that adding WhatsApp (or email, Signal, ...) is an adapter, not a redesign.
23. As a maintainer, I want server-written assistant state in the STATE dir and secrets resolved and scrubbed per ADR 0007, so that a read-only (sops-nix) config dir keeps working (ADR 0006) and the agent's shell cannot read the bot token.

> Tasked. The resolved decisions, implementation and testing detail moved to the 12 tasks in `work/tasks/` (`spec: assistant-session-and-channels`) and the durable rationale to ADRs `docs/adr/0014` (per-message routing, notify-only proactivity), `0015` (schedule intent vs run state, timezones), `0016` (CLI bridge request/response, tool twins), `0017` (in-process Web Push) and `0018` (optional channel secrets fail closed; folder lock placement).

## Out of Scope

- WhatsApp, Signal, email adapters (the seam must allow them).
- Jobs that RUN in another session's folder or inside the originating session. Any session can schedule, but every job runs as the assistant; the origin is context, not the execution location.
- Automatic reset and automatic push on turn end.
- Per-device push management, group chats, multi-user assistants.
- A restricted tool policy for channel-originated turns beyond the `!` refusal.
- A retention policy for isolated job sessions.
- Depending on or extending `push-notification-server`.
- Voice notes over Telegram (could later reuse the cloud STT path behind `/session/transcribe`).
