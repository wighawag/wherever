# Decisions: speech-settings-panel-store (2026-11-26)

Non-obvious in-scope choices made while implementing spec `chat-compact-layout` story 12 (task `speech-settings-panel-store`).

1. **The store is a factory with injected storage (`createSpeechSettings` in `web/src/lib/core/speech-settings.ts`), the app instance (`speechSettings`) lives in `web/src/lib/wherever.ts`.** Mirrors the existing split: pure, unit-tested logic in `core/`, the persisted reactive stores (`autoSendOnSpeechEnd`, beep, conversation mode) in `wherever.ts`. Alternative: a module-level singleton in `core/` reading `localStorage` directly (not testable without stubbing globals). Touches: `SpeechButton`, `SpeechSettingsPanel`; `chat-session-menu` mounts the panel and needs nothing else.

2. **Direct send is NOT duplicated into the new store.** It stays the conversation-mode `autoSendOnSpeechEnd` store (`wherever-speech-direct-send`), as the task requires; the panel reads and writes that store directly. Alternative: a `directSend` field on the speech store that proxies it (would be a second name for the same knob, the forking `conversation-mode.ts` explicitly avoids).

3. **The last speech error moved into the store too (non-persisted `error` writable).** So the panel, wherever it is mounted (the ⋯ menu later), still shows it, and the pill shows it next to 🎤. Alternative: keep it local to `SpeechButton` (then a panel in ⋯ could not show it).

4. **Defaults unchanged, and a default is never persisted.** Engine: the stored value if it is `browser` or `cloud`, else on-device when the Web Speech API exists, else cloud (as the old `onMount` did, not written until the user picks). Locale: stored, else `en-US`. One small tightening: an unknown stored engine value (not `browser` / `cloud`) now falls back to the default instead of being cast through; the UI only ever wrote the two valid values.

5. **The error next to 🎤 is a small `role="alert"` box above the mic with a × to dismiss, hidden while the panel is open** (the panel shows it itself, so it would be shown twice). The next recording clears it, as before. Alternative: a `title` tooltip only (invisible on touch).

6. **The panel component renders only the panel body (heading, engine, locale, Direct send, error), not its container.** The caller provides the popover or sheet, so `chat-session-menu` can drop it into the ⋯ menu's sheet / popover without fighting fixed positioning. The ⚙ on the speech button keeps its existing popover around it until that task removes the cog.

7. **`speechLocale()` in `chat-message-helpers.ts` (TTS voice language) still reads `wherever-speech-locale` from localStorage directly.** It reads at speak time, so it already sees a change at once; moving it onto the store was not needed for this story and is left as is.

## Checked by hand

Dev web (vite) against a throwaway local server (fake HOME, `searchFolder` set so the empty-state pill's 🎤 is enabled), headless Chromium driven over CDP, at 390x844 (phone) and 1440x900 (desktop):

- With `wherever-speech-engine=cloud` and `wherever-speech-locale=en-GB` stored before load, ⚙ opens the panel with Cloud AI selected (stored settings read).
- Tapping 🎤 on the cloud engine (no mic in headless) shows "Requested device not found" next to 🎤 in the pill; opening the panel shows it inside the panel instead.
- Switching to On-Device and en-AU in the panel, then tapping 🎤 without a reload, gives the browser engine's "Error: not-allowed": the change took effect in the button at once. localStorage then held `browser` / `en-AU`.
- × dismisses the error. The error box sits above the mic without clipping on both widths.
