#!/usr/bin/env bash
set -euo pipefail

for fixture_index in $(seq 1 240); do
  printf 'fixture-record-%03d | reusable-results recovery regression | harmless deterministic payload | abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n' "$fixture_index"
done
