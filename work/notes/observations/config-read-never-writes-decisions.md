# config-read-never-writes: in-scope decisions

Decisions taken while implementing ADR 0022 ([docs/adr/0022-reading-the-config-never-writes-it.md](../../../docs/adr/0022-reading-the-config-never-writes-it.md)) that the task left open.

## Drift check

The task still matched reality at launch: nothing in `server/src` wrote into the config dir except the seed in `getWhereverConfig()`, and no settings UI writes `config.json` (ADR 0006 holds). `pi-sdk.ts` reads `config.json` directly (before session-pool loads) and never wrote it, so it needed no change.

## Defaults and the reader

- The defaults live in `defaultWhereverConfig()` in `server/src/config-dir.ts` (beside `getWhereverConfigDir()` and the new `getWhereverConfigPath()`), because that module has no heavy imports and both the reader and the CLI use it. It returns a FRESH object per call, as the old seed did, so a caller mutating its result cannot change later reads.
- Values pinned by test to the old seed: `{ gitInitDefault: false, remoteRepoRules: [], commonFolders: [] }`.
- Unparseable file: unchanged, `console.error('Failed to parse wherever config file:', err)` and `{}` (not the defaults), as the task says "keeps today's behaviour".

## Startup log wording

One line, right after the pi SDK line in `main()`:

- `[wherever] config: <absolute path> (found)`
- `[wherever] config: <absolute path> (not found, using built-in defaults)`

"found" is file existence only; a parse failure is reported separately by the reader's existing error log, the first time the config is read.

## `wherever config init`

- Writes `JSON.stringify(defaults, null, 2)` plus a trailing newline (the old seed had none; this is a new, user-facing file, so it ends like a normal text file).
- Creates the config dir with `mkdir -p` if needed. Refuses when `config.json` exists (`existsSync`), and writes with flag `wx` so a file appearing between the check and the write is not clobbered.
- stdout on success: `Wrote <path> (the built-in defaults).` Refusal to stderr: `wherever: <path> already exists; not overwriting it.` plus a hint line.

## `wherever config show`

- First line names the path and existence with the same wording as the startup log (`config: <path> (found)` / `(not found, using built-in defaults)`), then `Effective config (credential values shown as "<redacted>"):` and the pretty-printed JSON. With no file, it also suggests `wherever config init`.
- Effective config means the file's parsed JSON as is, or the defaults when absent. It does NOT merge defaults into a present file, because the reader does not either: what is shown is what the server uses.
- A file that is not valid JSON (or cannot be read) is an error: message to stderr naming the path and the parse error, exit 1. The server itself would log and run with `{}`; `show` says so.

### Redaction rule

Any key, at any depth, whose name matches `/token|secret|password|passphrase|api[-_]?key|private[-_]?key/i` has its value replaced by the string `<redacted>`. Objects are always walked (their own keys judged by the same rule, so structure stays visible); a matching key holding an array has each primitive element redacted. Empty strings and `null` are left as they are (they reveal nothing, and showing them tells the user the key is unset). This covers `assistantTelegram.token` (the Telegram bot token) and `remote.token` (the bridge auth token), the two credential keys the config has today, and errs toward over-redacting a future key.

## Exit codes

- `config init`: 0 written; 1 file already exists, or the write failed.
- `config show`: 0 shown; 1 file present but unreadable or not valid JSON.
- `config` with no subcommand, or an unknown one: usage to stderr, exit 1 (an unknown one is prefixed with `Unknown config command: <name>`).
- `config help` / `--help` / `-h`: usage to stdout, exit 0 (an explicit request for usage is not an error).
- Set via `process.exitCode` in `dispatch()`, not `process.exit()`, so stdout is flushed when piped.

## Test that relied on the seed

`server/test/pool-dispose-background.test.ts` detected a late config read by the file it seeded. With no seed that observable is gone, so the post-dispose config dir now holds an UNPARSEABLE `config.json` and the test asserts the reader's parse-error log never fires (and the file is untouched).
