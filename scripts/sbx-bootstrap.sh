#!/usr/bin/env bash
# Reproducible, rerunnable repository bootstrap for the Docker Sandbox environment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUN_VERSION="$(awk '$1 == "bun" { print $2 }' "$ROOT/.tool-versions")"
PNPM_VERSION="$(sed -nE 's/^[[:space:]]*"packageManager":[[:space:]]*"pnpm@([^+"]+).*/\1/p' "$ROOT/package.json")"

die() { echo "sbx bootstrap: $*" >&2; exit 1; }
note() { echo "sbx bootstrap: $*"; }
have_node_22() {
  command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
}

[[ -n "$BUN_VERSION" ]] || die "could not read the Bun pin from .tool-versions"
[[ -n "$PNPM_VERSION" ]] || die "could not read the pnpm pin from package.json#packageManager"

if ! have_node_22; then
  command -v apt-get >/dev/null 2>&1 || die "Node.js 22+ is missing and apt-get is unavailable; install Node.js 22 and rerun"
  command -v sudo >/dev/null 2>&1 || die "Node.js 22+ is missing and sudo is unavailable; install Node.js 22 and rerun"
  note "installing Node.js 22 and bootstrap prerequisites"
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl unzip
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
have_node_22 || die "Node.js 22+ is required; found $(node --version 2>/dev/null || echo none)"

if ! command -v curl >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 \
    || die "curl and unzip are required to install the pinned Bun release"
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl unzip
fi

if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "$BUN_VERSION" ]]; then
  note "installing Bun $BUN_VERSION"
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
  export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
fi
[[ "$(bun --version 2>/dev/null)" == "$BUN_VERSION" ]] \
  || die "expected Bun $BUN_VERSION; found $(bun --version 2>/dev/null || echo none). Add \$HOME/.bun/bin to PATH and rerun"

if ! command -v corepack >/dev/null 2>&1; then
  note "installing Corepack because this Node distribution does not include it"
  sudo npm install --global corepack
fi
note "activating pnpm $PNPM_VERSION"
corepack prepare "pnpm@$PNPM_VERSION" --activate
[[ "$(pnpm --version 2>/dev/null)" == "$PNPM_VERSION" ]] \
  || die "expected pnpm $PNPM_VERSION; found $(pnpm --version 2>/dev/null || echo none)"

cd "$ROOT"
note "installing the lockfile exactly"
pnpm install --frozen-lockfile
note "building AgentUse"
pnpm run build
note "ready (Node $(node --version), Bun $(bun --version), pnpm $(pnpm --version))"
