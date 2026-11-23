# wherever-dev

[Wherever](https://wherever.dev) is a self-hosted workspace for AI coding agents. Install it on the machine where your code lives, open it from your phone, tablet or laptop, and work from there: every session across all your projects, live, from any device. When you want more, two optional features build on that: a personal assistant that remembers, works on a schedule and reaches you through push notifications and Telegram, and shipmates, which lets your sessions work together and bring their questions to a single inbox.

This package is the whole thing: the server runs the agent sessions itself and serves the web dashboard.

## Features

- **Every session from any device**: many concurrent sessions across your folders, a mobile-first installable dashboard that keeps working on weak connections, conversation mode (dictation and spoken replies), `!` shell commands, resumable file uploads and downloads.
- **Search everything** you ever said in any session, saved drafts, starred sessions.
- **Projects and machines**: git and remote repository setup on folder creation, restoring missing folders on a new machine, a distinct look per server, read-only views of autonomous agent fleets.
- **Your agent stack**: built on [pi](https://pi.dev), with your extensions, skills, models and MCP servers; a terminal `pi` can be mirrored live to the dashboard with [`@wherever-dev/pi`](https://www.npmjs.com/package/@wherever-dev/pi).
- Runs as a background service (systemd or launchd) with token auth and HTTPS.
- **The assistant** (optional): a long-lived agent with a folder for memory, recurring and one-shot jobs that follow your timezone, background jobs, push notifications, and a private Telegram bot you can chat and swap files with.
- **Sessions that work together** (optional) with [shipmates](https://github.com/wighawag/shipmates): presence in the sidebar, messages between sessions with their provenance, one "Needs you" inbox you can answer from the dashboard or Telegram, and sessions that spawn helper sessions.

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

`wherever install` also adds the terminal bridge extension `@wherever-dev/pi` to `~/.pi/agent/settings.json`, so a terminal `pi`, if you use one, is mirrored to the dashboard (skip with `--no-pi-config`).

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

`~/.wherever/config.json` (override the directory with `WHEREVER_CONFIG_DIR`; `wherever config init` writes a starter file) holds the rest: `assistantFolder` to turn on the assistant, its Telegram and push channels, preset folders, automatic remote repository creation, uploads, downloads, speech-to-text, the dashboard's per-machine appearance, and `piSdk`, which picks the agent runtime the sessions run on.

## Documentation

The [full documentation](https://github.com/wighawag/wherever#readme) covers every flag and configuration property, reverse proxies and trusted HTTPS (Tailscale, Tunnet), the service's memory limits and `PATH`, updating, and declarative deployment on NixOS.

## License

[AGPL-3.0-only](https://github.com/wighawag/wherever/blob/main/LICENSE)
