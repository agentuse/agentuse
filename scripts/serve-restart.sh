#!/usr/bin/env bash
#
# Restart the pm2-managed `agentuse serve` daemon without killing in-flight agents.
#
# `pm2 restart` signals the daemon, and the daemon's own shutdown gives in-flight
# work only an 8s drain window (SHUTDOWN_DRAIN_MS in src/cli/serve.ts) before it
# SIGTERMs its worker children. Any agent still running past that window dies
# mid-run. So the only reliable way to restart without losing work is to wait for
# the daemon to go idle first -- which is what this does.
#
#   scripts/serve-restart.sh                 # wait for idle (up to 30m), then restart
#   scripts/serve-restart.sh --build         # pnpm build first, then wait, then restart
#   scripts/serve-restart.sh --timeout 300   # give up waiting after 5m
#   scripts/serve-restart.sh --force         # restart now, killing whatever is running
#
set -euo pipefail

PM2_NAME="${AGENTUSE_PM2_NAME:-agentuse}"
TIMEOUT=1800
POLL=10
FORCE=0
BUILD=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --build) BUILD=1; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --poll) POLL="$2"; shift 2 ;;
    --name) PM2_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Resolve the daemon's address from its own registry rather than assuming a port.
base_url() {
  agentuse serve ps --json 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not d:
    sys.exit(1)
s = d[0]
print("http://%s:%s" % (s.get("host") or "127.0.0.1", s["port"]))
'
}

# window=all so a long run started more than 24h ago (the default window) is not
# silently missed. The cost is that it also returns sessions stuck at 'running'
# from past hard kills, which reconcileOrphanedSessions only sweeps back 30 days
# -- so anything older than that lingers forever and would keep us from ever
# seeing idle. describe_running filters those out by heartbeat instead.
running_json() {
  curl -sf --max-time 10 "$1/api/sessions?status=running&window=all" 2>/dev/null
}

# A genuinely live run writes a part per model step, bumping updatedAt. Treat a
# 'running' session that has not been touched in STALE_MIN minutes as a corpse,
# not something worth waiting on.
STALE_MIN="${AGENTUSE_STALE_MIN:-30}"

describe_running() {
  STALE_MIN="$STALE_MIN" python3 -c '
import json, os, sys, time
d = json.load(sys.stdin)
cutoff = (time.time() - int(os.environ["STALE_MIN"]) * 60) * 1000
live, stale = [], 0
for s in d.get("sessions", []):
    if (s.get("updatedAt") or s.get("createdAt") or 0) >= cutoff:
        live.append(s)
    else:
        stale += 1
print(len(live))
for s in live[:10]:
    print("  - %s / %s (%s)" % (s.get("project"), (s.get("agent") or {}).get("name"), s.get("sessionId")), file=sys.stderr)
if len(live) > 10:
    print("  ... and %d more" % (len(live) - 10), file=sys.stderr)
if stale:
    print("  (ignoring %d session(s) stuck at running with no heartbeat)" % stale, file=sys.stderr)
'
}

if [ "$BUILD" = 1 ]; then
  echo "==> Building $REPO_ROOT"
  (cd "$REPO_ROOT" && pnpm run build)
fi

URL="$(base_url || true)"
if [ -z "$URL" ]; then
  echo "==> No serve daemon registered; restarting $PM2_NAME blind."
  pm2 restart "$PM2_NAME"
  exit 0
fi
echo "==> Daemon at $URL"

if [ "$FORCE" = 1 ]; then
  echo "==> --force: restarting now, in-flight agents will be killed."
else
  deadline=$(( $(date +%s) + TIMEOUT ))
  while :; do
    body="$(running_json "$URL" || true)"
    if [ -z "$body" ]; then
      echo "==> Daemon not answering; restarting."
      break
    fi
    n="$(printf '%s' "$body" | describe_running)"
    if [ "$n" = "0" ]; then
      echo "==> Idle. Restarting."
      break
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      echo "==> Still $n agent(s) running after ${TIMEOUT}s. Not restarting." >&2
      echo "    Re-run with --force to restart anyway, or --timeout N to wait longer." >&2
      exit 1
    fi
    echo "==> $n agent(s) running; waiting $((deadline - now))s more..."
    sleep "$POLL"
  done
fi

pm2 restart "$PM2_NAME"
# The daemon indexes projects before it registers, so give it a beat to show up.
sleep 12
agentuse serve ps
