---
"wherever-dev": minor
---

Reading the config never writes it (ADR 0022). A missing `config.json` now simply means the built-in defaults (the same values the old starter file held, so nothing changes in effect), and the server no longer creates `~/.wherever/config.json` (or the config dir) on first run or on any later read; a read-only or absent config dir is no longer a warning. At start the server logs which config file it reads and whether it was found. Two new CLI verbs: `wherever config init` writes a starter `config.json` with the defaults (refusing, with a non-zero exit, to overwrite an existing one) and `wherever config show` prints the config path, whether the file exists and the effective config with credential values (such as `assistantTelegram.token` and `remote.token`) redacted. An existing `config.json`, including one seeded by an older release, is left untouched.
