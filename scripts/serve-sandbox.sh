#!/usr/bin/env bash
#
# serve-sandbox.sh — run an isolated `agentuse serve` alongside the live daemon.
#
# Why this exists: only ONE serve can hold the Slack Socket Mode connection for a
# given Slack app (Slack load-balances events across every open socket, so a second
# serve on the same app token would silently steal a share of live approvals). This
# script spins up a fully isolated test daemon that shares everything EXCEPT the
# Slack socket, so you can test serve/web/approval changes without touching prod.
#
# What is shared vs isolated:
#   shared    providers/logins  -> auth.json is hardcoded at ~/.local/share/agentuse
#                                  (ignores XDG_DATA_HOME), so logins are reused as-is
#   shared    global config     -> ~/.agentuse/config.json (AGENTUSE_CONFIG not overridden)
#   shared    secrets/.env      -> ~/.agentuse/.env, loaded with override:false so the
#                                  empty SLACK_* vars below win but everything else flows in
#   isolated  sessions/state    -> XDG_DATA_HOME points at a throwaway dir under tmp/
#   isolated  server registry   -> {XDG_DATA_HOME}/agentuse/servers, so `serve list` stays separate
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
#       --state DIR        Isolated state dir (default: <repo>/tmp/serve-sandbox/<port>)
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
    -h|--help)       sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --)              shift; PASSTHROUGH=("$@"); break ;;
    *)               echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

STATE_DIR="${STATE_DIR:-$ROOT/tmp/serve-sandbox/$PORT}"
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

export XDG_DATA_HOME="$STATE_DIR"

# Web UI is a separately-built SPA served from dist/web. Warn (do not fail) if absent.
if [[ ! -f "$ROOT/dist/web/manifest.json" ]]; then
  echo "note: dist/web/manifest.json missing — the web UI will show the assets-missing page." >&2
  echo "      run 'bun run build:web' (one-off) or 'bun run watch:web' (live) in another shell." >&2
fi

echo "sandbox serve:"
echo "  port        $PORT"
echo "  state dir   $XDG_DATA_HOME"
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
