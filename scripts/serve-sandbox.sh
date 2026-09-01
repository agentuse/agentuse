#!/usr/bin/env bash
#
# serve-sandbox.sh — run an isolated `agentuse serve` alongside the live daemon.
#
# Why this exists: only ONE serve can hold the Slack Socket Mode connection for a
# given Slack app (Slack load-balances events across every open socket, so a second
# serve on the same app token would silently steal a share of live approvals). This
# script spins up an isolated test daemon while deliberately reusing provider
# credentials and the user-global secret env file, so serve/web/approval changes
# cannot mutate production config, sessions, schedules, or server registration.
#
# What is shared vs isolated:
#   shared    providers/logins  -> the source profile's auth.json is symlinked into
#                                  the isolated data directory
#   isolated  global config     -> {state}/config via AGENTUSE_CONFIG_DIR
#   shared    secrets/.env      -> the source profile's .env is symlinked into the
#                                  isolated config dir; empty SLACK_* vars below still win
#   isolated  sessions/state    -> AGENTUSE_DATA_DIR points at a throwaway dir under $TMPDIR
#                                  (never inside the repo: see the STATE_DIR note below)
#   isolated  server registry   -> {AGENTUSE_DATA_DIR}/servers, so `serve list` stays separate
#   isolated  port              -> defaults to 12999, not the live 12233
#   DISABLED  Slack socket      -> SLACK_APP_TOKEN/SLACK_BOT_TOKEN exported empty (default)
#   DISABLED  real schedules    -> -C defaults to an empty scratch dir, overriding
#                                  config.serve.projects, so the always-on scheduler
#                                  arms ZERO real cron jobs (no double-sends). Pass -C
#                                  explicitly to load real agents (their schedules arm).
#
# Usage:
#   scripts/serve-sandbox.sh [-p PORT] [-C AGENT_DIR] [--state DIR] [--slack-env FILE] [-- extra serve args]
#
#   -p, --port PORT        Port to listen on (default: 12999)
#   -C, --dir AGENT_DIR    Serve agent files from this dir (passed through as serve -C)
#       --state DIR        Isolated state dir (default: $TMPDIR/agentuse-serve-sandbox/<port>;
#                          keep it outside the repo, see the STATE_DIR note in the body)
#       --slack-env FILE   Opt INTO a second/dev Slack app: read SLACK_APP_TOKEN and
#                          SLACK_BOT_TOKEN from this dotenv-style file so the sandbox
#                          opens its OWN socket. Use a DIFFERENT Slack app than prod;
#                          two sockets on the same app collide. Omit to keep Slack off.
#   -h, --help             Show this help.
#
# Anything after `--` is passed straight to `agentuse serve`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT=12999
AGENT_DIR=""
STATE_DIR=""
SLACK_ENV=""
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)       PORT="$2"; shift 2 ;;
    -C|--dir)        AGENT_DIR="$2"; shift 2 ;;
    --state)         STATE_DIR="$2"; shift 2 ;;
    --slack-env)     SLACK_ENV="$2"; shift 2 ;;
    -h|--help)       sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --)              shift; PASSTHROUGH=("$@"); break ;;
    *)               echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Keep sandbox state OUTSIDE the repo tree. `bun test` opens a directory handle for
# every directory under the package root, and a sandbox that has run for a while grows
# thousands of session dirs; past ~10k open fds the runner can no longer give spawned
# children usable stdio (esbuild's service dies, plugin tests fail). Parking state in
# the repo therefore breaks the test suite as a side effect of local serve testing.
STATE_DIR="${STATE_DIR:-${TMPDIR:-/tmp}/agentuse-serve-sandbox/$PORT}"
mkdir -p "$STATE_DIR"

# Safety: the scheduler ALWAYS runs and serve has no disable flag. If the sandbox
# inherits config.serve.projects it arms EVERY real cron job and fires real agents in
# parallel with the live daemon (double-sends of emails, CS tickets, etc.). So default
# -C to an EMPTY scratch dir, which overrides config.serve.projects -> zero real
# projects, zero schedules. Drop test .agentuse files in here, or POST /run by path.
SCHED_REAL=""
if [[ -z "$AGENT_DIR" ]]; then
  AGENT_DIR="$STATE_DIR/agents"
  mkdir -p "$AGENT_DIR"
else
  SCHED_REAL="yes"
fi

# Default: Slack socket OFF. Empty + present in env beats ~/.agentuse/.env because
# loadGlobalEnv() loads with override:false (skips keys already in process.env).
export SLACK_APP_TOKEN=""
export SLACK_BOT_TOKEN=""

