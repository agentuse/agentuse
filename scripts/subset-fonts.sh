#!/usr/bin/env bash
# Regenerates the self-hosted web fonts as Latin+symbols subsets.
#
# The fonts committed under src/cli/serve/web/fonts/ are ALREADY subset with
# this script (that is why they are ~40 kB instead of ~57 kB). To re-subset
# with a different glyph range, fetch the full originals and run this again.
#
# Source (SIL OFL, free): https://github.com/vercel/geist-font
#   Geist-Variable.woff2 and GeistMono-Variable.woff2 live in the release zip.
#
# The range keeps everything a log/CLI viewer realistically renders: Latin +
# diacritics, punctuation, currency, arrows, math operators, box-drawing,
# block/shape symbols, technical + dingbats. Glyphs outside it fall back
# per-glyph to the CSS fallback stack (ui-monospace / ui-sans-serif), so
# non-Latin log output still renders — just not in Geist. The variable wght
# 100–900 axis is preserved (no --instance pinning).
#
# Usage: scripts/subset-fonts.sh <dir-with-full-woff2>   (defaults to $TMPDIR/geist-full)
set -euo pipefail

SRC="${1:-${TMPDIR:-/tmp}/geist-full}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/src/cli/serve/web/fonts"

RANGE="U+0000-00FF,U+0100-024F,U+0250-02AF,U+02B0-02FF,U+0300-036F,U+1E00-1EFF,\
U+2000-206F,U+2070-209F,U+20A0-20BF,U+2100-214F,U+2150-218F,U+2190-21FF,\
U+2200-22FF,U+2300-23FF,U+2400-243F,U+2500-257F,U+2580-259F,U+25A0-25FF,\
U+2600-26FF,U+2700-27BF,U+2B00-2BFF,U+FEFF,U+FFFD"

for name in Geist-Variable GeistMono-Variable; do
  uv run --with fonttools --with brotli python3 -m fontTools.subset \
    "$SRC/$name.woff2" \
    --unicodes="$RANGE" \
    --layout-features='*' \
    --flavor=woff2 \
    --output-file="$OUT/$name.woff2"
  echo "subset $name -> $(wc -c <"$OUT/$name.woff2") bytes"
done
