# chat-session-menu: decisions and browser check (2026-11-25)

Task `chat-session-menu` (spec `chat-compact-layout`). Decisions made while building, for the reviewer and the human to ratify or reverse.

## Decisions

1. **Item order and sections live in a pure helper**, `chatMenuSections()` in `web/src/lib/core/chat-session-menu.ts` (unit-tested), like the row menu's `rowMenuItems`. Order: Model, Star, Rename, Copy link, Open in new tab, Close / Reopen, Search the web, Reset the assistant; then "This chat"; then "On this device"; then one text line. Search the web and Reset sit after Close because they are the conditional, less frequent actions; the mockup has no slot for them (it shows "Search in this chat", left out by resolved decision 2).
2. **Toggles are the shared primitive's check boxes**, not the mockup's switches on the right. `MenuItem` `checked` already draws a check box and the sidebar's ☰ uses it; adding a second toggle style to the primitive was not worth a divergence. Beep is a plain item with its state as the right-hand hint ("Default (off)", "On", "Off"), cycling on tap as the strip did, since a check box cannot show three states.
3. **Conversation mode's hint says "default" or "set here"** (following the default vs this conversation's own choice), the strip's tooltip wording kept as the item's `title`.
4. **Model and Voice settings… open in place inside the menu** (`keepOpen`, a ›/▾ hint), rather than a second popover or a dialog. The model list is a scrolled list (max 15rem) of items with ✓ on the current model; picking one calls `changeModel` and closes the menu. The voice panel is `SpeechSettingsPanel` in a bordered box under the item. Alternative considered: a separate sheet per sub-panel; rejected as more machinery with no gain at this size.
5. **Model is shown as text** (no ›) on a read-only session or with an empty model list, as the old select was hidden then. No Model item at all when the session reports no model.
6. **Read-only sessions also lose Rename and Beep**, besides Close / Reopen. Rename: the row menu offers no Rename on read-only rows (`session-row-rename`), and the server refuses writes from a read-only client. Beep: the strip showed it only on a drivable session. Conversation mode stays (the strip showed it on read-only sessions too, and spoken replies can still be wanted while observing).
7. **With no session open, ⋯ holds only "On this device"** (no versions or context line either), as the task says. The trigger's label then is "Settings on this device" instead of "Session menu". The Conversation mode default is edited in Connection Settings in that state (the old strip toggle edited it there).
8. **Context and versions on one muted line** ("Context 33.1% of 1.0M · v0.29.0 / srv 0.29.0 / pi …"), as `phone.png` frame 4, wrapping when long. The pi version is added when known (the control map lists "v / srv / pi"). The "v" is dropped when the app build id is not a version number (a dev build's commit id, e.g. `e75a84c-dirty`). The tooltips keep the full wording (tokens of window; "App build … · server … · pi …").
9. **"Enter sends" is a small shared store** `createEnterToSend()` in `web/src/lib/core/enter-to-send.ts` (unit-tested), app instance `enterToSend` in `wherever.ts` next to `speechSettings`. Same localStorage key and default as before; written only when the user toggles.
10. **☆ in the top bar is desktop only** (`hidden md:flex`), sized like ⋯ (36px). On the phone Star / Unstar is in ⋯.
11. **Copy link mirrors the row menu exactly** (the same `sessionLinkUrl`, "Copied" in place then close after 0.9 s, the link shown to copy by hand on failure). The small copy-state logic is duplicated from `SessionRow.svelte` rather than extracted; two copies of ten lines did not justify a new component.
12. **The menu header is omitted** on the sheet: the top bar right above it already shows the title and "folder · model", and the mockup has none.

No new glossary concept: the sections reuse the existing Beep, Conversation mode, Hide thinking, Enter sends and voice settings meanings; "This chat" / "On this device" are UI headers only.

## Checked by hand

Built web served by this branch's real server through `server/test/harness.ts` (fake LLM, temp agent dir, config dir with `searchFolder`, `assistantFolder` and a `sessions.readOnly` glob, temp state dir), headless Chromium (playwright-core over the system chromium), at 390x844 (mobile emulation, touch) and 1440x900. Server, browser and temp files removed afterwards.

- Phone, no session: ⋯ ("Settings on this device") opens a sheet with only ON THIS DEVICE: Hide thinking, Enter sends, Voice settings….
- Phone, drivable session: the sheet lists Model (fake: fake-model ›), Star, Rename, Copy link, Close session; THIS CHAT: Beep when done (Default (off)), Conversation mode (default); ON THIS DEVICE: Hide thinking, Enter sends, Voice settings…; then "Context 0.0% of 128K · … / srv 0.29.0 / pi 1.4.0". No Open in new tab. No horizontal overflow (scrollWidth 390). The settings strip ("Hide Thinking", 🧠) and the ⚙ beside 🎤 are gone.
- Beep cycled Default (off) → On → Off → Default (off) with the menu staying open. Conversation mode toggled on (aria-checked true, hint "set here") and back. Hide thinking toggled on and back. Enter sends off: localStorage `wherever-enter-to-send` = `false`; toggled back on.
- Voice settings… opened the panel in place; choosing Cloud AI stored `wherever-speech-engine` = `cloud`. Model opened the model list in place with ✓ on the current model. Escape closed the menu.
- Star then reopening ⋯ showed ★ Unstar; Unstar restored it. Copy link showed "Copied ✓" and the clipboard held `http://127.0.0.1:<port>/#<session id>`.
- Rename opened the shared prompt (empty field, the title as its label); Enter renamed it and the top bar read "Renamed from chat menu" after the relist.
- Close session closed it (⋯ then offered Reopen session and the star was cleared, ADR 0025); Reopen session brought Close session back.
- Desktop, drivable session: ☆ visible in the top bar; no 🔍 / ↺ / ⊘ / model select buttons; the popover lists Model, Star, Rename, Copy link, Open in new tab, Close session, Search the web, then the sections. Open in new tab opened a popup on the session URL. Search the web left the session (empty hash) and focused the search composer ("Search query"). ⋯ with no session then showed only On this device.
- Rename refusal: on a session with no message, Rename → typed a name → Enter kept the prompt open with "This session has no message yet, so a name would not be saved. Send a message first, then rename it.".
- Assistant: viewing the assistant session, ⋯ also lists Reset the assistant; choosing it moved to a fresh assistant session (the hash changed).
- Read-only session (a `sessions.readOnly` folder), phone and desktop: subtitle "read-only"; ⋯ shows Model as text only (no ›), Star, Copy link, (desktop) Open in new tab, Search the web; THIS CHAT holds only Conversation mode; no Rename, Close or Beep; the context line is in ⋯.
- Not exercised in the browser: Conversation mode's `unlockTts()` on a real phone (it is called first in the handler, as the strip toggle did).
