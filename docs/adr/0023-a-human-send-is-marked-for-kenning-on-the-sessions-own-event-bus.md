# A human's send is marked for kenning on the session's own event bus, and only web and Telegram sends are human

**Status:** accepted (2026-11-18)

[kenning](https://github.com/wighawag/kenning) lets sessions relay a human's words to each other as `human-relayed`, and a session's safety gates (push, publish, delete, approve) accept only `human` or `human-relayed` input. kenning can only know which user messages a human typed if the host says so: its D22 and ADR 0003 define the mark, `kenning:human-input` `{text, channel}` emitted on the session's `pi.events` bus right before the text is sent, which kenning-pi matches against the next `extension`-sourced `input` event and records as a human turn. Only extension code can reach that bus, so the model cannot produce a mark. wherever is the host for its web dashboard and its Telegram channel, so it has to emit the mark, and it must never emit it for text a human did not type.

We decided:

- **Which sends are human is decided by the routing origin (ADR 0014), in one place** (`humanInputChannel` in `server/src/kenning-human-input.ts`): origin `none` (a web send, the WS `message` frame of an authenticated dashboard) is channel `web`; `telegram` and `telegram:<sub>` (the paired user's private messages) are channel `telegram`; everything else, in particular `schedule:<jobId>`, is not human and gets no mark. A `!` / `!!` shell send is not a user message and is never marked. Any new caller of `SessionPool.sendUserMessage` that is not a human MUST pass its own origin, since an omitted origin means a web send.
- **Server sessions: an inline extension per agent build** (`createHumanInputMarker`), like the conversation-mode signal (ADR 0004). It only keeps a reference to `pi.events`; the pool emits through it right before `prompt()`. It is rebuilt with the agent on `/reload`.
- **CLI-bridge sessions: the server asks, the extension emits.** `cli_message` carries `humanInput: {channel}` for a human's send only; `@wherever-dev/pi` emits the mark on the terminal pi's bus right before `pi.sendUserMessage`. An older extension ignores the field and marks nothing; an older server never sets it. Both fail toward "not human".
- **Every server send's `input` source is `extension`**, including `/`-prefixed text, which used to be sent with source `interactive`. pi documents `interactive` as typed in its TUI, and kenning records an `interactive` input as the human's own words (channel `terminal`), so a scheduled job whose prompt starts with `/` would have counted as the human's. Expansion of skills, prompt templates and extension commands depends on `expandPromptTemplates`, not on the source, so nothing else changes for wherever; a CLI-bridge session already reported `extension` for the same text, which arrives there through `pi.sendUserMessage`.
- **An inbox answer from wherever is also a human act**: the web reply box (`kenning_answer` from a dashboard, refused from a CLI bridge connection) and a Telegram reply to the notification of a kenning item call `answerItem(id, text, {channel: 'web' | 'telegram'})`.

- **No mark for a send pi will not pass to its `input` event**: an extension command that handles `/name ...`, or a send while the session is compacting. kenning-pi keeps a mark until an input with the same text arrives, so a mark nobody consumes could later make the identical text from a scheduled job (whose `/`-prompts carry no prefix) count as the human's.
- **A CLI bridge connection cannot send the WS `message` frame**: it would be origin `none` and marked as typed on the web.

## Considered Options

- **Mark by the caller instead of by the origin** (a `humanInput` flag on every send). Rejected for now: the origin already says who a send is from, is threaded through every channel and the scheduler, and a second field could disagree with it. The cost is the rule above for new callers.
- **Keep `interactive` for human `/` sends and skip their mark.** Rejected: kenning would record a web message as typed in a terminal, and a CLI-bridge session would report the same web text with another channel.
- **Ask pi to carry an origin on `prompt()` / `sendUserMessage` and persist it on the user entry.** The better long-term home (kenning's D22 says so too), but it needs a pi change; the event bus works today.

## Consequences

- Residue: a mark whose send still never reaches kenning-pi's `input` handler (another extension's `input` handler returns `handled` first; in a CLI-bridge session, a send refused because the terminal pi is compacting) stays in kenning-pi's bounded queue (20 marks per session), and could match a later `extension`-sourced input with the identical text in the same session. The proper fix is in kenning-pi: a mark should be valid only for a short time (seconds), since the host emits it right before the send.
- Integrity, not security (kenning's ADR 0003): an agent on the same Unix user can still bypass kenning. wherever's part is that none of its own paths turns agent or scheduled text into a human turn.
- Third-party extensions that branched on `source === 'interactive'` for web `/` messages now see `extension`, as they already did in CLI-bridge sessions.
