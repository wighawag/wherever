# A human's send is marked for shipmates on the session's own event bus, and only web and Telegram sends are human

**Status:** accepted (2026-11-18)

[shipmates](https://github.com/wighawag/shipmates) lets sessions relay a human's words to each other as `human-relayed`, and a session's safety gates (push, publish, delete, approve) accept only `human` or `human-relayed` input. shipmates can only know which user messages a human typed if the host says so: its D22 and ADR 0003 define the mark, `shipmates:human-input` `{text, channel}` emitted on the session's `pi.events` bus right before the text is sent, which @shipmates/pi matches against the next `extension`-sourced `input` event and records as a human turn. Only extension code can reach that bus, so the model cannot produce a mark. wherever is the host for its web dashboard and its Telegram channel, so it has to emit the mark, and it must never emit it for text a human did not type.

We decided:

- **Which sends are human is decided by the routing origin (ADR 0014), in one place** (`humanInputChannel` in `server/src/shipmates-human-input.ts`): origin `none` (a web send, the WS `message` frame of an authenticated dashboard) is channel `web`; `telegram` and `telegram:<sub>` (the paired user's private messages) are channel `telegram`; everything else, in particular `schedule:<jobId>`, is not human and gets no mark. A `!` / `!!` shell send is not a user message and is never marked. Any new caller of `SessionPool.sendUserMessage` that is not a human MUST pass its own origin, since an omitted origin means a web send.
- **Server sessions: an inline extension per agent build** (`createHumanInputMarker`), like the conversation-mode signal (ADR 0004). It only keeps a reference to `pi.events`; the pool emits through it right before `prompt()`. It is rebuilt with the agent on `/reload`.
- **CLI-bridge sessions: the server asks, the extension emits.** `cli_message` carries `humanInput: {channel}` for a human's send only; `@wherever-dev/pi` emits the mark on the terminal pi's bus right before `pi.sendUserMessage`. An older extension ignores the field and marks nothing; an older server never sets it. Both fail toward "not human".
- **Every server send's `input` source is `extension`**, including `/`-prefixed text, which used to be sent with source `interactive`. pi documents `interactive` as typed in its TUI, and shipmates records an `interactive` input as the human's own words (channel `terminal`), so a scheduled job whose prompt starts with `/` would have counted as the human's. Expansion of skills, prompt templates and extension commands depends on `expandPromptTemplates`, not on the source, so nothing else changes for wherever; a CLI-bridge session already reported `extension` for the same text, which arrives there through `pi.sendUserMessage`.
- **An inbox answer from wherever is also a human act**: the web reply box (`shipmates_answer` from a dashboard, refused from a CLI bridge connection) and a Telegram reply to the notification of a shipmates item call `answerItem(id, text, {channel: 'web' | 'telegram'})`.

- **No mark for a send pi will not pass to its `input` event**: an extension command that handles `/name ...`, or a send while the session is compacting. @shipmates/pi keeps a mark until an input with the same text arrives, so a mark nobody consumes could later make the identical text from a scheduled job (whose `/`-prompts carry no prefix) count as the human's.
- **A CLI bridge connection cannot send the WS `message` frame**: it would be origin `none` and marked as typed on the web.

## Considered Options

- **Mark by the caller instead of by the origin** (a `humanInput` flag on every send). Rejected for now: the origin already says who a send is from, is threaded through every channel and the scheduler, and a second field could disagree with it. The cost is the rule above for new callers.
- **Keep `interactive` for human `/` sends and skip their mark.** Rejected: shipmates would record a web message as typed in a terminal, and a CLI-bridge session would report the same web text with another channel.
- **Ask pi to carry an origin on `prompt()` / `sendUserMessage` and persist it on the user entry.** The better long-term home (shipmates' D22 says so too), but it needs a pi change; the event bus works today.

## Consequences

- **Server sessions close every mark** (shipmates D35): the mark carries an `id`, and once the awaited `prompt()` settles (resolved or threw) the pool emits `shipmates:human-input-end` `{text, id}`, so a send another extension's `input` handler swallowed, or one refused while compacting, leaves nothing to match, with no window. The pre-check above stays as the first line.
- **Residue, CLI-bridge sessions only:** the bridge emits no end event, because `pi.sendUserMessage()` is fire-and-forget in pi 1.4 (it returns before the `input` handlers run), so an end there could drop a mark about to match. A mark that never reaches @shipmates/pi there relies on shipmates' 5 s expiry (D22): it could match only an identical `extension`-sourced input in the same session within 5 s. The upstream fix that removes the mark altogether is earendil-works/pi#12291 (an origin carried by `prompt()` / `sendUserMessage` and stored on the user entry).
- Integrity, not security (shipmates' ADR 0003): an agent on the same Unix user can still bypass shipmates. wherever's part is that none of its own paths turns agent or scheduled text into a human turn.
- Third-party extensions that branched on `source === 'interactive'` for web `/` messages now see `extension`, as they already did in CLI-bridge sessions.

Rename note (2026-11-22): this ADR was written when shipmates was called kenning (packages `kenning` and `kenning-pi`, now `shipmates` and `@shipmates/pi`; shipmates spec D38). Its text now uses the new names throughout: the `shipmates:human-input` events, `Symbol.for('shipmates.host')`, the `shipmates_*` frames and bridge ops, the `shipmates-*.json` state files and the `shipmates.enabled` switch were all `kenning` before. The decision itself did not change.
