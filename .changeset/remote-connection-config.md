---
'@wherever-dev/pi': minor
'wherever-dev': patch
---

Configure the CLI bridge's connection from `config.json`, not just flags.

The bridge's connection settings were reachable only as command-line flags, which breaks down for any deployment that is not on the built-in defaults: the settings have to be repeated on every single `pi` invocation, and a human who starts `pi` by hand just gets a bridge that never connects.

The case that motivated this is a server behind a TLS-terminating reverse proxy. It runs `--http` on loopback and lets Caddy or nginx own HTTPS, but the extension defaults to `wss://`, so the bridge fails the TLS handshake with `wrong version number` while the server logs nothing at all: from the server's side no connection was ever made. The existing `--remote-insecure` flag fixes it per-invocation, which is the part that does not scale.

A new `remote` section in the shared `config.json` sets the same things persistently, alongside the `beep` section the extension already reads from that file:

- **`host`** / **`port`** / **`token`**: where the standalone server is, defaulting to `127.0.0.1:31415` as before.
- **`insecure`**: connect over plain `ws://`. This is the reverse-proxy case above.
- **`bridge`**: set `false` to disable the bridge entirely.

Precedence is explicit CLI flag, then config, then built-in default. Making that hold required dropping the registered `default:` from `--remote-host`, `--remote-port` and `--remote-token`, because a registered default is indistinguishable from the user typing that same value: `getFlag` always returned something truthy, so the config could never have won. The defaults now apply at the point of use and are stated in the flag descriptions, so `--help` is unchanged in substance.

Two of these are only reachable from config, and that is inherent rather than an oversight. A pi boolean flag cannot be passed as `false`, so `--remote-bridge` could never actually disable the bridge, and `remote.insecure: true` cannot be turned back off by a flag. The `insecure` asymmetry is documented on the config field: undo it by editing the config, not with a second negating flag.

The extension now also honours `WHEREVER_CONFIG_DIR` when locating `config.json`, matching the server's `getWhereverConfigDir()`. Previously an isolated harness would relocate the server's config while the extension kept reading the developer's real `~/.wherever/config.json`, which is the exact cross-talk that variable exists to prevent. With the variable unset the path is unchanged.
