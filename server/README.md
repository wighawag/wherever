# wherever-dev

The standalone server of [Wherever](https://wherever.dev): drive several [pi coding agent](https://pi.dev) sessions from a web dashboard on your phone, tablet or any browser, and keep a terminal `pi` in sync with them.

The server runs pi sessions in-process through the pi SDK and serves the web dashboard, so you do not need the `pi` CLI to use it. Install [`@wherever-dev/pi`](https://www.npmjs.com/package/@wherever-dev/pi) into pi as well if you also want terminal sessions mirrored to the dashboard (bridge mode).

## Features

- Many concurrent sessions across your project folders, created, resumed and forked from the browser.
- A mobile-first dashboard (installable as a PWA): streaming replies, tool calls, model switching, `!` / `!!` shell commands, file and image uploads, downloads of files the agent attaches.
- Voice dictation and optional spoken replies.
- Native MCP: the servers in `~/.pi/agent/mcp.json` are available in web sessions, as in a terminal pi.
- Live hand-over with a terminal `pi` (through `@wherever-dev/pi`).
- Runs as a background service (systemd or launchd) with token auth and HTTPS.

## Install

Requires Node.js 22.19 or later.

```bash
npm install -g wherever-dev
wherever start
```

Then open `https://localhost:31415`. The server generates a self-signed certificate on first start (this needs `openssl`; without it the server falls back to plain HTTP), so the browser will warn once.

To run it as a service that starts with your session and restarts on failure:

```bash
wherever install            # per-user systemd unit (Linux) or LaunchAgent (macOS)
wherever service-status
wherever uninstall
```

`wherever install` also adds `@wherever-dev/pi` to `~/.pi/agent/settings.json` (skip with `--no-pi-config`).

## Common options

| Flag | Environment | Default |
| --- | --- | --- |
| `--port` | `PI_REMOTE_PORT` | `31415` |
| `--host` | `PI_REMOTE_HOST` | `127.0.0.1` (use `0.0.0.0` to expose it) |
| `--token` | `WHEREVER_TOKEN`, `WHEREVER_TOKEN_FILE` | none |
| `--ssl-key` / `--ssl-cert` | `WHEREVER_SSL_KEY` / `WHEREVER_SSL_CERT` | auto-generated self-signed pair |
| `--no-ssl` (or `--http`) | `PI_REMOTE_NO_SSL` | HTTPS on |
| `--idle-timeout` | `PI_IDLE_TIMEOUT` | 20 minutes |

Prefer `WHEREVER_TOKEN` or `WHEREVER_TOKEN_FILE` over `--token` on a shared machine: a command line is readable by every user. Open `https://<host>:31415/#token=<token>` once on a device to log it in.

## Configuration

`~/.wherever/config.json` (override the directory with `WHEREVER_CONFIG_DIR`) holds the rest: preset folders, automatic remote repository creation, uploads, downloads, speech-to-text, the dashboard's per-machine appearance, and `piSdk`, which lets web sessions run on the pi you use in a terminal instead of the bundled SDK.

## Documentation

The [full documentation](https://github.com/wighawag/wherever#readme) covers every flag and configuration property, reverse proxies and trusted HTTPS (Tailscale, Tunnet), the service's memory limits and `PATH`, updating, and declarative deployment on NixOS.

## License

[AGPL-3.0-only](https://github.com/wighawag/wherever/blob/main/LICENSE)
