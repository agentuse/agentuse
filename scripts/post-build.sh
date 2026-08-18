#!/usr/bin/env bash
#
# Restart the local pm2-managed `agentuse serve` daemon so it runs the build that
# just finished. Run automatically at the end of `pnpm build`.
#
# Why this is not optional housekeeping: the daemon loads dist/index.js once, at
# boot, and resolves its dynamic imports lazily. Rebuild underneath it and every
# module it has not imported yet either changed hash or was deleted, so the first
# request that reaches one -- an await_human gate, a session fetch -- dies with
# "Cannot find module .../dist/<chunk>.js" and the page just hangs. Restarting is
# also the only way the new code actually runs; a stale daemon silently serves
# the old build.
#
# Restarting is safe mid-run: serve releases busy workers on shutdown and they
# finish out of process (AgentWorker.release in src/cli/serve.ts). Those released
# workers keep running the OLD build until they exit -- if you need a rebuild to
# apply to in-flight agents too, use scripts/serve-restart.sh, which waits for
# idle first.
#
# Skip with AGENTUSE_SKIP_SERVE_RESTART=1 (set by prepack) or CI=1. To build and
# then restart only once the daemon is idle, use scripts/serve-restart.sh --build
# instead of pnpm build.
#
set -euo pipefail

NAME="${AGENTUSE_PM2_NAME:-agentuse}"

[ -n "${AGENTUSE_SKIP_SERVE_RESTART:-}" ] && exit 0
[ -n "${CI:-}" ] && exit 0
command -v pm2 >/dev/null 2>&1 || exit 0
pm2 describe "$NAME" >/dev/null 2>&1 || exit 0

echo "==> Restarting pm2 '$NAME' onto this build (AGENTUSE_SKIP_SERVE_RESTART=1 to skip)"
pm2 restart "$NAME" >/dev/null
