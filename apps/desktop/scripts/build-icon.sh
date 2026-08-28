#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
desktop_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_icon="$desktop_dir/build/icon.png"
output_icon="$desktop_dir/build/icon.icns"
staging_dir=$(mktemp -d "${TMPDIR:-/tmp}/agentuse-icon-build.XXXXXX")
iconset_dir="$staging_dir/AgentUse.iconset"

cleanup() {
  rm -rf "$staging_dir"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$iconset_dir"
if [ ! -f "$source_icon" ]; then
  echo "Icon master not found at $source_icon" >&2
  exit 1
fi

render_size() {
  size=$1
  filename=$2
  sips -z "$size" "$size" "$source_icon" --out "$iconset_dir/$filename" >/dev/null
}

render_size 16 icon_16x16.png
render_size 32 icon_16x16@2x.png
render_size 32 icon_32x32.png
render_size 64 icon_32x32@2x.png
render_size 128 icon_128x128.png
render_size 256 icon_128x128@2x.png
render_size 256 icon_256x256.png
render_size 512 icon_256x256@2x.png
render_size 512 icon_512x512.png
cp "$source_icon" "$iconset_dir/icon_512x512@2x.png"

staged_icon="$staging_dir/icon.icns"
node "$script_dir/pack-icns.mjs" "$iconset_dir" "$staged_icon"
mv "$staged_icon" "$output_icon"
