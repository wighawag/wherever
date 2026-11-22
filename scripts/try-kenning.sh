#!/usr/bin/env bash
# Try the kenning integration on a SECOND wherever, fully isolated from the one
# you use every day (its config, state, pi agent dir, sessions, kenning database
# and assistant folder all live under $ROOT), before releasing it.
#
#   scripts/try-kenning.sh setup    build this checkout and prepare $ROOT
#   scripts/try-kenning.sh start    start the test server (background)
#   scripts/try-kenning.sh pi       a terminal pi bridged to the test server
#   scripts/try-kenning.sh status   is it up, and where to open it
#   scripts/try-kenning.sh stop     stop the test server (its whole process group)
#   scripts/try-kenning.sh clean    stop, then delete $ROOT (asks first)
#
# Settings (environment):
#   ROOT                 default ~/wherever-test
#   PORT                 default 31416 (production runs on 31415)
#   TELEGRAM_TOKEN_FILE  file holding a SECOND bot's token (@BotFather). Never
#                        your production bot's: two servers polling one bot
#                        steal each other's updates (Telegram answers 409).
#                        Unset: Telegram stays off in the test.
#   PUBLIC_URL           https URL that reaches 127.0.0.1:$PORT (a second tunnel
#                        hostname). Needed for push on a phone; desktop Chrome
#                        on http://localhost:$PORT works without it.
#   AUTH=1               require a token (generated into $ROOT/token). Use it
#                        whenever PUBLIC_URL exposes the test server.
#
# Run it from your own terminal or ssh session, NOT from inside a wherever
# session: a process started there is charged to the production wherever
# unit's memory limit.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${ROOT:-$HOME/wherever-test}"
PORT="${PORT:-31416}"
REAL_AGENT_DIR="${REAL_AGENT_DIR:-$HOME/.pi/agent}"
KENNING_PI="npm:kenning-pi@0.1.0"

die() { echo "try-kenning: $*" >&2; exit 1; }
note() { echo "try-kenning: $*"; }

# Everything the test server and the test terminal pi see. The PI_REMOTE_*,
# WHEREVER_TOKEN* and Telegram variables are cleared first: a shell started
# from a wherever session inherits production's.
test_env() {
  local -a env=(
    env -u PI_REMOTE_TOKEN -u PI_REMOTE_HOST -u PI_REMOTE_PORT -u PI_REMOTE_SSL_KEY -u PI_REMOTE_SSL_CERT
    -u WHEREVER_TOKEN -u WHEREVER_TOKEN_FILE -u WHEREVER_TELEGRAM_TOKEN -u WHEREVER_TELEGRAM_TOKEN_FILE
    WHEREVER_CONFIG_DIR="$ROOT/config"
    WHEREVER_STATE_DIR="$ROOT/state"
    PI_CODING_AGENT_DIR="$ROOT/agent"
    KENNING_STATE_DIR="$ROOT/kenning"
  )
  [[ -f "$ROOT/token" ]] && env+=(WHEREVER_TOKEN_FILE="$ROOT/token")
  [[ -n "${TELEGRAM_TOKEN_FILE:-}" ]] && env+=(WHEREVER_TELEGRAM_TOKEN_FILE="$TELEGRAM_TOKEN_FILE")
  printf '%s\0' "${env[@]}"
}

run_in_test_env() {
  local -a env=()
  while IFS= read -r -d '' x; do env+=("$x"); done < <(test_env)
  "${env[@]}" "$@"
}

port_in_use() { timeout 5 ss -ltn "sport = :$PORT" | tail -n +2 | grep -q .; }

server_pgid() { [[ -f "$ROOT/server.pgid" ]] && cat "$ROOT/server.pgid"; }

running() {
  local pgid
  pgid="$(server_pgid)" || return 1
  [[ -n "$pgid" ]] && kill -0 -- "-$pgid" 2>/dev/null
}

warn_if_inside_wherever() {
  if grep -q 'wherever.service' /proc/self/cgroup 2>/dev/null; then
    note "WARNING: this shell runs inside wherever.service; the test server would count against its memory limit."
    note "         Prefer your own terminal or ssh session."
  fi
}

