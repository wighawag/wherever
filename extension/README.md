# @wherever-dev/pi

The [pi coding agent](https://pi.dev) extension of [Wherever](https://wherever.dev). It bridges a terminal `pi` to a running Wherever server ([`wherever-dev`](https://www.npmjs.com/package/wherever-dev)), so the session you are running in the terminal shows up live in the web dashboard on your phone or any browser, and you can follow it, steer it and take it over from there.

You only need this for terminal sessions. Sessions started from the dashboard run inside the server and need nothing installed in pi.

## Install

```bash
pi install npm:@wherever-dev/pi
```

`wherever install` (which sets the server up as a service) adds it to `~/.pi/agent/settings.json` for you.

Then start the server (`wherever start`, or the service) and run `pi` as usual: the extension connects on startup and reconnects when the server comes back. While a terminal `pi` owns a session, it does the agent's work; quitting it interrupts the conversation on every device too.

## What it adds

- The live bridge: the dashboard sees the terminal session's messages, tool calls and streaming, and can send messages, steer and abort.
- `/remote-reconnect`: reconnect to the server by hand.
- `/remote-beep [on|off]`: play a sound when the agent is done and waiting for you (per session).
- The `attach_file` tool (the agent hands you a file to download on a remote device) and the `say` tool (a short spoken reply for the dashboard's conversation mode).

## Connecting to the server

Defaults reach a server on `127.0.0.1:31415` over WSS. Override them per run with flags, or for good in the `remote` section of `~/.wherever/config.json` (the file the server reads too). A flag wins over the config.

| Flag | `remote` in config.json | Default |
| --- | --- | --- |
| `--remote-host` | `host` | `127.0.0.1` |
| `--remote-port` | `port` | `31415` |
| `--remote-token` | `token` | none |
| `--remote-insecure` | `insecure` | `false`: connect over plain `ws://`, for a server started with `--no-ssl` behind a reverse proxy |
| `--remote-bridge` | `bridge` | `true`: set `bridge: false` to run pi without connecting |
| `--remote-beep`, `--remote-beep-command` | `beep.enabled`, `beep.command` (top level) | off |

## Documentation

See the [full documentation](https://github.com/wighawag/wherever#readme), in particular the bridge settings and reverse-proxy deployments.

## License

[AGPL-3.0-only](https://github.com/wighawag/wherever/blob/main/LICENSE)
