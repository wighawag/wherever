# chat-top-bar: decisions (2026-11-25)

Task `chat-top-bar` (spec `chat-compact-layout`, stories 1 to 4, 6, 7 and the read-only part of 19). In-scope choices a reviewer might not expect:

1. **Helpers in a new `web/src/lib/core/chat-top-bar.ts`.** `openSessionTitle` (listed: `sessionListLabel`; not listed: folder name; neither: "Session"), `folderName` and `waitsForYouText` (the counts as text). The subtitle dot reuses the sidebar's `openSessionDot` rather than a new helper, so the top bar and the sidebar's current-session line can never disagree. The rail's `waitsForYouTitle` now uses `waitsForYouText` too (same text as before). Alternative: put them in `sidebar-nav.ts`, which is about the sidebar.
2. **The title keeps `sessionListLabel`'s 40-character cut** (as the task names it), so on a wide desktop the first-message title ends with "..." earlier than the mockup's. CSS truncation still applies on narrow screens. Alternative: the full first message with CSS truncation only; easy to switch in `openSessionTitle` if wanted.
3. **"disconnected" shows in the subtitle at every width, "connected" on desktop only.** The spec puts the connection state in the desktop subtitle; the old phone top bar said "Not connected" even with a session open, so dropping it on the phone would lose that signal. Touches only the top bar.
4. **The subtitle shows the dot only, not the state word.** `live.png` shows "running · wherever · model"; the spec and `phone.png` show only the dot. The dot's label ("running", "waiting for you", ...) is its tooltip, accessible name and long-press bubble (`StateDot`), so the phone line keeps its width for folder and model.
5. **The ☰ dot is always amber now.** It used to be blue for a non-blocking inbox item and amber only when an item blocked; the spec makes amber mean "something waits for you", matching the desktop rail.
6. **Interim right-hand actions are compacted on the phone** (until `chat-session-menu` moves them into ⋯): the model select is 36px wide on the phone (full width from `md`), and "↺ Reset" shows only ↺ on the phone (its title and aria-label still say "Reset the assistant"). The 🤖 icon and its working dot are gone (the state dot replaces it), and the "Read-only" badge became the subtitle's "read-only".
7. **Read-only ■ Stop shows only while `appState.isStreaming`** (instead of a disabled Abort while idle), styled like the pill's ■ Stop (title "Stop the agent", aria-label "Stop"). The strip's read-only Abort and the now-unused `abort` import in `ChatMessageList` are removed; the strip keeps the read-only context label until `chat-session-menu`.

## Checked by hand

`vite dev` plus headless Chromium driven over CDP, the session state injected into the client stores (no backend), at 390x844 (mobile emulation, touch) and 1280x800:

- Phone, listed running session, presence waiting-for-human: ☰ with the amber dot, label "Open sessions. Waiting for you: 1 session waiting for you"; title "Now that we shipmates..." (truncated), subtitle dot + "wherever · anthropic:claude-opus-5-5"; model select, ☆, ⊘ on the right; no horizontal overflow (scrollWidth 390).
- Phone, unlisted session with one inbox item: title "wherever" (folder), amber dot, label "1 question for you".
- Phone, no session: "Select a session from sidebar", ☰ without a dot.
- Phone, read-only session running: subtitle "· read-only", only ☆ on the right (no ⊘, no model select), the read-only stub shows the red ■ Stop; clicking it called `client.abort()` once; no "Abort" button anywhere.
- Desktop, listed named session idle with an inbox item: ☰ hidden, title "drive the compact chat", subtitle "· connected" in green; model select at full width, ☆, ⊘.
- Desktop, disconnected: subtitle "· disconnected" in red.
- Desktop, read-only idle: "· read-only · connected", no ■ Stop (not running).
- Not exercised: 🔍 (needs a configured search folder) and ↺ Reset (needs an active assistant); their markup is unchanged apart from position and the phone label.
