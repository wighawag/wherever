---
title: Spike - does an app-owned WebView keep the WebSocket alive across an Android app switch?
slug: capacitor-webview-socket-spike
spec: native-shell-capacitor-experiment
blockedBy: []
covers: []
---

## What to build

A THROWAWAY Capacitor shell, built only to make ONE observation on ONE physical Android device: **does the WebSocket survive backgrounding the app, and for how long?**

This is a spike, not the first slice of the shell. Nothing it produces is meant to be kept or merged. Its output is a paragraph of measurements appended to this file (or a note in `work/notes/observations/`) that either unblocks `native-shell-capacitor-experiment` or kills it. The spec it derives from is in `work/specs/proposed/` and is deliberately NOT ready: an adversarial review returned REWORK with eight blocking findings, and this spike exists to answer the two that cannot be settled by reading code (does the container actually help, and is the effect big enough to be worth the parity work).

Shape of it:

- A `app/` directory OUTSIDE the pnpm workspace (own `package.json`, own lockfile, not added to `pnpm-workspace.yaml`, not added to `package.nix`'s `topLevelAllowed`). See the spec for why the workspace and the Nix source allowlist are coupled.
- Capacitor with `webDir` pointing at the EXISTING `web/build` artifact. Build `web` first; `build/` is gitignored and absent from a clean checkout.
- Android only. Sideload via `adb install`. No iOS, no signing pipeline, no store.
- **No changes to `web/`, `client/` or `server/`.** If the spike appears to need one, that is itself a finding: record it and stop rather than patching, because a patched arm no longer measures the stock app.

**Connect it by luck, not by code.** The spec's blocking finding B1 is that the transport scheme is derived from the WebView's own origin (`web/src/lib/wherever.ts`, `web/src/lib/session-store.ts`) and is never a stored field, and B3 is that the legacy-port healing rule rewrites a stored `31415` to the origin port. In a Capacitor shell the origin is `https://localhost`, so `secure` computes TRUE and `defaultPort()` returns 443. **If the target server terminates TLS on standard 443, both defects stay latent and the stock build connects unmodified.** Confirm the server is on 443 BEFORE building. If it is not, stop and say so: the spike then needs the B1/B3 work first and is no longer a spike.

**Instrument via `chrome://inspect`, not via code.** `adb` is already on this machine and Chrome DevTools attaches to the WebView over it, giving the console, the network panel and live WebSocket frames from the phone. That answers the spec's blocking finding B8 (no instrumentation channel) for free and with no edit to `client.ts`, which the spec forbids touching. Socket survival is then directly observable as the absence of a close frame and a new connection, rather than inferred from the UI.

**Do not fix the 8-second suspend for the first run.** `web/src/routes/+page.svelte` closes the socket ~8s after the page hides (`HIDE_DISCONNECT_DELAY`). Measure the stock build FIRST, so the baseline is the app exactly as it ships today. Only then, if it is worth continuing, comment the suspend out locally and re-measure. Those two runs are the actual experiment: they separate "the container helped" from "not suspending helped", which the spec's own fail criterion could not distinguish (blocking finding B8.4).

## Acceptance criteria

- [ ] An APK built from the stock `web/build` runs on a physical Android device and reaches a live session against the TLS server.
- [ ] DevTools is attached over `chrome://inspect` and WebSocket frames are visible from the phone.
- [ ] Run A (stock, suspend intact) measured across: 10s app switch, 1min screen lock, 10min screen lock, 30min+ screen lock. For each: did the socket close, and if so after how long, and how long until a live session was usable again.
- [ ] Run B (same APK, hidden-suspend disabled locally) measured across the same four.
- [ ] The same four measured in the PWA on the SAME device against the SAME server, as the baseline.
- [ ] A background-while-streaming check on the best-performing arm: background mid-stream, return, confirm whether output was lost or duplicated.
- [ ] Findings written up with the numbers, including the negative ones, and an explicit recommendation: continue to the full shell, or stop.
- [ ] No diff to `web/`, `client/`, `server/`, `package.nix`, `pnpm-workspace.yaml` or `pnpm-lock.yaml`. (Run B's suspend edit is local and reverted, never committed.)

## Build notes (scaffolded 2026-09-22, APK built and installed)

The shell exists at `app/`: own `package.json`, own npm lockfile, NOT in `pnpm-workspace.yaml`, NOT in `package.nix`'s `topLevelAllowed`. `app/android/` is gitignored (regenerate with `npx cap add android`), so the one hand-edit below must be REAPPLIED after any regeneration.

Settled by doing, both of which the spec left as doubts:

- **`webDir: "../web/build"` works.** Capacitor resolved the traversal outside the package directory and copied the real 2.8M dashboard into `android/app/src/main/assets/public`. The spec's reviewer flagged this as unverifiable from the repo; it is now verified. Note it is a COPY baked at `cap copy` time, so the APK freezes that build until the next sideload.
- **`androidScheme: "https"` is pinned explicitly** in `capacitor.config.json` rather than left to the Capacitor default, because the whole "connect by luck" path depends on it: it is what makes the origin `https://localhost`, hence `secure` true, hence `wss://`. `webContentsDebuggingEnabled: true` is pinned for the same reason of not depending on a default, since the instrumentation plan needs it.

**The one hand-edit: pin build-tools in `app/android/build.gradle`.** AGP 8.7.2 defaults to `build-tools;34.0.0`. The Android SDK here comes from Nix at a READ-ONLY `/nix/store` path and ships only 35.0.0 and 36.0.0, so Gradle tries to auto-install 34.0.0 and fails with "The SDK directory is not writable". A `subprojects { afterEvaluate { ... buildToolsVersion = '35.0.0' } }` block in the root `build.gradle` fixes it. This is a property of a Nix-provided SDK, not of Capacitor: on a normal writable SDK Gradle would simply download 34.0.0 and the edit would be unnecessary.

Build: `cd app/android && ./gradlew assembleDebug --no-daemon` (28s warm), APK 5.0M, installed with `adb install -r`.

## Run A result (2026-09-22): NEGATIVE, as predicted

Informal but decisive. The user used the app normally, switched to another app, came back: it showed "reconnecting" for a noticeable period, then connected and followed the conversation correctly. **Behaviour indistinguishable from the PWA.**

This is the predicted outcome and it is not evidence against the shell, because Run A could not have come out any other way. `visibilitychange` fires in a WebView exactly as it does in a browser tab, so `HIDE_DISCONNECT_DELAY` in `web/src/routes/+page.svelte` tears the socket down ~8s after backgrounding no matter who owns the WebView. Run A is therefore the PWA's behaviour BY CONSTRUCTION: the app closes its own socket, and the container never gets a chance to matter.

**Correction to the plan as originally written:** the task said to gate Run B on Run A showing a benefit. That gating was wrong and is withdrawn. The container's only possible contribution is NOT RECONNECTING, which cannot be observed while the app suspends itself. Run B is not a follow-up; it is the only test that can answer the question.

**Second finding, orthogonal to the container:** "reconnecting for quite some time" is not the reconnect backoff. `resume()` reconnects immediately on foreground; the 2s/x1.5/15s backoff in `client.ts` applies only to FAILED retries. The delay is the RESYNC: socket open, `session_load`, server re-reads the transcript, `message_history`, then `session_ready`. That is the problem already described in `docs/plan-speed-up-long-session-load.md`, and NO shell can fix it. It does mean the two problems compound: every drop costs a full resync, so "do not drop" is worth more than it first appears, and conversely a cheaper resync would soften the drop for the PWA too. Whichever way the spike ends, that plan is the other half of the story.

## Notes

**Why this runs before the spec is reworked.** The spec's remaining blocking findings are mostly parity and correctness work (the transport decision, downloads needing a native `DownloadListener`, speech needing `RECORD_AUDIO`, the clientKey move, a falsifiable criterion). Every one of them is wasted effort if the container does not help, and all of them are cheap to decide once it does. So the cheapest ordering is: observe first, then rework.

**Expect scenario 4 to fail on every arm.** Android Doze will close a background socket eventually whatever the container. It is in the list so the honest limit is on the record; a fail there is not a fail of the spike. Surviving a LONG background needs FCM or a foreground service, which is out of scope for both the spike and the spec.

**This task is in `work/tasks/backlog/` by POSITION, not by flag.** It needs a physical device, a real server and a human reading a socket, so a human drives it. Per WORK-CONTRACT that is the position case; `humanOnly` is reserved for never-for-agents-by-nature (secrets, release, security) and is deliberately not set here.
