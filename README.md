# Wherever

A modern, multi-session remote control platform for the [pi coding agent](https://pi.dev) consisting of a **Standalone Server** (`wherever-dev`), a **Web Frontend**, and a **CLI Bridge Extension** (`@wherever-dev/pi`).

It allows you to manage multiple pi sessions concurrently across your workspace directories from a gorgeous web dashboard while keeping your terminal CLI fully synced in real-time.

```
┌────────────────────────────────────────────────────────┐
│                   Wherever Server                      │
│                                                        │
│  ┌──────────────┐         WebSocket        ┌────────┐  │
│  │ Web Frontend │◄────────────────────────►│  CLI   │  │
│  │  (Svelte 5)  │◄────────────┐            │ Bridge │  │
│  └──────────────┘             │            └────────┘  │
│                               ▼                        │
│                     ┌──────────────────┐               │
│                     │  Agent Sessions  │               │
│                     │ (Standalone/SDK) │               │
│                     └──────────────────┘               │
└────────────────────────────────────────────────────────┘
```

---

## Key Features Breakdown

### 🔄 Collaborative CLI Mirroring & Reconnection

- **Bidirectional Sync:** The terminal CLI process and Svelte web dashboard mirror each other's inputs, agent reasoning/thinking steps, tool execution starts, tool outputs, and results in real-time.
- **Auto-Recovery:** Built-in background reconnection with exponential backoff guarantees that the CLI bridge and Standalone Server automatically pair up whenever either process starts or restarts.

### 🔌 Seamless Headless / Bridge Handover

- **Continuous Flow:** Close your terminal CLI, and the Standalone Server automatically transitions the active session to a server-side headless session running on the Pi SDK.
- **Zero Disruption:** Re-open your terminal CLI, and control is instantly handed back to your CLI—with zero data loss, zero database lock conflicts, and perfect continuity.
- **Bridge Mode Interruption Limitation:** When running in Bridge Mode, the active `pi` CLI process in your terminal maintains exclusive control of the executing agent's loop ("brain operation"). If you quit or close the `pi` CLI (e.g. via `Ctrl+C` or closing your terminal window), any active conversation, run, or tool execution will be immediately interrupted, even if you are interacting with it from the web dashboard. This is a design limitation of the `pi` CLI architecture.

### 🎙️ WAV Dictation & Speech-to-Text (Voice Control)

- **Direct PCM Web Audio Capture:** Bypasses heavy `MediaRecorder` browser encoding, streaming raw audio chunks directly to an in-memory buffer for instant, zero-latency WAV creation.
- **Audible Chime Cue:** Emits a synthesized starting beep so you know exactly when the microphone is listening and when to speak.
- **Dual Gesture Control:** Supports both standard click-to-start/stop recording or hold-to-talk (walkie-talkie style) controls.
- **Color-Coded Feedback:** Features distinct pulsing red indicators for active recording and solid orange/yellow indicators during cloud processing & downsampling.
- **Dual Transcription Engines:** Transcribe locally using the browser’s Web Speech API, or route to highly accurate server-side cloud speech-to-text engines (configured to Zhipu GLM-ASR-2512 or any OpenAI-compatible Whisper endpoint).

### 💻 Direct Bash Execution (`!` and `!!`)

- **Terminal Power:** Execute bash commands directly from the Svelte web frontend by prefixing them with `!` or `!!` (e.g., `!ls`, `!!git status`), matching the pi CLI's interactive behavior. A `!sudo ...` command pops a one-shot, masked password prompt (the password is used once to run the command and is never stored or logged); a fresh password is required every time.
- **Real-Time Streaming:** Streams tool execution stdout/stderr chunks back to the dashboard in real-time, capturing output and exit codes directly into the session history.

### 📁 Multi-Modal File & Image Uploads

- **Rich Context Support:** Upload documents, screenshots, and diagrams for multi-modal agent processing, automatically appending absolute paths to your active message box.
- **Secure Hybrid Transport:** Upload via Base64 over WebSockets (immune to mobile browser self-signed SSL certificate blocks or CORS limitations) or standard HTTP multipart POST.
- **Custom Storage Backends:** Highly configurable file target backends, allowing you to save files to `/tmp`, store them directly within the session's workspace (`cwd`) under a custom subdirectory (e.g. `.wherever/uploads`), or save them to a custom absolute directory on the server.

### 🔍 Smart Path Autocomplete & Verification

- **Path Suggestions:** Autocompletes folder path inputs on session creation from preset lists (`commonFolders`) and real-time directory lookups.
- **Folder Validation:** Instantly queries path status to verify if the directory exists and check if it is already initialized as a Git repository.

### 🐙 Automatic Git & Remote Repo Setup

- **Automatic Init:** Automatically runs `git init` on newly created folders that are not already under git source control.
- **CLI Remote Provisioning:** When a folder matches configured regular expression rules, the server automatically executes the provider's CLI (such as `gh` for GitHub, or `tea`/`cb` for Gitea/Codeberg/Forgejo) to provision a new public or private repository on the host, setting up your `origin` remote automatically.

### 🗂️ Polished Folder Browser & Sidebar

- **Folder Grouping:** Displays active and archived sessions grouped neatly by folder.
- **Collapsible Trees:** Folders are compressed by default to keep the sidebar extremely clean.
- **Inline Deletion:** Support for direct session deletion with an inline double-confirmation step, syncing deletions across all connected clients.
- **Unified Search:** Search and filter active or archived sessions by title, first message, or workspace folder names.

### 🛑 Folder Overlap Warning

- **Non-blocking warning banner:** If you open (or start) a session in a folder where **another** session is already active, you are **not** blocked by a dialog. You attach as a **read-only observer** and a dismissible-style **warning banner** appears at the top.
- **Continue anyway:** Click **Continue anyway** to enable the composer and work alongside the other session (it is **not** interrupted or taken over — both run concurrently, so changes may conflict). After continuing, the banner stays as a passive warning and disappears automatically once no other session is active in that folder.

### 📱 Mobile-Optimized UX & Layout Locks

- **Visual Viewport Constraining:** Lock page overscroll bouncing specifically tuned for mobile browsers (Firefox/Safari) to prevent visual breakages during keyboard popups and text inputs.
- **Collapsible Text Input:** Expand or collapse the chat input area on demand for maximum readability and space efficiency on small screens. Click to automatically focus and expand.
- **Input Queueing:** If you type and send a message while the agent is currently streaming or processing a tool, the input is queued and automatically submitted the instant the agent finishes.

---

## Installation

There are two ways to install and run Wherever: **Quick Install via NPM** (recommended for users), or **Local Development Setup** (for active contributors).

> 💡 **Note on Pi Installation:** You do **not** need the `pi` CLI installed globally to use Wherever in **Headless Mode** (running agent sessions entirely from the web frontend). The standalone server (`wherever-dev`) runs the Pi agent in-process using the Pi SDK. You only need the `pi` CLI if you want to use **Bridge Mode** to sync a terminal CLI session in real-time.

### Method A: Quick Install (via NPM) 🚀

This is the easiest and most robust way to run Wherever. No cloning or local compiling required!

#### 1. Install the Standalone Server Globally

Install the Wherever Standalone Server command-line tool globally:

```bash
npm install -g wherever-dev
```

#### 2. Install the CLI Extension into Pi (Optional — Only for Terminal Bridge Mode)

If you want to sync a terminal CLI session in real-time, install the remote connection bridge extension using Pi's package manager:

```bash
pi install npm:@wherever-dev/pi
```

#### 3. Start the Server

Start the standalone multi-session server:

```bash
wherever start
```

The server will boot up and automatically generate self-signed SSL certificates for a secure `https`/`wss` local environment. Open `https://localhost:31415` in your browser. (The first time, proceed past your browser's SSL warning).
_(Note: Automatic certificate generation requires `openssl` to be installed on your host system. If `openssl` is missing, the server will gracefully fall back to HTTP/WS)._

_The self-signed certificate is fine for everyday use, but browsers will not treat it as a secure context, which prevents installing the dashboard as a standalone PWA from a remote device. To enable a proper standalone PWA install, see [Trusted HTTPS for Tailscale](#trusted-https-for-tailscale-recommended-for-pwa-install) or [Trusted HTTPS for Tunnet](#trusted-https-for-tunnet)._

#### 4. Run Pi (Optional — Only for Terminal Bridge Mode)

To connect your local terminal CLI to the Standalone Server, run `pi` as normal in any project folder:

```bash
pi
```

Pi will automatically detect and load the `@wherever-dev/pi` extension, establish a real-time connection to your standalone server, and mirror your workspace to the Web Dashboard!

Note though that when pi cli run, it takes control of the brain operation and quiting (via ctrl+c, /quit, etc...) will interupt the conversation even on every devices

#### 5. Run as a Background Service (Optional)

Instead of keeping a terminal open, you can install Wherever as a background service that starts automatically and restarts on failure:

```bash
wherever install
```

This installs and starts a per-user service (a **systemd** user unit on Linux, or a **launchd** LaunchAgent on macOS). It also adds the `@wherever-dev/pi` extension to `~/.pi/agent/settings.json` for you (unless it is already configured), so a running `pi` CLI bridges into the server automatically.

Server flags are baked into the service, so you can pass them through at install time:

```bash
wherever install --host 0.0.0.0 --token your-secure-token --port 31415
```

> ⚠️ **`--token` puts the secret in the service's command line, and a command line is world-readable.** `wherever install` bakes the flags above verbatim into `ExecStart`, so the token ends up both in the unit file and in `/proc/<pid>/cmdline`, where any user on the machine can read it with a plain `ps`. That is acceptable on a personal single-user laptop and **not** on a shared or internet-facing box.
>
> For a real deployment supply it through the environment instead: set `WHEREVER_TOKEN` (or `WHEREVER_TOKEN_FILE`, pointing at a `0400` file that a secret manager renders) and install **without** `--token`. See [Supplying the token](#supplying-the-token-argv-is-world-readable). To add it to a unit that already exists:
>
> ```bash
> systemctl --user edit wherever    # add: [Service] / Environment="WHEREVER_TOKEN=..."
> # better still, keep it out of the unit too:
> #   EnvironmentFile=-/etc/wherever/token.env   (chmod 0400)
> ```

Other subcommands:

```bash
wherever service-status   # show whether the service is running
wherever uninstall        # stop and remove the service
```

Install options:

- `--system` — Install a system-wide service instead of a per-user one (Linux only, requires root).
- `--no-pi-config` — Do not modify `~/.pi/agent/settings.json`.
- `--port` / `--host` / `--token` — Server flags to bake into the service invocation. (Prefer `WHEREVER_TOKEN` in the unit's environment over `--token`; see the warning above.)
- `--dry-run` — Print the generated unit/plist and the intended actions without writing anything.

##### Memory limits (systemd)

The generated systemd unit carries a memory backstop:

```ini
MemoryHigh=1G
MemoryMax=1500M
```

`MemoryHigh` is a soft limit: past it the kernel throttles the cgroup and reclaims aggressively, so a memory problem shows up as this one service getting slow. `MemoryMax` is the hard wall: past it the kernel OOM-kills **this** unit and `Restart=on-failure` brings it back, instead of the machine going into swap thrash and something else being killed. Steady state is around 200 MB with a 2 GB sessions directory, so there is a wide margin.

Tune them at install time, or turn them off:

```bash
wherever install --memory-high 2G --memory-max 3G   # raise (many concurrent sessions)
wherever install --no-memory-limits                 # omit both directives
```

If you installed the service before these limits existed, re-run `wherever install` with your original flags (or add the two lines to the unit yourself and run `systemctl --user daemon-reload && systemctl --user restart wherever`). To check current usage: `systemctl --user status wherever` shows `Memory: … (peak: …)`.

One caveat worth knowing: systemd **silently ignores** these directives unless the memory controller is delegated to the slice the unit runs in (cgroup v2 with delegation; not the case on cgroup v1 or some older user slices). Install prints the check, which is `systemctl --user show wherever -p MemoryMax` — if it reports `infinity`, the limit is not in force.

launchd (macOS) has no equivalent per-service memory cap, so there is nothing to bake in there.

#### Updating to a new version

The service runs a fixed path to the installed `wherever-dev` package, so updating the package files on disk does **not** restart the already-running process: it keeps the old code in memory until it is restarted. After you install a new version, do one of the following:

1. Update the package however you installed it, for example:

   ```bash
   npm install -g wherever-dev@latest
   ```

2. Then apply it to the running service, using EITHER of these:

   ```bash
   # Simplest: just restart the service to load the new code.
   systemctl --user restart wherever        # Linux (per-user)
   # Linux (system-wide install): sudo systemctl restart wherever
   # macOS: launchctl unload  ~/Library/LaunchAgents/dev.wherever.server.plist \
   #     && launchctl load ~/Library/LaunchAgents/dev.wherever.server.plist

   # OR re-run install with the SAME flags you used originally. This rewrites
   # the service definition and restarts it in one step.
   wherever install --host 0.0.0.0 --token your-secure-token --port 31415
   ```

> You do **not** need a manual restart *after* `wherever install`: install already restarts the service itself (it runs `daemon-reload` + `enable --now` + `restart`). Use a bare `systemctl --user restart wherever` only when you updated the package without re-running install.

> A restart rebuilds the server's session pool, so any warm sessions pick up new tools/behaviour from the update. In-flight conversations are interrupted by the restart, so update when idle.

> If you run Wherever from a source checkout (Method B below) rather than the published package, the service, if you installed one, still points at the global package path, not your repo. Rebuild + run your local server directly (or reinstall pointing at your build) to test local changes.

> On Linux user services, run `loginctl enable-linger $USER` if you want the service to keep running after you log out. Windows is not supported yet; run `wherever start` manually or use a tool like NSSM.

> **Linux `PATH` / environment caveat (important).** A systemd **user** service does **not** source your login shell (`~/.profile`, `~/.bashrc`, `~/.config/fish/config.fish`, etc.). It inherits the **systemd user manager's** environment, which your desktop session imports separately, and it **snapshots that environment once at start** and never re-reads it. Two consequences follow:
>
> - Your curated dev `PATH` (volta, pixi, pnpm, cargo, foundry, ...) is only visible to the service if it was imported into the user manager **before** the service started. Your shell config alone does not put it there.
> - That import can happen in **stages** during login. If the service starts during a window where the manager's `PATH` is still incomplete (for example missing the system dirs `/usr/bin`, `/bin`), it freezes that incomplete `PATH` for its whole lifetime, and every tool it (or anything it spawns) later invokes by name (`git`, `ssh`, coreutils) then fails with an opaque `ENOENT`. Within one affected process this is **constant**, not flaky: the missing dir is missing for every command until the service is restarted with a complete `PATH`. The only reason it looks intermittent is **across service restarts**: whether a given start captured a complete `PATH` depends on start-time ordering, so the same setup fails one boot and works the next. A later `export PATH=...` in a shell cannot fix a running instance: it cannot mutate the already-running service's frozen environment.
>
> To get your full, correct `PATH` into the service, use ONE of these (systemd-native; do **not** try to make the unit "source fish/bash"):
>
> 1. **Import your session PATH into the user manager, then (re)start the service after it:**
>    ```bash
>    systemctl --user import-environment PATH
>    systemctl --user restart wherever
>    ```
>    This copies your current shell-built `PATH` (volta/pixi/etc included) into the manager so the service inherits it. Many desktops already run `import-environment` at login; the point is that `wherever` must start *after* it. If your login does not import it reliably, add the two lines above to your session startup.
> 2. **Pin a `PATH` on the unit (deterministic, but static).** Edit `~/.config/systemd/user/wherever.service`, add an `Environment=PATH=...` line under `[Service]` that includes at least the system dirs (`/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`) plus any tool-manager dirs you need (e.g. `%h/.volta/bin:%h/.local/bin:%h/.cargo/bin`), then `systemctl --user daemon-reload && systemctl --user restart wherever`. This never races, but you now maintain the list by hand and it will not auto-track new tool-manager dirs. A `~/.config/environment.d/10-path.conf` with `PATH=...` achieves the same for all user services.
>
> Diagnose the running service's actual `PATH` with:
> ```bash
> systemctl --user show wherever -p Environment
> systemctl --user show-environment | grep '^PATH='
> tr '\0' '\n' < /proc/$(systemctl --user show wherever -p ExecMainPID --value)/environ | grep '^PATH='
> ```
> If that `PATH` is missing `/usr/bin` (or a tool dir you expect), it started too early: import/pin as above and restart. Restarting drops in-flight sessions, so do it when idle.

> Note: the server is started with the explicit `wherever start` verb. A bare `wherever` prints the command help. All server flags below apply to `wherever start`.

---

### Method B: Local Development Setup (From Source) 🛠️

If you want to modify the source code, develop custom features, or run pre-release code locally:

#### 1. Clone and Install Dependencies

Clone this repository and install all monorepo workspace dependencies:

```bash
git clone https://github.com/wighawag/wherever.git
cd wherever
pnpm install
```

<details>
<summary><b>With Nix (exact toolchain, no global installs)</b></summary>

```bash
nix develop      # node + pnpm + openssl + git, pinned; nothing from your login shell
pnpm install
pnpm build
```

The shell provides the node and pnpm the lockfile expects, so there is no version-manager shim on `PATH` to go stale. `openssl` is in there because the server invokes it **by name** to mint its fallback self-signed certificate, and `git` because the web build reads a rev to stamp a build id.

`nix build` produces a runnable server (`./result/bin/wherever`). The derivation itself lives in `package.nix`, a plain function of `pkgs`, so a deployment repo can build it against its own nixpkgs pin without taking this flake as an input — see [ADR 0008](docs/adr/0008-nix-packaging-package-nix-is-the-interface-flake-is-a-wrapper.md) and [Deploying declaratively](docs/deployment-nixos.md).

> **Maintenance note.** `package.nix` pins `pnpmDepsHash`, which fixes the *content* of the resolved dependency set. **It must be regenerated whenever `pnpm-lock.yaml` changes.** A stale hash does not fail the build — Nix silently reuses the previous lockfile's dependency set — which is why there is a script and a CI check rather than just this paragraph:
>
> ```bash
> ./nix/update-pnpm-deps-hash.sh   # or: nix run .#update-pnpm-deps-hash
> ./nix/check-pnpm-deps-hash.sh    # what CI runs; fails loudly when stale
> ```

</details>

#### 2. Build All Components

Build the frontend, copy it to the server's public asset path, and compile both TypeScript packages (server & extension) using our unified build script:

```bash
pnpm build
```

#### 3. Install the Extension via Symlink

Symlink your local compiled development extension directly into Pi's extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$(pwd)/extension" ~/.pi/agent/extensions/wherever
```

#### 4. Start the Server in Development Mode

```bash
pnpm run server:dev
```

Open `https://localhost:31415` in your browser.

#### 5. Run Pi (Optional — Only for Terminal Bridge Mode)

If you want to sync your terminal CLI with the standalone server, run `pi` in any directory. It will load the symlinked local extension and connect automatically!

_(Optional) **Frontend HMR:** If you are actively working on Svelte dashboard components and want Hot Module Replacement, run the Vite dev server:_

```bash
pnpm --filter ./web dev
```

---

## Directory Structure

- **`server/`** — Node.js Standalone HTTP/WebSocket Server managing independent in-process SDK sessions.
- **`web/`** — Modern Svelte 5 Web Dashboard for remote chatting, folder browsing, and model configuration.
- **`extension/`** — CLI Bridge Extension that runs inside the local `pi` terminal process and acts as a sync client.

---

## Custom Settings (CLI Flags / Environment Variables)

Both the server and CLI bridge extension accept standard flags to customize ports, host bindings, and auth tokens.

### Standalone Server Settings

- `--port`, `PI_REMOTE_PORT` (Default: `31415`)
- `--host`, `PI_REMOTE_HOST` (Default: `127.0.0.1`, set to `0.0.0.0` to expose to outside/local network)
- `--token`, `WHEREVER_TOKEN`, `WHEREVER_TOKEN_FILE`, `PI_REMOTE_TOKEN` (Optional auth token — see [Supplying the token](#supplying-the-token-argv-is-world-readable) for the precedence rules and why the flag is the wrong channel on a shared machine)
- `--idle-timeout`, `PI_IDLE_TIMEOUT` (Idle-session eviction window, default: `1200000` = 20 minutes)
- `--ssl-key`, `WHEREVER_SSL_KEY` / `PI_REMOTE_SSL_KEY` (Path to the SSL private key for HTTPS/WSS. May be an absolute path anywhere, including outside any home directory)
- `--ssl-cert`, `WHEREVER_SSL_CERT` / `PI_REMOTE_SSL_CERT` (Path to the SSL certificate. Resolved independently of the key, so the two can live in different places — e.g. a key from a secret manager and a certificate from ACME)
- `--no-ssl` / `--http`, `PI_REMOTE_NO_SSL` / `PI_REMOTE_HTTP` (Disables SSL, falling back to standard HTTP/WS)
- `--debug`, `PI_DEBUG` / `WHEREVER_DEBUG` (Enables the eruda custom-plugin loader in the dashboard for local mobile debugging — see [Debugging](#debugging). Off by default; only enable locally, since it permits loading eruda plugins from a `?eruda=<pkg>` URL parameter)

#### Directories: config (read) vs state (written)

- `WHEREVER_CONFIG_DIR` (Default: `~/.wherever`) — where `config.json` is **read** from. It may be **read-only**: nothing the server writes goes here.
- `WHEREVER_STATE_DIR` (Default: **the resolved config dir**) — where the server **writes**: `drafts.json` and the auto-generated self-signed pair in `certs/`.

With `WHEREVER_STATE_DIR` unset the layout is exactly what it has always been (`~/.wherever/config.json`, `~/.wherever/drafts.json`, `~/.wherever/certs/`), so nothing changes for an existing install. Set it when the config directory is rendered by a deployment and cannot be written to — see [Deploying declaratively](docs/deployment-nixos.md).

Of the two, only `drafts.json` is worth backing up (it is the only copy of text the user asked to keep); `certs/` regenerates itself. Note this is **not** the same as "back up the state directory": session transcripts are written by pi under `PI_CODING_AGENT_DIR`, not by wherever, and they are usually the most valuable data on the machine — see [what to back up](docs/deployment-nixos.md#what-to-back-up).

> **If you already set `WHEREVER_CONFIG_DIR`**, note that the generated `certs/` directory now follows it (it used to be pinned to `~/.wherever/certs` regardless). Should you have placed a real certificate at `~/.wherever/certs/localhost.*` by hand, either move it under your config dir or set `WHEREVER_STATE_DIR=~/.wherever` to keep the old location.

#### Supplying the token (argv is world-readable)

`/proc/<pid>/cmdline` is readable by **every user on the machine**, so `--token <secret>` hands the token to anyone who runs `ps`. On a single-user laptop that is fine; on a shared or bare-metal host it is not. The token is resolved from the first of these that yields a value:

| Precedence | Source | Notes |
| --- | --- | --- |
| 1 | `--token <value>` | Works as before, including `--token ""` to mean "no token" and override the environment. Taken verbatim. Visible via `ps` — the server warns at startup when it is used. |
| 2 | `WHEREVER_TOKEN` | **Preferred for real deployments.** The environment block is readable only by the process owner and root. Trimmed. |
| 3 | `WHEREVER_TOKEN_FILE` | Path to a file whose contents are the token (trimmed). The natural shape for a secret manager (sops-nix, systemd `LoadCredential=`): the secret is never in argv *or* in the environment, only its path is. |
| 4 | `PI_REMOTE_TOKEN` | The original variable, still honoured. Taken verbatim. |

The two **new** sources are whitespace-trimmed, because a secret file ends with a newline. The two **pre-existing** ones are taken byte-for-byte as they always were, since trimming them would change which string authenticates on an install that already works.

If `WHEREVER_TOKEN_FILE` is the source in use and the file is missing, unreadable or empty, the server **refuses to start**. Falling through to "no token" would silently bring up an unauthenticated server that looks perfectly healthy — see [ADR 0007](docs/adr/0007-secrets-never-in-argv-token-resolution-order.md). For the same reason, a token variable that is set but blank warns loudly, and so does binding a non-loopback address with no token at all.

TLS gets the same treatment: if you point `--ssl-key`/`--ssl-cert` (or the `WHEREVER_SSL_*` variables) at material that cannot be loaded, the server exits instead of quietly falling back to plaintext HTTP on the same address. Use `--no-ssl` if plaintext is what you want.

#### Handing the token to a browser (one link, no typing)

A token-protected instance is reachable with a **single link**: open

```
https://<host>:31415/#token=your-secure-token
```

The dashboard takes the token out of the fragment on boot, stores it in its normal connection config, and then **removes it from the address bar** (with `history.replaceState`, so no history entry keeps the secret either). From that point on the page, the `/sessions` API calls and the WebSocket are all authenticated, reloads keep working, and there is nothing to type into Connection Settings. This is the form to share, e.g. in the QR code or chat message you send yourself when setting up a phone.

Use the **hash**, not a query string. A fragment is never sent to the server, so the token stays out of HTTP access logs, out of the `Referer` header sent to whatever site you visit next, and out of the request log of every reverse proxy in between. `https://<host>:31415/?token=...` is still accepted, so links already handed out keep working, but it leaks the secret into all three of those places; both forms are scrubbed from the address bar once read.

A blank `#token=` is ignored rather than stored, so a malformed link cannot log you out of a session that is already working, and adopting a link only touches the token: your host, port and display preferences are left as they are. That last point cuts both ways, so it is worth stating plainly: if this dashboard is configured to connect to a *different* host, a token link opened here replaces the token it uses for that host, since the link says nothing about which server it belongs to.

**Percent-encode the token in the link.** The fragment is read as form-encoded key/value pairs (`#token=X&foo=1` works, and so do other fragment keys), which means a literal `+` in the token would arrive as a space: write it `%2B`. The same is true of the `?token=` form, which the server already decodes the same way. The capitalisation of the key itself does not matter (`#TOKEN=` is accepted), so a retyped link still works rather than being mistaken for something else.

### CLI Bridge Settings

Whenever you run `pi`, you can override bridge defaults:

- `--remote-host` (Default: `127.0.0.1`)
- `--remote-port` (Default: `31415`)
- `--remote-token` (Auth token if configured)
- `--remote-bridge` (Set to `false` to run as offline standard CLI)
- `--remote-secure` (Connect via WSS. Default: `true`.)
- `--remote-insecure` (Connect via plain `ws://` instead of WSS. Use when the server runs with `--no-ssl`, e.g. bound to localhost behind a reverse proxy like Caddy/nginx that terminates HTTPS. Overrides `--remote-secure`.)

> **Reverse-proxy / `--no-ssl` deployments:** you have two ways to bridge. Either point the bridge at the public HTTPS endpoint your proxy serves (the bridge's default WSS just works), e.g. `pi --remote-host your.domain --remote-port 443 --remote-token <token>`; or connect straight to the loopback plain-`ws` server with `pi --remote-insecure --remote-token <token>`. (A plain `--remote-secure false` does not work: pi boolean flags cannot be forced false on the command line, which is why `--remote-insecure` exists.)

---

## Configuration File (`~/.wherever/config.json`)

Wherever supports user configuration to customize defaults for session creation, enable automatic Git remote repository setup, and visually identify each server instance.

The configuration file is located at `~/.wherever/config.json` on the server machine.

### Configuration Properties

- **`gitInitDefault`** (boolean, Default: `false`):
  When creating a session in a non-existent folder, this defines if the **"Initialize Git repository"** option is checked by default in the web UI.

- **`appearance`** (object, optional):
  Per-instance visual identity for the web dashboard, meant to distinguish machines that mirror the same pi sessions (e.g. folders cloned between machines over git): give each machine's server its own `label` and `accent` so you can tell at a glance which instance you are driving.
  - `label` (string or `false`, optional, Default: the machine hostname): Instance name shown next to the logo in the sidebar and appended to the browser tab title. The hostname default already differentiates machines with zero configuration. Set to `""` or `false` to show no label at all (the exact pre-`appearance` look).
  - `accent` (string, optional): Accent color overriding the dashboard's accent tokens (any CSS color, e.g. `"#8b5cf6"`). Re-tints links, buttons, gradients, active-session highlights, and the mobile/PWA `theme-color` chrome.
  - `colors` (object, optional): Advanced, applied on top of `accent`: override individual brand tokens with any CSS color. Keys: `brandDark`, `brandSurface`, `brandSurface2`, `brandSurface3`, `brandBorder`, `brandText`, `brandTextMuted`, `brandCyan`, `brandBlue`, `brandPurple` (see `web/src/app.css` for the compiled-in defaults).
  - `frame` (boolean, optional, Default: enabled when `accent` is set): Draws a solid accent bar across the top edge of the whole dashboard — the most visible instance marker, readable even when the sidebar is collapsed or a session fills the screen. Set `false` to turn it off, or `true` to force it on without an `accent` (it then uses the default blue).
  - `pattern` (string, optional, Default: `'none'`): Backdrop pattern painted on the dashboard's dark background, in the accent tint: `'stripes'` (diagonal), `'dots'`, `'grid'`, or `'none'`. The tint is low-alpha, so it reads as a watermark rather than noise.

- **`commonFolders`** (array of strings, Default: `[]`):
  A list of preset folder paths (e.g. `["~/projects/my-app", "~/dev/github"]`). These folders are displayed as quick-select completion options in the session creation panel, appearing even when the path input is empty.

- **`remoteRepoRules`** (array of rule objects, Default: `[]`):
  A list of rules to automatically create a remote repository (on GitHub, Codeberg, etc.) and configure the git remote whenever a new session folder matches a RegExp pattern.

- **`uploads`** (object, Default: `{ "type": "tmp", "method": "websocket" }`):
  Configuration for local file uploads (images or documents) sent via the remote client:
  - `type` (string, optional, Default: `'tmp'`): Where to store the uploaded files on the server.
    - `'tmp'`: Saves to the operating system's temporary directory (e.g. `/tmp`).
    - `'session'`: Saves inside the active session's workspace directory (`cwd`), under a sub-folder.
    - `'custom'`: Saves to a specified custom directory on the server.
  - `subDir` (string, optional, Default: `'.wherever/uploads'`): The relative directory to use when `type` is set to `'session'`.
  - `dir` (string, optional): The absolute or tilde-expanded (e.g. `~/uploads`) folder path to use when `type` is set to `'custom'`.
  - `method` (string, optional, Default: `'websocket'`): File transport method. Set to `'websocket'` for secure Base64 WebSocket transfer or `'post'` to fallback to HTTP multipart POST.

- **`speech`** (object, optional):
  Configuration for cloud speech-to-text transcription:
  - `apiKey` (string, optional): API Key for the cloud transcription provider. Can also be set via the `SPEECH_API_KEY` environment variable.
  - `apiUrl` (string, optional, Default: `'https://api.z.ai/api/paas/v4/audio/transcriptions'`): The cloud transcription HTTP endpoint. Can also be set via the `SPEECH_API_URL` environment variable.
  - `model` (string, optional, Default: `'glm-asr-2512'`): Model ID for transcription (e.g., Whisper models). Can also be set via the `SPEECH_MODEL` environment variable.

- **`sessions`** (object, optional):
  Controls which sessions appear in the dashboard's session list.
  - `ignore` (array of glob strings, Default: `[]`): Session working directories matching any of these globs are fully excluded from the list. Crucially, a matching folder is skipped **before** its session files are read, so a large pile of throwaway sessions (e.g. agent scratch dirs under `/tmp`) no longer slows down the session list. Globs support `*` (does not cross a path separator), `**` (crosses separators), and `?`; `~` is expanded to the home directory. A pattern ignores both the directory itself and everything nested under it (so `"/tmp"`, `"/tmp/*"`, and `"/tmp/**"` all ignore `/tmp` and everything inside it). Omitting `ignore` (or leaving it empty) changes nothing.
  - `readOnly` (array of glob strings, Default: `[]`): Same glob syntax as `ignore`. Sessions whose working directory matches are **hidden from the main session list** (and, like `ignore`, their folders are skipped before their bodies are read on the main view, so they do not slow it down), but remain viewable on a separate **Read-only sessions** page reached via a link in the sidebar. Opening one is forced read-only: the server refuses messages and the dashboard hides the composer, so it is an observe-only view. This is intended for autonomous agent fleets (e.g. `agent-runner` working directories) that you want to watch but not drive from the dashboard.
  - `maxAgeDays` (number, Default: unset = no limit): Session files not modified within the last N days are left out of the session list. They are decided on the file's modification time **before** the file is read, so an excluded session costs a `stat` and nothing else. Nothing is deleted, and an excluded session is still openable by path or by short ID (a deep link keeps working); it simply does not appear in the list.
  - `maxSessions` (number, Default: unset = no limit): Keep at most the N most recently modified session files in the list, with the same before-any-read behaviour as `maxAgeDays`. Use either or both.

  On a sessions directory that has been accumulating for months (the author's is 2.0 GB / ~3,800 transcripts), these two are the difference between every cold listing pass touching the whole archive and it touching only what you still use. The server prints a one-line hint at startup when it lists more than 1,000 sessions with neither limit set.

### Rule Object Properties

Each rule in `remoteRepoRules` can contain:

- `pattern` (string, required): A regular expression matched against the absolute resolved path of the folder. A leading `~` in the pattern is expanded to the home directory before matching (so `~/dev/github/me/.*` works the same way it does in `commonFolders`), since the path it is matched against is already tilde-expanded and absolute.
- `provider` (string, required): The git hosting provider (`'github'`, `'codeberg'`, `'gitea'`, or `'forgejo'`).
- `visibility` (string, optional, Default: `'private'`): Visibility of the repository on the remote host (`'private'` or `'public'`).

### Example Configuration

```json
{
  "gitInitDefault": true,
  "appearance": {
    "label": "laptop-ahead",
    "accent": "#8b5cf6"
  },
  "commonFolders": ["~/projects/my-app", "~/dev/github"],
  "remoteRepoRules": [
    {
      "pattern": ".*/projects/github/.*",
      "provider": "github",
      "visibility": "private"
    },
    {
      "pattern": ".*/projects/codeberg/.*",
      "provider": "codeberg",
      "visibility": "private"
    }
  ],
  "uploads": {
    "type": "session",
    "subDir": ".wherever/uploads",
    "method": "websocket"
  },
  "speech": {
    "apiKey": "your-cloud-speech-api-key",
    "apiUrl": "https://api.z.ai/api/paas/v4/audio/transcriptions",
    "model": "glm-asr-2512"
  },
  "sessions": {
    "ignore": ["/tmp/**"],
    "readOnly": ["~/.agent-runner/**"],
    "maxAgeDays": 120
  }
}
```

### Auto-Remote Repository Creation Mechanics

When a new session folder is created and matches a rule:

1. If the folder is not already a Git repository, the server automatically initializes it (`git init`).
2. The server executes your configured provider's CLI client locally to create the repository remotely:
   - For **GitHub**, it runs `gh repo create "<repo-name>" --private --source=. --remote=origin` (this requires `gh` CLI to be installed and authenticated).
   - For **Codeberg/Gitea/Forgejo**, it executes `tea repo create --name "<repo-name>" --private` or `cb repo create --name "<repo-name>" --private` (requires `tea` or `cb` CLI tools, automatically adding the corresponding remote URL under `origin`).
3. This sets up the local repo to point directly to your remote origin, allowing your Wherever agent to push directly when asked!

#### Cloning an Existing Remote Instead of Creating One

If the remote repository the rule would create **already exists** (for example, you are continuing a project on a new machine and have not cloned it yet), Wherever detects this at session-creation time instead of silently failing to wire up `origin`. When you create a session in a **non-existing** folder that matches a rule and the "Create remote repository" option is left on:

1. At submit time (not on every keystroke), the server probes the provider using the same authenticated CLI and owner it would use to create the repo (`gh repo view "<repo-name>"` for GitHub, or the `tea`/`cb` listing for Codeberg/Gitea/Forgejo).
2. If the repository is **not** found, nothing changes: the folder is created and the normal auto-create flow above runs (`git init` + `gh repo create` / `tea`/`cb repo create`).
3. If the repository **is** found, the dashboard asks whether you want to **clone it** (preferring the SSH remote) or create a new one anyway. Choosing to clone runs `git clone <ssh-url> <folder>` into the target folder (its parent is created if needed, and the leaf must be empty), then pre-configures upstream tracking. Any probe/CLI failure (missing CLI, not authenticated, offline) is treated as "does not exist", so it always falls back to the normal create path.

---

## Remote Access & Security (Tailscale, Headscale, & Outside Access)

By default, the Standalone Server binds to `127.0.0.1` (localhost) for security. If you want to access your Wherever instance from outside or from other devices (like a mobile phone or tablet), you have a few options:

### 1. Tailscale / Headscale (Highly Recommended)

Using a secure private mesh VPN like [Tailscale](https://tailscale.com) or [Headscale](https://github.com/juanfont/headscale) is the safest and easiest way to access your Wherever server without exposing ports to the public internet.

1. Install Tailscale/Headscale on both your machine and your remote client device (e.g., your phone).
2. Start the Wherever server binding to all interfaces (or your specific Tailscale IP):
   ```bash
   wherever start --host 0.0.0.0 --token your-secure-token
   ```
   _Warning: Always use a strong `--token` when binding to any interface other than localhost!_
3. Access your Svelte dashboard securely from your remote device's browser at `https://<your-tailscale-ip>:31415/#token=your-secure-token`. The token in the fragment is adopted on first load and then cleared from the address bar, so the phone never needs it typed in by hand (see [Handing the token to a browser](#handing-the-token-to-a-browser-one-link-no-typing)).

#### Trusted HTTPS for Tailscale (recommended for PWA install)

The server's auto-generated certificate is **self-signed** (issued for `CN=localhost`). Browsers will load the dashboard after you click past the warning, but they do **not** treat a self-signed origin as a _secure context_. As a result:

- **Installing the dashboard as a PWA** (Add to Home Screen) will not launch in its own standalone window: it opens in a normal browser tab instead.
- Chrome's _Application → Manifest_ panel reports `Page is not served from a secure origin`, and Lighthouse shows no PWA category.

To get a genuinely trusted origin (and a working standalone PWA), use Tailscale's built-in HTTPS to issue a real Let's Encrypt certificate for your MagicDNS name. This requires **HTTPS** and **MagicDNS** to be enabled for your tailnet (see the Tailscale admin console → DNS).

Replace `your-machine.your-tailnet.ts.net` below with your device's MagicDNS name (`tailscale status` shows it).

**Method A — explicit flags:**

```bash
# Issue a cert for your MagicDNS name (writes <name>.crt and <name>.key)
tailscale cert your-machine.your-tailnet.ts.net

wherever start --host 0.0.0.0 --token your-secure-token \
  --ssl-cert your-machine.your-tailnet.ts.net.crt \
  --ssl-key  your-machine.your-tailnet.ts.net.key
```

**Method B — drop-in (no flags needed):**

The server auto-loads `~/.wherever/certs/localhost.crt` + `~/.wherever/certs/localhost.key` when present, and only generates a self-signed pair if they are **missing**. So you can write the Tailscale cert directly to those paths and the server will pick it up automatically on the next start:

```bash
tailscale cert \
  --cert-file ~/.wherever/certs/localhost.crt \
  --key-file  ~/.wherever/certs/localhost.key \
  your-machine.your-tailnet.ts.net

wherever start --host 0.0.0.0 --token your-secure-token
```

_(The filenames stay `localhost.*` but contain a cert for your MagicDNS name; the server only cares about the path, not the name.)_

Then open `https://your-machine.your-tailnet.ts.net:31415` (the **name**, not the IP — the cert is bound to the name). The origin is now trusted, so the PWA installs and launches standalone.

> **Renewal:** `tailscale cert` certificates are short-lived (Let's Encrypt, ~90 days). The server reads the certificate files only at startup, so to renew, re-run the `tailscale cert` command (overwriting the files) and restart `wherever`.
>
> **DNS note:** all devices (including the server host itself) must be able to resolve the MagicDNS name. If `getent hosts your-machine.your-tailnet.ts.net` fails on the server while `nslookup your-machine.your-tailnet.ts.net 100.100.100.100` succeeds, your system DNS is bypassing Tailscale's MagicDNS resolver (commonly a NetworkManager / `systemd-resolved` `/etc/resolv.conf` conflict). See [tailscale.com/s/dns-fight](https://tailscale.com/s/dns-fight).

#### Trusted HTTPS for Tunnet

The same idea works on a [Tunnet](https://tunnet.io) mesh, with one difference: there is no `tunnet cert`, so the certificate comes from an ACME client you run yourself. Because a mesh address is not reachable from the internet, issuance must use the **DNS-01** challenge rather than HTTP-01.

You point a public DNS record at the machine's private mesh address, which is safe to publish and stable, since Tunnet derives it from the node's own public key rather than leasing it.

Two shapes are covered in [Deploying over a Tunnet mesh with real HTTPS](docs/deployment-tunnet-https.md): issuing a certificate and dropping it into `~/.wherever/certs/` exactly as above, or putting Caddy in front so you get `https://wherever.your-domain` per service and renewal without restarts.

### 2. Local Network Access

To allow access from devices on your local home network (Wi-Fi):

1. Start the server binding to `0.0.0.0`:
   ```bash
   wherever start --host 0.0.0.0 --token your-secure-token
   ```
2. Find your Pi's local network IP (e.g., `192.168.1.50`) and open `https://192.168.1.50:31415` in your client's browser.
3. If running the CLI `pi` command from another computer on the same local network, point it to the Pi:
   ```bash
   pi --remote-host 192.168.1.50 --remote-token your-secure-token
   ```

### 3. SSH Port Forwarding

For an ad-hoc secure connection without exposing any port:

```bash
ssh -L 31415:localhost:31415 user@your-pi-ip
```

Once connected, you can open `https://localhost:31415` locally on your client computer.

---

## Debugging

The dashboard ships with [eruda](https://github.com/liriliri/eruda) for debugging on devices where you don't have devtools (e.g. your phone). Append `?eruda` to the dashboard URL to load the eruda console:

```
https://your-host:31415/?eruda
```

Loading **custom eruda plugins** via `?eruda=<plugin-package>` is disabled by default, because that parameter is interpolated into a `<script src>` and would otherwise be a DOM-XSS vector on a deployed instance. To enable it, run the server with `--debug` (local only):

```
wherever start --debug
```

Then `?eruda=eruda-dom,eruda-code` loads those plugins from the jsdelivr CDN. Never run `--debug` on an exposed/host network deployment.

---

## License

AGPL-3.0-only
