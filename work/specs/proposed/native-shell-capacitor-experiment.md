---
title: Native shell experiment (Capacitor) to stop the WebSocket dropping on app switch
slug: native-shell-capacitor-experiment
needsAnswers: true
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Problem Statement

Leaving the PWA or the browser tab and coming back drops the WebSocket, and returning to a live conversation is slow and sometimes lossy. The user experiences this as "wherever forgets what it was doing every time I switch apps", which is the single most-felt defect on a phone, where app switching is constant and unavoidable.

There are two distinct causes, and only one of them is the browser's fault.

**Cause 1: the browser discards the document.** Firefox Android (and Chrome under memory pressure) evicts a backgrounded tab, so resume means a full document reload: re-run the app, reconnect, re-fetch sessions, re-load history. `docs/plan-firefox-android-reload-on-resume.md` documents this and the mitigations that landed in `client/src/client.ts` (suspend/resume, `resumeSessionFile`, re-attach on any reconnect, `clientKey`). Those mitigations made resume survivable; they could not make it not happen.

**Cause 2: the app closes its own socket, on purpose.** `web/src/routes/+page.svelte` schedules `suspend()` 8 seconds after `visibilitychange: hidden` (`HIDE_DISCONNECT_DELAY`), because an open WebSocket is a back/forward-cache disqualifier and holding one makes cause 1 MORE likely. That is a sound trade for a browser tab: give up the live socket to win a chance at an instant bfcache restore. It is also, straightforwardly, the code that drops the connection the user is complaining about.

The second cause is the interesting one, because it is a concession extracted by the browser environment rather than an intrinsic property of the app. A native shell owns its own WebView inside its own process: there is no tab to discard, no bfcache to qualify for, and no service worker deciding to reload the navigation. In that environment the concession buys nothing, and the app can simply keep its socket open while backgrounded.

The user's first instinct was a Flutter rewrite. That would work, but it would cost a full Dart reimplementation of `client/src/client.ts` (2,758 lines) against a 60-message protocol, creating a second behavioural implementation to keep in sync forever. `@wherever-dev/client` is explicitly "framework-agnostic isomorphic", has one zero-dep dependency (`sveltore`), takes an injectable `WebSocketCtor`, and guards every `localStorage` access, so it already runs unchanged anywhere JavaScript runs. Paying to abandon that is the wrong first move.

## Solution

Wrap the **existing** `web/` build in a Capacitor shell, change nothing about the client or the UI, and make the background/resume policy **platform-aware**: a browser tab keeps today's suspend-for-bfcache behaviour, and a native shell keeps its socket open and reconnects deterministically on resume.

This is framed as an **experiment with a pass/fail criterion**, not a platform adoption. It is cheap because `web/` already builds with `adapter-static` and `paths.relative: true`, so the output is origin-agnostic and drops into a WebView as-is, and because the server already sends `Access-Control-Allow-Origin: *`, so a `localhost`-origin app can call the HTTP routes with no server change. The question it answers is narrow and falsifiable: **does an app-owned WebView plus a no-suspend lifecycle policy actually keep the conversation live across an app switch?**

If yes, the user gets the thing they wanted (a native-feeling app that does not drop the connection) while keeping one client, one UI and one protocol implementation. If no, the experiment has cost days rather than weeks, and it has produced the measurements that justify the next step, which would be React Native (native widgets, `client.ts` still unchanged because Hermes runs it) rather than Flutter (native widgets, full Dart port).

## User Stories

