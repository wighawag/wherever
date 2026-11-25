# chat-pill-composer: decisions (2026-11-25)

Task `chat-pill-composer` (spec `chat-compact-layout`, stories 15 to 24). In-scope choices that a reviewer might not expect:

1. **"Content" for the Stop / steer rule includes attachments.** `sendButtonState()` (`web/src/lib/core/composer-controls.ts`) takes `hasContent` = non-blank text OR at least one attachment chip, not text alone. While the agent runs, a pill holding only an attachment shows ➤ steer with ■ Stop beside it, because an attachment-only message can be sent (and steers). Alternative: text only, which would hide a sendable attachment behind a lone ■ Stop. Touches only the composer.
2. **■ Stop is never gated on the send gate.** It follows only `streaming` (Abort parity, as the task says), so it stays enabled while reconnecting or uploading. Both ■ buttons are `type="button"`, so Enter can never stop the agent: Enter on an empty running pill does nothing, as before.
3. **Phone placeholder is shorter than the mockup.** On a coarse pointer the running placeholder is "Steer the agent..." (not the mockup's "Message (steers the agent)...", which wraps to two lines in the 390px pill and makes the empty pill two lines tall). Desktop (`(hover: hover) and (pointer: fine)`) keeps "Message (steers the agent)..." / "Message..." plus what Enter does, following the Enter sends setting ("(Enter to send, Shift+Enter for a new line)" or the reverse). The disconnected / read-only / no-session placeholders are today's.
4. **Context ring label and colour.** The ring shows a whole percent and the window, "33% of 1.0M" (the desktop mockup's wording, used on the phone too instead of "33% context", so the window size stays visible), and "– of 1.0M" right after compaction. The tooltip is "N context tokens of W (P%)". The fill turns amber from 70% and rose from 90%, which the old 🧠 label did not do. It is hidden in search mode (no session) and when the server has sent no usage yet. It sits in its own row ABOVE the pill (never inside it), so neither the keyboard nor the pill growing to its cap can push it out (story 21).
5. **"Cancel queued (N)" always shows the count**, also for one queued steer (the old strip showed "(N)" only from 2). The task names it "Cancel queued (N)".
6. **"Draft saved" flash moved above the pill.** The old "✓ Saved" replaced the Save draft button's label; that button now lives in the ＋ menu, which closes on tap, so the confirmation shows briefly in the row above the pill instead.
7. **The ＋ menu always opens**, even with the composer disabled or disconnected: Drafts (the offline list) must stay reachable; Attach file and Save as draft carry today's disabled rules inside it.
8. **The 🎤 keeps its ⚙ (speech settings) for now.** `SpeechButton` gained a `compact` prop (36px, borderless while idle) instead of moving the ⚙: the voice settings move to the ⋯ menu with `chat-session-menu` (story 12).
9. **Keeping the latest message in view (story 24) needed a small fix in `ChatMessageList`.** A `ResizeObserver` on the list re-pins to the bottom when the list's box changes size while the user was at the bottom. Chrome also fires a `scroll` event when the box shrinks, which the old handler read as "the user scrolled away" and unpinned (seen about half the time when a tall message and a phone-keyboard-sized resize came together); `handleScroll` now ignores a scroll event while the list's height differs from the last one the observer saw. No `visualViewport` handling was added (out of scope; the layout is still `fixed inset-0`).
10. **Names.** `sendButtonState` / `contextRing` and the primary values `send` / `steer` / `stop` / `search` are local to the composer. "steer" keeps its existing meaning (a mid-stream send, ADR 0003); "Stop" is the UI label for the existing `abort()`, which `CONTEXT.md` already uses for Telegram's `stop`. No new `CONTEXT.md` term.

## Checked by hand

Headless Chromium against `vite dev`, with the session state injected into the client store (no live agent), at 390x844 (mobile emulation, touch) and 1280x800:

- Idle: one-line pill, disabled ➤, ring "33% of 1.0M", "Drafts (2)" above the pill; desktop placeholder "Message... (Enter to send, Shift+Enter for a new line)".
- Running, empty pill: only a red ■ Stop; "Steer the agent..." on the phone. Clicking it called `abort()`.
- Running with text and two queued steers: ➤ steer with ■ Stop beside it, "Cancel queued (2)" above the pill; both ■ buttons called `abort()`.
- Running while disconnected: ■ Stop still enabled; the "Connecting to remote server..." banner shows above.
- 40 lines of text at 390x844: the textarea stops at 338px (40.0% of 844) and scrolls; the ring stays on screen and the conversation stays on its latest message.
- Phone keyboard (viewport shrunk from 844 to 460 with a 12-line message, agent running): textarea 184px (40% of 460), ring visible at y=230 above the pill, list pinned to the latest message (5 of 5 runs after the fix, about half before).
- ＋ menu: Attach file, Save as draft, Drafts (2), Enter sends; Attach file opened the file chooser and the picked file showed its upload chip ("Paused, waiting for connection", Cancel, ×) with ➤ disabled while it waits.
- "Drafts (2)" over unsent text: the drafts panel opened, and loading a draft showed Replace / Append below / Cancel.
- "/sk": the skill menu opened above the pill with both `/skill:` matches.
- Search mode (search folder and models injected): the Model picker above the pill, "Drafts (2)", and the Search button on the right of the pill.
- Read-only session: no composer; the settings strip keeps the 🧠 context label and Abort.
- Not checked (needs a real microphone / live agent): voice dictation and the hands-free mic reopen. That code is unchanged apart from the `compact` sizing on `SpeechButton`.
