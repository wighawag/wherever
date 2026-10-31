# pool-send-images: decisions (2026-10-31)

Non-obvious in-scope decisions taken while building task `pool-send-images` (spec `assistant-session-and-channels`, story 17).

1. **The CLI-bridge path carries images.** pi 1.4.0's `ExtensionAPI.sendUserMessage` accepts `string | (TextContent | ImageContent)[]` and `AgentSession.sendUserMessage` splits that into text + `images` for `prompt()`, so the extension sends `[{type:'text', text}, ...images]` when `cli_message` has images and the plain string otherwise (`extension/src/cli-message.ts`). Alternative: paths only on the CLI path (rejected, the API supports images). Expansion is unchanged: both forms keep the default `expandPromptTemplates: false`, as the string call did. Touches the `cli_message` wire format (`server/src/protocol.ts`) and the `@wherever-dev/pi` package; an old extension ignores the new key and still gets the paths in the text.

2. **`images` is a 6th positional parameter of `SessionPool.sendUserMessage`,** after `origin`, following the precedent set by `pool-per-message-routing` (origin as the 5th positional). The controller takes it in its existing options bag (`AssistantSendOptions.images`, beside `onDispatch`), and the channel dispatcher's `ChannelControllerPort.send` options gain the same field. Alternative: an options object on the pool send (rejected here: it would change every existing caller and test). An empty list is treated as none.

3. **Which files become images: the dispatcher, channel-agnostic.** `channelImages` (in `server/src/assistant-channels.ts`) takes every `ChannelFile` whose `mimeType` is `image/*`, or, with no `mimeType`, whose extension is `.jpg/.jpeg/.png/.gif/.webp`, and reads it from its saved path. So an image sent on Telegram AS A DOCUMENT (e.g. `image/png`) is also shown to the model, not only `photo`. Alternative: only Telegram `photo`s, decided in the Telegram channel from the bytes it already has (rejected: every future channel would redo it, and the file is already on disk). The image is ALSO kept as its `[Uploaded file: <path>]` line (the task's "images plus their staged path").

4. **No extra size or format gate in wherever.** Files are already capped at download (`min(20 MB, uploads.maxBytes)`, `telegram-files`); pi's `prompt()` normalizes every image (`processImage`: converts unsupported formats to PNG, resizes below the model's limit, or replaces it with an "[Image omitted: ...]" note), and for a text-only model pi-ai replaces images with its own note. Duplicating either in wherever would drift from pi. An image file that cannot be read is logged (`console.warn`) and sent as a path only, never failing the message.

5. **Shell sends ignore images.** A `!`/`!!` send has no user message, so images passed with one are dropped; channels refuse `!` before the pool anyway.

6. **Test infra: `HarnessOptions.modelInput`.** The harness's fake model stays text-only by default (pi's default), so no existing test changes; the real-server Telegram photo test opts into `['text', 'image']`.

7. **Changesets are `minor`** for both `wherever-dev` and `@wherever-dev/pi`: a user-visible capability (the model sees Telegram photos; a relayed message may carry images), matching the bumps of the earlier tasks in this chain.