1. As a phone user, I want to switch to another app and come back, so that I find my conversation exactly as I left it, still streaming if the agent was streaming.
2. As a phone user, I want to lock my screen for a minute and unlock it, so that the conversation is still live without a visible reconnect.
3. As a phone user, I want the app to reconnect by itself when the OS did eventually close the socket, so that I never have to pull-to-refresh or restart the app.
4. As a phone user, I want to see honestly whether I am connected, so that I know whether what I am reading is live or a cached view.
5. As a phone user, I want the agent's output produced while I was away to be there when I return, so that backgrounding never loses work.
6. As a phone user, I want to install the app from an APK, so that I am not depending on the browser's PWA install flow or its tab lifecycle.
7. As a first-run user, I want to be asked for my server address and token, so that the app can find a server that is not the origin it was served from.
8. As a user who points the app at a server that is not behind TLS, I want to be told that in words, so that I am not left staring at "Connecting..." with no idea why.
9. As a user setting this up, I want the TLS prerequisite stated in the install documentation before I start, so that I do not build and sideload an app that then cannot reach my server.
10. As a returning user, I want my server address and token remembered, so that opening the app lands me straight in my session.
11. As a user, I want the app to look and behave exactly like the web dashboard I already know, so that there is nothing new to learn.
12. As a user, I want every existing feature (drafts, uploads, downloads, search, forks, conversation mode, restore) to keep working in the app, so that the app is not a downgrade.
13. As a user on a slow or dropped network, I want the existing delivery watchdog and Retry affordance to behave identically, so that the app is not less trustworthy about whether my message landed.
14. As a developer, I want the shell to consume the same `web/build` artifact the server serves, so that there is exactly one frontend build and no second copy to keep in step.
15. As a developer, I want the lifecycle branch to live in ONE place behind a runtime seam, so that "is this a browser or a native shell" is answered once rather than sprinkled through components.
16. As a developer, I want the experiment to have a written pass/fail criterion and real measurements against the PWA baseline, so that the go/no-go decision is evidence and not vibes.
17. As a developer, I want the shell to require no change to `package.nix` or `pnpm-lock.yaml`, so that an Android build tree can never leak into the server derivation and the pinned dependency hash never has to be regenerated on its account.
18. As a developer, I want the service worker to be inert in the native shell, so that its navigation branch can never force a reload inside the app.
19. As a maintainer, I want the experiment to be abandonable by deleting one directory and one workspace entry, so that a negative result leaves no residue.
20. As a maintainer, I want the app to report its build id and the server version exactly as the web does, so that the wider version-skew window an installed app creates stays diagnosable.

### Autonomy notes (the two gate axes)

- **`humanOnly`: not set.** The work is ordinary and agent-buildable (a shell package, a runtime seam, a lifecycle branch, a build script). The strategic decision is the go/no-go at the END of the experiment, which is a human reading the measurements, not a gate on the tasking.
- **`needsAnswers`: FALSE.** All four launch questions are answered and recorded as decisions: TLS is a precondition (app-enforced and documented), Android only, `app/` outside the pnpm workspace, and the browser keeps its suspend. Note for the tasker: the measurement scenarios need a physical Android device and a TLS-terminated server, so the measuring task is human-run by nature even though everything it depends on is not.

## Implementation Decisions

**Android only.** The reported pain is Firefox/Chrome on Android, an APK can be sideloaded with no paid account and no Mac, and iOS suspends background apps so much harder that its result would not generalise from the Android one anyway. iOS is a follow-on if the experiment passes, not part of it.

**The shell lives in `app/` and consumes `web/build`; it does not fork it.** Capacitor's `webDir` points at the artifact `web` already produces (`../web/build`). There is no second frontend, no second copy of the client, and no divergence to manage.

**`app/` is deliberately NOT a pnpm workspace member.** This looks like a break with the repo's convention and is the opposite: it is what keeps the Nix packaging honest. `package.nix` filters its source through an ALLOWLIST (`topLevelAllowed`) because the derivation is imported BY PATH as well as through the flake, so a path import of a working checkout would otherwise copy gitignored scratch into the store and make the two paths disagree. An Android build tree (Gradle caches, `.gradle/`, wrapper jars) is exactly that kind of bulk. But the allowlist and the workspace are COUPLED: `pnpm-lock.yaml` carries an `importers:` entry per workspace member, and the build runs `--frozen-lockfile` against a source tree containing only the allowlisted members, which is why every member's `package.json` must be present "even the ones this package does not build". Adding `app` to the workspace while excluding it from the allowlist therefore BREAKS THE BUILD, and adding it to both puts an Android tree in the server derivation and reintroduces, one level down, the denylist rot the allowlist exists to prevent.

The way out is that the shell has NO JavaScript dependency on the workspace: it does not import `@wherever-dev/client` or anything else, it consumes a BUILT DIRECTORY. So it holds its own `package.json` and its own lockfile, depends only on `@capacitor/{core,android,app}`, and is invisible to pnpm, to `pnpm-lock.yaml`, to `pnpmDepsHash` and to `package.nix` alike. That also keeps `nix/check-pnpm-deps-hash.sh` out of the story entirely: a stale `pnpmDepsHash` does not fail a build, it silently builds against the OLD lockfile, and this decision means the experiment can never provoke that. If the shell ever DOES need a workspace package, that is the moment to revisit this and pay the allowlist cost deliberately.

