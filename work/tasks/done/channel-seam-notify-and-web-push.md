---
title: Channel seam, assistant_notify, and Web Push (wherever as the chat app)
slug: channel-seam-notify-and-web-push
spec: assistant-session-and-channels
blockedBy: [assistant-schedule-tools-server]
covers: [3, 10, 11, 13, 22]
---

## What to build

The channel interface, the one way the assistant reaches the user proactively (`assistant_notify`), and its first transport, Web Push. Read `docs/adr/0014` (only `assistant_notify` notifies) and `docs/adr/0017` (Web Push in-process).

- **Channel interface** (server): `start()` / `stop()`; inbound `onUserMessage({channel, text, files, senderId})` to the controller; outbound `deliverReply(...)` fed from the pool's event fan-out for output whose current destination (`pool-per-message-routing`) is that channel; `notify({title, body, source, navigate, files?})`, always immediate. Web Push implements `notify` only. The controller reports the messages it RECORDED as dropped (by a reset in `assistant-pointer-and-reset`, by an aborted settle in `assistant-scheduler`) to the channels of their routing origins through this interface. Channels start only while `assistantFolder` is configured AND the folder lock is held.
- **`assistant_notify` server tool**, in every server session when `assistantFolder` is configured. Args `{title, body, navigateSessionId?, jobId?}`. Delivered IMMEDIATELY to every enabled channel, never waiting for a running turn. Tap target: `navigateSessionId` if given; else, if `jobId` is given or the caller is an isolated job session (the scheduler's job mapping), the job's origin session; else the calling session. `source` = origin folder or session name. Clear error when no channel is enabled. Its text goes in the shared tool-text module created by `assistant-schedule-tools-server` (the owner), which the CLI twins reuse. Server-tool registration in `buildServerAgent()` builds on that task's.
- **Web Push.** VAPID keypair generated on first use in the STATE dir (mode 0600); VAPID `subject` (`mailto:` or URL) from config, defaulting from the configured public URL. Token-gated `POST` / `DELETE` subscription endpoints; subscriptions in the state dir; send `{web_push: 8030, notification: {title, body, navigate: '/#<sessionId>'}}` (the service worker's `DeclarativePushNotification` shape); 404/410 prunes. Use the `web-push` package or borrow the sibling `push-notification-server`'s WebCrypto sender.
- **Status.** The assistant status gains the Web Push state (enabled, VAPID public key available, this device subscribed).
- **Web.** A settings toggle subscribing / unsubscribing THIS device via `PushManager.subscribe` with the server's public key. DELETE the unused template module `web/src/lib/core/service-worker/push-notifications/` (no importers). Fix the FOREGROUND notification click: it uses SvelteKit `pushState`, which does not fire the `hashchange` the page listens to, so a `/#<sessionId>` target does not open the session today.

> FORWARD-POINTER (drive conductor, 2026-10-30): (1) when you record non-obvious decisions in a note, the done record must link it: end your final report with a `## Decisions` block (the runner copies that block verbatim into `work/tasks/done/<slug>.md`), written AS the done-record section itself, e.g. `The non-obvious in-scope decisions (...) are recorded in [work/notes/observations/<slug>-decisions.md](../../notes/observations/<slug>-decisions.md).` Do not address the reviewer in it. An unlinked note fails review. (2) Earlier tasks in this chain established conventions to build on (see the `## Decisions` links in `work/tasks/done/`): the assistant status has an `active` flag (configured AND this server holds the folder lock); anything that RUNS or WRITES assistant state (scheduler, channels, polling, keys, pointer) gates on `active`. Where THIS task says a tool is registered when `assistantFolder` is configured, keep that and make the tool return a clear lock-state error when not active. This task's own text and acceptance criteria always win over this note.

> FORWARD-POINTER (drive conductor, 2026-10-30, task-specific): (a) "What to build" says `assistant_notify` is registered when `assistantFolder` is configured, but the acceptance criteria say it is ABSENT when the folder lock is held by another server. The acceptance criteria win: register `assistant_notify` only while the assistant is ACTIVE (configured AND lock held), and add a guard test for the refused case. This overrides the general note above for this one tool. (b) A new npm dependency (e.g. `web-push`) changes `pnpm-lock.yaml`, which REQUIRES regenerating `pnpmDepsHash` in `package.nix` (CONTEXT.md, ADR 0008; `nix run .#update-pnpm-deps-hash`), and the acceptance gate does not catch a stale hash. Prefer the dependency-free WebCrypto sender borrowed from the sibling `push-notification-server`; if you do add a dependency, regenerate the hash in the same change and say so in the decisions note.

## Acceptance criteria

- [ ] From any server session, `assistant_notify` produces a push on a subscribed device; tapping it opens the target session per the precedence above, in background and foreground.
- [ ] A notify during a running assistant turn is delivered immediately; a scheduled turn without `assistant_notify` produces no push.
- [ ] Subscription endpoints are token-gated; payload matches the SW shape; 404/410 prunes; with no channel, `assistant_notify` errors clearly.
- [ ] A push goes to EVERY registered subscription.
- [ ] Messages dropped by a reset or an aborted settle are reported to the channels of their origins (tested with a fake channel).
- [ ] With `assistantFolder` unset, or the folder lock held by another server, no VAPID key is generated, the push routes behave as unknown routes do today, no channel starts, the settings toggle is hidden, and `assistant_notify` is absent from server sessions.
- [ ] The template push module is gone and nothing imports it.
- [ ] Tests cover the new behaviour (push service mocked at the HTTP boundary) with temp state/config dirs, real ones untouched.
- [ ] A changeset (`"wherever-dev"`); `CONTEXT.md` documents the channel interface, `assistant_notify` and push.

## Blocked by

- assistant-schedule-tools-server (owns the shared tool-text module and server-tool registration this task extends; serialized because both edit `buildServerAgent()`; transitively after `assistant-scheduler`, whose job mapping the tap target uses)

## Prompt

> Goal: make wherever a chat app for its assistant (spec `assistant-session-and-channels` in `work/specs/tasked/`): a channel seam, `assistant_notify`, and Web Push. Read `docs/adr/0014` and `docs/adr/0017` first.
>
> Where to look: the service worker's `push` / `notificationclick` handlers and `DeclarativePushNotification` type, the in-app notification component (foreground click via `pushState`), the page's `hashchange` navigation, the server's API token gate, the pool event fan-out and current destination, the scheduler's job mapping, `buildServerAgent()`. Seams: the channel dispatcher with a fake channel; the push sender with a mocked HTTP boundary; tap-target precedence as a pure function; a web test for the foreground click.
>
> FIRST, drift-check this task against `tasks/done/`, the ADRs and its dependencies; if a premise no longer holds, route it to needs-attention instead of building on it (WORK-CONTRACT.md "Drift is a needs-attention signal"). RECORD non-obvious in-scope decisions durably and link them from the done record (an ADR if it meets `work/protocol/ADR-FORMAT.md`, else a JSDoc at the choice site, a `## Decisions` block, or a note under `work/notes/observations/`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md   # on completion
```

## Decisions

The non-obvious in-scope decisions taken while building this task are recorded in [work/notes/observations/channel-seam-notify-and-web-push-decisions.md](../../notes/observations/channel-seam-notify-and-web-push-decisions.md), with JSDoc at the choice sites in `server/src/assistant-channels.ts`, `server/src/web-push.ts`, `server/src/assistant-tools.ts`, `server/src/session-pool.ts` (`clearQueuedMessages`, the `assistantWebPush` / `publicUrl` config keys), `server/src/index.ts` and `web/src/lib/core/notifications/index.ts`. They cover:
- the dependency-free RFC 8291 / 8292 sender (no `web-push` package, `pnpmDepsHash` untouched);
- Web Push being on by default while active, with the `assistantWebPush.enabled` off switch, and the coordination point with Telegram's channel list;
- the new `assistantWebPush` and `publicUrl` config keys;
- the VAPID subject fallback chain;
- keys generated on first use and never replaced;
- the state file names and mode 0600;
- the `/push/*` route shapes, present only while Web Push runs, and CORS gaining `DELETE`;
- the `webPush` status shape, with "this device subscribed" computed by the web;
- `assistant_notify` registered only while active;
- tap-target fallback to the calling session;
- `source` being the origin folder name, and the push title prefixed with it;
- notify succeeding when at least one channel delivered, and zero subscriptions counting as a failure;
- channel name = routing origin, with `name:<sub>` matching;
- `!` refused at the dispatcher, and files not forwarded yet;
- dropped-message origins aligned from the newest end;
- TTL 24 h and `Urgency: high`;
- `ASSISTANT_TOOL_TEXTS` now listing five tools, the four schedule tools being `ASSISTANT_SCHEDULE_TOOL_TEXTS`;
- the foreground click setting `location.hash`;
- where the settings toggle sits;
- the `minor` changeset bump.