cmd_setup() {
  command -v pi >/dev/null || die "pi is not on PATH"
  command -v node >/dev/null || die "node is not on PATH"
  [[ -f "$REAL_AGENT_DIR/auth.json" ]] || die "no $REAL_AGENT_DIR/auth.json to copy model credentials from"
  if [[ -n "${TELEGRAM_TOKEN_FILE:-}" ]]; then
    [[ -s "$TELEGRAM_TOKEN_FILE" ]] || die "TELEGRAM_TOKEN_FILE=$TELEGRAM_TOKEN_FILE is missing or empty"
  fi
  mkdir -p "$ROOT"/{config,state,agent,kenning,assistant} "$ROOT"/work/{lead,docs,orchestrator,lanes,terminal}
  chmod 700 "$ROOT"

  note "building this checkout ($(git -C "$REPO" rev-parse --short HEAD)) with nix"
  timeout 3600 nix build "git+file:$REPO#default" --out-link "$ROOT/result"

  # The terminal pi loads the bridge from this checkout, not the npm release.
  if [[ ! -f "$REPO/extension/dist/index.js" ]]; then
    note "building extension/"
    (cd "$REPO" && timeout 600 pnpm --filter ./extension build)
  fi

  # Model credentials and models, copied (the test never writes to your real agent dir).
  install -m 600 "$REAL_AGENT_DIR/auth.json" "$ROOT/agent/auth.json"
  [[ -f "$REAL_AGENT_DIR/models.json" ]] && install -m 600 "$REAL_AGENT_DIR/models.json" "$ROOT/agent/models.json"

  # Your pi settings, minus every package (they would be installed again into the
  # test agent dir) and with this checkout's bridge instead of the npm one.
  REAL="$REAL_AGENT_DIR/settings.json" OUT="$ROOT/agent/settings.json" EXT="$REPO/extension" node -e '
    const fs = require("fs");
    let s = {};
    try { s = JSON.parse(fs.readFileSync(process.env.REAL, "utf8")); } catch {}
    s.packages = [];
    s.extensions = [...(s.extensions || []).filter((e) => typeof e === "string" && e.startsWith("-")), process.env.EXT];
    fs.writeFileSync(process.env.OUT, JSON.stringify(s, null, 2));
  '

  if [[ "${AUTH:-}" == "1" && ! -f "$ROOT/token" ]]; then
    (umask 077 && node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))' > "$ROOT/token")
  fi

  # The test server's config. `remote` is also what the bridge in the test
  # terminal pi reads (WHEREVER_CONFIG_DIR), so it finds this server.
  OUT="$ROOT/config/config.json" PORT="$PORT" ASSISTANT="$ROOT/assistant" PUBLIC_URL="${PUBLIC_URL:-}" \
  TELEGRAM="${TELEGRAM_TOKEN_FILE:+1}" TOKEN_FILE="$ROOT/token" node -e '
    const fs = require("fs");
    const e = process.env;
    const c = {
      remote: { host: "127.0.0.1", port: Number(e.PORT), insecure: true },
      assistantFolder: e.ASSISTANT,
      assistantTelegram: { enabled: e.TELEGRAM === "1" },
    };
    if (fs.existsSync(e.TOKEN_FILE)) c.remote.token = fs.readFileSync(e.TOKEN_FILE, "utf8").trim();
    if (e.PUBLIC_URL) c.publicUrl = e.PUBLIC_URL;
    fs.writeFileSync(e.OUT, JSON.stringify(c, null, 2), { mode: 0o600 });
  '

  note "installing $KENNING_PI into the test agent dir"
  run_in_test_env timeout 600 pi install "$KENNING_PI"

  note "ready. Next: scripts/try-kenning.sh start"
}

cmd_start() {
  [[ -x "$ROOT/result/bin/wherever" ]] || die "not set up: run scripts/try-kenning.sh setup"
  running && die "already running (process group $(server_pgid))"
  port_in_use && die "port $PORT is in use (ss -ltn); pick another with PORT=..."
  warn_if_inside_wherever
  # Its own session (setsid), so stop can signal the server and everything it
  # spawned as one process group.
  run_in_test_env setsid "$ROOT/result/bin/wherever" start --host 127.0.0.1 --port "$PORT" --http \
    > "$ROOT/server.log" 2>&1 < /dev/null &
  echo $! > "$ROOT/server.pgid"
  for _ in $(seq 1 60); do
    if timeout 2 curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      cmd_status
      return
    fi
    running || { tail -n 30 "$ROOT/server.log" >&2; die "the server exited (log above, $ROOT/server.log)"; }
    sleep 0.5
  done
  die "no /health after 30 s; see $ROOT/server.log"
}

cmd_pi() {
  [[ -f "$ROOT/agent/settings.json" ]] || die "not set up: run scripts/try-kenning.sh setup"
  running || note "WARNING: the test server is not running; the bridge will keep retrying"
  cd "$ROOT/work/terminal"
  local -a env=()
  while IFS= read -r -d '' x; do env+=("$x"); done < <(test_env)
  exec "${env[@]}" pi "$@"
}

cmd_status() {
  if running && timeout 2 curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    local frag=""
    [[ -f "$ROOT/token" ]] && frag="#token=$(cat "$ROOT/token")"
    note "running (process group $(server_pgid)), log $ROOT/server.log"
    note "open  http://localhost:$PORT/$frag"
    [[ -n "${PUBLIC_URL:-}" ]] && note "phone ${PUBLIC_URL%/}/$frag"
    note "work folders for sessions: $ROOT/work/{lead,docs,orchestrator,lanes}"
    note "Telegram: $([[ -n "${TELEGRAM_TOKEN_FILE:-}" ]] && echo 'on (pair from Settings: send /pair <code> to the TEST bot)' || echo 'off (set TELEGRAM_TOKEN_FILE and re-run setup)')"
  else
    note "not running"
  fi
}

cmd_stop() {
  local pgid
  pgid="$(server_pgid)" || { note "not running"; return; }
  if kill -0 -- "-$pgid" 2>/dev/null; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 -- "-$pgid" 2>/dev/null || break; sleep 0.5; done
    kill -0 -- "-$pgid" 2>/dev/null && kill -KILL -- "-$pgid" 2>/dev/null || true
    note "stopped (process group $pgid)"
  else
    note "not running"
  fi
  rm -f "$ROOT/server.pgid"
}

cmd_clean() {
  cmd_stop
  [[ -d "$ROOT" ]] || { note "nothing to delete"; return; }
  read -r -p "Delete $ROOT (test sessions, state, kenning database)? [y/N] " yes
  [[ "$yes" == "y" || "$yes" == "Y" ]] || { note "kept $ROOT"; return; }
  rm -rf -- "$ROOT"
  note "deleted $ROOT"
}

case "${1:-}" in
  setup) cmd_setup ;;
  start) cmd_start ;;
  pi) shift; cmd_pi "$@" ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  clean) cmd_clean ;;
  *) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