**The browser keeps its 8-second hidden-suspend unchanged.** Trading the live socket for bfcache eligibility is the right call in a tab, and only the native branch stops doing it. If the measurements suggest the suspend is also hurting the desktop tab, that is a separate finding to record in `work/notes/observations/`, not a change to slip into this experiment: changing both halves at once would confound the very comparison the experiment exists to make.

**Platform detection is ONE seam, in `web/`.** A small runtime module answers "browser tab" or "native shell" (Capacitor exposes this; it must degrade to "browser" when the Capacitor global is absent, since the same bundle is served by the server to real browsers). Everything platform-dependent branches on that one answer. The alternative, a build-time flag producing a second bundle, is rejected: it would mean the server serves one artifact and the app ships another, which is precisely the drift story 12 exists to prevent.

**The lifecycle policy is the substance of the experiment.** In a browser tab, the current behaviour is unchanged: suspend 8s after hidden, prefer `resume()` over `connect()` on return when `hasActiveSession()`. In the native shell:

- **Do not suspend on background.** There is no bfcache to qualify for and no tab to save from discard, so the socket stays open and a short app switch costs nothing at all. This single change is the hypothesis under test.
- **Drive resume from `App.appStateChange`** (`@capacitor/app`) rather than `visibilitychange`, which is unreliable in a WebView.
- **Treat "still connected" as unproven on resume.** A socket that survived a doze can be half-open: `send()` buffers locally, nothing throws, nothing lands. `client.ts` already has a `STALE_SOCKET_MS` staleness teardown for exactly this; resume should provoke that check rather than trust the readyState.
- **Keep the file-picker guard.** `isFilePickerActive()` exists because the OS picker backgrounds the page; the native shell has the same problem and must not regress it.

**The server address must be asked for, not derived.** `getConfig()` in `web/src/lib/wherever.ts` derives the default host from `window.location.hostname` and the default port from `window.location.port`, which is right when the server serves the page and meaningless in a shell whose origin is `localhost`. First run therefore lands on the existing connection panel with no usable default. Persistence is unchanged (the `wherever-config` localStorage entry, which the WebView keeps across restarts).

**`clientKey` becomes per-install rather than per-tab.** The web scopes it to `sessionStorage` so two tabs are two viewers. A shell has exactly one WebView, so one install is one viewer, and the key belongs in `localStorage` where it survives an app restart. This matters: a key that resets on every launch means the server cannot retire the previous connection, which reintroduces the phantom-viewer folder conflict the key exists to prevent. Verify against the `connection_superseded` path, which must never fire for a single install reconnecting to itself.

**The service worker must never register in the native shell.** It is already `register: false` in `svelte.config.js` and registered by hand, and its navigation branch can return `Refresh: 0` to force a reload. Inside an app that is a reload the user did not ask for and cannot explain.

**TLS is a PRECONDITION of the app, enforced in the app, and documented up front.** The deployment being targeted already terminates TLS with a real certificate (a reverse proxy or the tunnel path in `docs/deployment-tunnet-https.md`), so the shell needs no TLS code at all: no `network_security_config.xml`, no user CA, no certificate pinning, no `onReceivedSslError` override. That is the whole reason this answer was chosen. What it costs instead is a FAILURE MODE, and the failure mode is the deliverable: a WebView refusing a connection (an untrusted certificate, or cleartext on API 28 and later) reports nothing the page can catch, so the WebSocket simply never opens and the connection panel hangs on "Connecting..." exactly as it does for a wrong port. Therefore:

- The connection form in the native shell **rejects an `http://` server URL outright**, at input time, naming TLS as the reason. This is a client-side precondition check, not a network round trip, so it costs nothing and cannot itself hang.
- A connection attempt that neither opens nor errors within the existing watchdog window surfaces a native-shell-specific hint naming the likely causes (certificate not trusted, server not reachable from the phone) rather than a bare timeout. It must remain a HINT: the app cannot distinguish an untrusted certificate from an unreachable host, and asserting the wrong one is worse than naming both.
- The TLS requirement is stated in the shell's install documentation as a prerequisite, BEFORE the build steps, since discovering it after sideloading an APK is the expensive order to learn it in.