# Opt into a dev Slack app: pull the two tokens from the given file and export them
# non-empty, so they win over the global .env and the sandbox opens its own socket.
if [[ -n "$SLACK_ENV" ]]; then
  if [[ ! -f "$SLACK_ENV" ]]; then
    echo "slack-env file not found: $SLACK_ENV" >&2; exit 1
  fi
  read_var() {
    # grab VALUE from `KEY=VALUE` (last match), strip optional surrounding quotes
    grep -E "^[[:space:]]*$1[[:space:]]*=" "$SLACK_ENV" | tail -n1 \
      | sed -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//; s/^['\"]//; s/['\"][[:space:]]*$//"
  }
  SLACK_APP_TOKEN="$(read_var SLACK_APP_TOKEN)"
  SLACK_BOT_TOKEN="$(read_var SLACK_BOT_TOKEN)"
  export SLACK_APP_TOKEN SLACK_BOT_TOKEN
  if [[ -z "$SLACK_APP_TOKEN" || -z "$SLACK_BOT_TOKEN" ]]; then
    echo "warning: --slack-env did not yield both SLACK_APP_TOKEN and SLACK_BOT_TOKEN; socket stays off" >&2
  fi
fi

SOURCE_CONFIG_DIR="${AGENTUSE_CONFIG_DIR:-$HOME/.agentuse}"
SOURCE_ENV_FILE="${AGENTUSE_ENV:-$SOURCE_CONFIG_DIR/.env}"
if [[ -n "${AGENTUSE_DATA_DIR:-}" ]]; then
  SOURCE_DATA_DIR="$AGENTUSE_DATA_DIR"
elif [[ -n "${XDG_DATA_HOME:-}" ]]; then
  SOURCE_DATA_DIR="$XDG_DATA_HOME/agentuse"
else
  SOURCE_DATA_DIR="$HOME/.local/share/agentuse"
fi
SOURCE_AUTH_FILE="$SOURCE_DATA_DIR/auth.json"

export AGENTUSE_CONFIG_DIR="$STATE_DIR/config"
export AGENTUSE_DATA_DIR="$STATE_DIR/data"
# Legacy file overrides take precedence in the CLI, so remove inherited values
# after preserving the source env path above. Otherwise they defeat isolation.
unset AGENTUSE_CONFIG AGENTUSE_ENV
unset XDG_DATA_HOME
mkdir -p "$AGENTUSE_CONFIG_DIR" "$AGENTUSE_DATA_DIR"

# Keep mutable config isolated while intentionally reusing the user's secret
# environment file. A caller-provided test .env takes precedence over this link.
if [[ ! -e "$AGENTUSE_CONFIG_DIR/.env" && -f "$SOURCE_ENV_FILE" ]]; then
  ln -s "$SOURCE_ENV_FILE" "$AGENTUSE_CONFIG_DIR/.env"
fi

# Provider logins are intentionally shared. Everything else in the data
# profile—sessions, schedules, logs, push state, and registry entries—stays local.
if [[ ! -e "$AGENTUSE_DATA_DIR/auth.json" && -f "$SOURCE_AUTH_FILE" ]]; then
  ln -s "$SOURCE_AUTH_FILE" "$AGENTUSE_DATA_DIR/auth.json"
fi

# Web UI is a separately-built SPA served from dist/web. Warn (do not fail) if absent.
if [[ ! -f "$ROOT/dist/web/manifest.json" ]]; then
  echo "note: dist/web/manifest.json missing — the web UI will show the assets-missing page." >&2
  echo "      run 'bun run build:web' (one-off) or 'bun run watch:web' (live) in another shell." >&2
fi

echo "sandbox serve:"
echo "  port        $PORT"
echo "  data dir    $AGENTUSE_DATA_DIR"
echo "  config dir  $AGENTUSE_CONFIG_DIR"
echo "  slack       $([[ -n "$SLACK_APP_TOKEN" && -n "$SLACK_BOT_TOKEN" ]] && echo "dev app ($SLACK_ENV)" || echo "OFF (live daemon keeps the socket)")"
if [[ -n "$SCHED_REAL" ]]; then
  echo "  agent dir   $AGENT_DIR"
  echo "  WARNING     -C points at real agents: their cron schedules WILL arm and fire"
  echo "              autonomously, in parallel with the live daemon. Use a copy with"
  echo "              schedule frontmatter removed if you don't want duplicate runs."
else
  echo "  agent dir   $AGENT_DIR (empty scratch: no real projects, no schedules)"
fi
echo

SERVE_ARGS=(-p "$PORT" -C "$AGENT_DIR")
SERVE_ARGS+=("${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}")

cd "$ROOT"
exec bun --watch src/index.ts serve "${SERVE_ARGS[@]}"
