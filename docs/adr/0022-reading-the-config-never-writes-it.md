# Reading the config never writes it

**Status:** accepted

`getWhereverConfig()` used to create a default `config.json` whenever none existed, so every read could be a hidden write. We decided that reading the config never writes it: a missing `config.json` simply means the built-in defaults, and a config file is created only by an explicit user action (a `wherever config init` command). Discoverability comes from saying where the config is read from rather than from a file appearing.

Why:

- **A read that writes is how leaks happen.** Background work in the test suite (a late session-index warm-up) called `getWhereverConfig()` after a test had restored its env and seeded the CI runner's real `~/.wherever/config.json`. Any read from any code path, at any time, could do the same to a user's home.
- **It contradicts the config/state split (ADR 0006).** The config dir is READ-only by design and a read-only, deployment-rendered config is a supported setup; the seed was the one writer left there, already reduced to "best effort, warn on failure".
- **Seeding freezes the defaults.** A seeded file pins the defaults of the release that wrote it (`gitInitDefault: false`, empty lists): a later release that changes a default never reaches a user who never edited the file, because the file now "sets" it. Defaults that live in code move with the code.
- **User-authored config should hold only what the user chose.** It is the convention of git, ssh, ripgrep and npm, among others: no file means defaults, never an implicit create.

## Considered Options

- **Keep seeding, but only from the server's startup path** (never from library reads). Rejected: it still freezes the defaults and still writes into a possibly read-only config dir; it only narrows when the leak can happen.
- **Seed into the state dir instead.** Rejected: config would then be split across two directories and the "config dir is what the user edits" model breaks.

## Consequences

- A fresh install no longer finds a starter `config.json` to edit. `wherever config init` writes one (refusing to overwrite), `wherever config show` prints the effective config and the path it is read from, and the server logs at startup where the config is read from and whether a file was found.
- Existing seeded files stay as they are (nothing deletes them); they keep pinning the old defaults until the user edits or removes them.