This deliberately makes the app **unusable against a plain-LAN server with no TLS in front of it**. That is an accepted limitation of the experiment and not a defect to work around: the target deployment has TLS, and adding cleartext support would mean an Android network security config, a documented hole in transport security, and a second connection path to test, all for a configuration the user does not run.

**No other server changes are anticipated.** CORS is already `*` on the API routes, the WebSocket takes its token as a query parameter or header, and the download URL builder already carries the token. If the experiment turns up a server change, that is a finding worth recording, not a thing to slip in quietly.

## Testing Decisions

The deliverable of this spec is a **measurement**, so the acceptance criteria are behavioural and comparative, taken on the same physical device against the same server, with the PWA as the baseline.

**The measured scenarios**, each timed from "app returns to foreground" to "conversation is live and usable", and each recorded as socket-survived or socket-reconnected:

1. App switch, 10 seconds away.
2. Screen lock, 1 minute away.
3. Screen lock, 10 minutes away.
4. Screen lock, 30 minutes or more away (the Doze case, expected to fail on both, included so the honest limit is on the record).
5. Background while the agent is actively streaming, return mid-stream: assert no lost output and no duplicated message.
6. Background while a message is in flight and unconfirmed: assert the delivery watchdog reaches a correct verdict rather than a stuck spinner.

**Pass criterion (go):** scenarios 1 through 3 keep the socket open, or reconnect and re-attach so fast the user does not see a connection state; scenario 5 loses nothing; and no scenario is WORSE than the PWA baseline. **Fail criterion (no-go):** the WebView is suspended by the OS as aggressively as the tab was, so the native shell buys nothing, in which case the finding is recorded and React Native becomes the justified next step.

**Automated tests** cover the parts that are logic rather than platform. The runtime seam and the lifecycle policy should be a pure, unit-testable decision function in the style of `web/src/lib/core/hands-free.ts` (`decideMicReopen`) and `web/src/lib/core/conversation-mode.ts`: given a platform and an app state, should we suspend, resume, or probe? That function is tested without jsdom, mirroring `core/collapse-reply.ts`. The existing client tests (`client/test/{resume-keeps-session,reconnect-rejoins-session,creating-session-watchdog}.test.ts`) must keep passing untouched, since the client is deliberately not being modified for the shell.

## Out of Scope

- **A Flutter or Dart port.** The premise this spec displaces. Revisit only if a JS-runtime shell is proven insufficient, and even then React Native comes first because it keeps `client.ts`.
- **React Native.** The justified next step ON A FAIL, not a parallel effort.
- **Push notifications, FCM/APNs, and any Android foreground service.** These are the only real answer to a LONG background (scenario 4), and they are a separate, larger piece of work that can be added to whichever shell survives. Their absence is a known limit of this experiment, not an oversight.
- **iOS.** Decided out: see the Android-only decision above. A follow-on if the experiment passes.
- **App store distribution, signing pipelines, and auto-update.** Sideloaded APK is sufficient to answer the question.
- **Native widgets, native navigation, and any UI rework.** The UI is deliberately byte-identical to the web; changing it would confound the measurement.
- **Cleartext-LAN support and certificate pinning.** Both are dead ends given a TLS-terminating deployment (see the TLS decision above), and each would add an Android-specific security surface to test and defend. If a no-TLS LAN setup ever becomes a real requirement, it is its own spec with its own threat model.
- **Offline mode and local caching of transcripts.** The app is a remote control for a machine that holds the state, which is the whole premise of wherever.
- **Making the app lighter than the PWA.** "More lightweight" was a secondary motivation and a WebView shell will not deliver it (same engine, same bundle, minus the browser chrome). If footprint turns out to matter on its own, that is a separate spec with its own measurements.

## Further Notes

The reason this is worth doing before anything more ambitious is that it tests the actual hypothesis in isolation. "The socket drops when I leave the app" has at least three candidate causes (the browser discarding the document, the app's own deliberate 8-second suspend, and the OS closing background sockets) and they call for completely different remedies. A Capacitor shell removes the first two and leaves the third exposed, which means whatever pain remains afterwards is precisely and only the OS-level problem, and can be aimed at with push notifications rather than with another rewrite.

Worth keeping in view: a negative result is a genuinely good outcome here. Days spent to avoid weeks spent on a Dart reimplementation of a 2,758-line client is a favourable trade even when the answer is no.
