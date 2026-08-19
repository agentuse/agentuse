#!/usr/bin/env bash
#
# Restart the pm2-managed `agentuse serve` daemon once it has gone idle.
#
# This is no longer required to protect in-flight agents -- serve releases busy
# workers on shutdown and they finish out of process (AgentWorker.release in
# src/cli/serve.ts). It is still the tidier way to restart: a released worker
# runs to completion on the OLD build, so when the point of restarting is to pick
# up code you just changed, waiting for idle is what actually gets it applied.
#
#   scripts/serve-restart.sh                 # wait for idle (up to 30m), then restart
#   scripts/serve-restart.sh --build         # pnpm build first, then wait, then restart
#   scripts/serve-restart.sh --timeout 300   # give up waiting after 5m
#   scripts/serve-restart.sh --force         # restart now, killing whatever is running
#   scripts/serve-restart.sh --follow        # keep watching dist/index.js; on each
#                                            # rebuild, wait for idle then restart
#
# --follow is the companion to `pnpm watch`: the watcher rewrites dist/index.js but
# the daemon goes on running whatever it booted with, so without this you are
# testing stale code. It never interrupts a run -- it waits for the daemon to go
# idle, however long that takes, and a rebuild landing during the wait is simply
# picked up by the same restart. Only dist/index.js is watched: web assets are
# re-read from disk on mtime change (WebStatic.manifest), so `watch:web` alone
# needs no restart.
#
set -euo pipefail

PM2_NAME="${AGENTUSE_PM2_NAME:-agentuse}"
TIMEOUT=1800
POLL=10
FORCE=0
BUILD=0
FOLLOW=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --build) BUILD=1; shift ;;
    --follow) FOLLOW=1; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --poll) POLL="$2"; shift 2 ;;
    --name) PM2_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Resolve the daemon's address from the registry entry belonging to the requested
# PM2 process. A machine can run multiple projects/daemons, so selecting the
# oldest registry entry is unsafe (and can restart one daemon after inspecting
# another one's sessions).
base_url() {
  local pm2_pid
  pm2_pid="$(pm2 jlist 2>/dev/null | PM2_NAME="$PM2_NAME" python3 -c '
import json, os, sys
try:
    processes = json.load(sys.stdin)
except Exception:
    sys.exit(1)
matches = [p for p in processes if p.get("name") == os.environ["PM2_NAME"] and p.get("pid", 0) > 0]
if len(matches) != 1:
    sys.exit(1)
print(matches[0]["pid"])
' || true)"
  if [ -z "$pm2_pid" ]; then
    echo "==> Could not resolve exactly one PM2 process named $PM2_NAME; not restarting." >&2
    return 1
  fi

  agentuse serve ps --json 2>/dev/null | PM2_PID="$pm2_pid" python3 -c '
import json, os, sys
try:
    entries = json.load(sys.stdin)
except Exception:
    sys.exit(1)
matches = [s for s in entries if str(s.get("pid")) == os.environ["PM2_PID"]]
if len(matches) != 1:
    sys.exit(1)
s = matches[0]
print("http://%s:%s" % (s.get("host") or "127.0.0.1", s["port"]))
' || {
    echo "==> No unique serve registry entry belongs to PM2 process $pm2_pid; not restarting." >&2
    return 1
  }
}

# window=all so a long run started more than 24h ago (the default window) is not
# silently missed. The cost is that it also returns sessions stuck at 'running'
# from past hard kills, which reconcileOrphanedSessions only sweeps back 30 days
# -- so anything older than that lingers forever and would keep us from ever
# seeing idle. describe_running filters those out by heartbeat instead.
running_json() {
  local auth=()
  if [ -n "${AGENTUSE_API_KEY:-}" ]; then
    auth=(-H "Authorization: Bearer ${AGENTUSE_API_KEY}")
  fi
  # Preserve the HTTP status so authentication failures and transport failures
  # cannot be mistaken for an empty response (which would trigger a restart).
  curl -sS --max-time 10 "${auth[@]}" \
    -w $'\n__HTTP_STATUS__:%{http_code}' \
    "$1/api/sessions?status=running&window=all" 2>/dev/null
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

restart_now() {
  pm2 restart "$PM2_NAME"
  # The daemon indexes projects before it registers, so give it a beat to show up.
  sleep 12
  agentuse serve ps
}

# Waits until the daemon reports no live run, then restarts it. TIMEOUT <= 0 waits
# forever. Returns 1 without restarting if the deadline passes first.
wait_for_idle_then_restart() {
  local url deadline body response status n now
  url="$(base_url || true)"
  if [ -z "$url" ]; then
    return 1
  fi
  echo "==> Daemon at $url"

  if [ "$TIMEOUT" -gt 0 ]; then deadline=$(( $(date +%s) + TIMEOUT )); else deadline=0; fi
  while :; do
    response="$(running_json "$url" || true)"
    status="${response##*$'\n__HTTP_STATUS__:'}"
    body="${response%$'\n__HTTP_STATUS__:'*}"
    if [ "$status" != "200" ]; then
      echo "==> Daemon sessions check returned HTTP $status; not restarting." >&2
      return 1
    fi
    n="$(printf '%s' "$body" | describe_running)"
    if [ "$n" = "0" ]; then
      echo "==> Idle. Restarting."
      break
    fi
    now=$(date +%s)
    if [ "$deadline" -gt 0 ] && [ "$now" -ge "$deadline" ]; then
      echo "==> Still $n agent(s) running after ${TIMEOUT}s. Not restarting." >&2
      echo "    Re-run with --force to restart anyway, or --timeout N to wait longer." >&2
      return 1
    fi
    if [ "$deadline" -gt 0 ]; then
      echo "==> $n agent(s) running; waiting $((deadline - now))s more..."
    else
      echo "==> $n agent(s) running; waiting for idle..."
    fi
    sleep "$POLL"
  done

  restart_now
}

mtime_of() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

if [ "$BUILD" = 1 ]; then
  echo "==> Building $REPO_ROOT"
  (cd "$REPO_ROOT" && AGENTUSE_SKIP_SERVE_RESTART=1 pnpm run build)
fi

if [ "$FOLLOW" = 1 ]; then
  BUNDLE="$REPO_ROOT/dist/index.js"
  SETTLE="${AGENTUSE_WATCH_SETTLE:-5}"
  BUILD_POLL="${AGENTUSE_WATCH_POLL:-3}"
  TIMEOUT=0  # never give up waiting for idle; the next rebuild is not lost
  echo "==> Following $BUNDLE. Each rebuild restarts $PM2_NAME once the daemon is idle."
  last="$(mtime_of "$BUNDLE")"
  while :; do
    sleep "$BUILD_POLL"
    cur="$(mtime_of "$BUNDLE")"
    [ "$cur" = "$last" ] && continue
    # Let a burst of rebuilds settle so we restart once, onto the last of them.
    while :; do
      sleep "$SETTLE"
      n="$(mtime_of "$BUNDLE")"
      [ "$n" = "$cur" ] && break
      cur="$n"
    done
    echo "==> dist/index.js changed at $(date '+%H:%M:%S')."
    wait_for_idle_then_restart || true
    # Rebuilds that landed while we waited are already in this restart.
    last="$(mtime_of "$BUNDLE")"
  done
fi

if [ "$FORCE" = 1 ]; then
  echo "==> --force: restarting now, in-flight agents will be killed."
  restart_now
  exit 0
fi

wait_for_idle_then_restart
