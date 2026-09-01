#!/usr/bin/env bash
# Smoke the fresh, provider-free Web onboarding path inside the declared clone sandbox.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT=12233

if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: pnpm sbx:smoke"
  echo "Runs fresh Web onboarding on 0.0.0.0:12233, guarded for the clone-mode Docker Sandbox."
  exit 0
fi

die() { echo "sbx smoke: $*" >&2; exit 1; }

# Clone-mode Docker Sandboxes expose the host source repository here, read-only.
# Requiring both the well-known path and its mount options prevents this dangerous
# no-auth/exposed-host command from being used in an ordinary host or container shell.
[[ -d /run/sandbox/source ]] \
  || die "refusing --host 0.0.0.0 --no-auth outside a clone-mode Docker Sandbox"
command -v findmnt >/dev/null 2>&1 \
  || die "cannot verify the Docker Sandbox source mount (findmnt is missing)"
SOURCE_OPTIONS="$(findmnt -T /run/sandbox/source -n -o OPTIONS 2>/dev/null || true)"
[[ ",$SOURCE_OPTIONS," == *,ro,* ]] \
  || die "refusing no-auth smoke: /run/sandbox/source is not a read-only clone-mode source mount"

[[ -f "$ROOT/dist/index.js" ]] || die "build output is missing; run 'pnpm sbx:bootstrap' first"
command -v curl >/dev/null 2>&1 || die "curl is required for the smoke probe"

SMOKE_HOME="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  [[ -z "$SERVER_PID" ]] || wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$SMOKE_HOME"
}
trap cleanup EXIT INT TERM

mkdir -p "$SMOKE_HOME/config" "$SMOKE_HOME/data"
export HOME="$SMOKE_HOME/home"
export AGENTUSE_CONFIG_DIR="$SMOKE_HOME/config"
export AGENTUSE_DATA_DIR="$SMOKE_HOME/data"
unset XDG_DATA_HOME
mkdir -p "$HOME"

# The smoke contract is provider-free. Codex sandbox authentication belongs to
# the coding agent and must never become AgentUse runtime-provider credentials.
unset ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY AWS_ACCESS_KEY_ID \
  AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_BEARER_TOKEN_BEDROCK

cd "$ROOT"
node bin/cli.js setup --web --host 0.0.0.0 --port "$PORT" --no-auth >"$SMOKE_HOME/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/about" >"$SMOKE_HOME/about.json"; then
    kill -0 "$SERVER_PID" 2>/dev/null || die "server exited after responding; see $SMOKE_HOME/server.log"
    [[ ! -e "$AGENTUSE_CONFIG_DIR/config.json" ]] \
      || grep -Eq '"projects"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' "$AGENTUSE_CONFIG_DIR/config.json" \
      || die "fresh onboarding unexpectedly created a project"
    echo "sbx smoke: PASS — fresh provider-free onboarding is reachable at http://127.0.0.1:$PORT"
    exit 0
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || {
    sed -n '1,160p' "$SMOKE_HOME/server.log" >&2
    die "setup server exited before becoming ready"
  }
  sleep 0.5
done

sed -n '1,160p' "$SMOKE_HOME/server.log" >&2
die "timed out waiting for port $PORT; stop the conflicting process or change/remove the sandbox mapping and recreate it"
