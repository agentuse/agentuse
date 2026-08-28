#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
desktop_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_icon="$desktop_dir/build/icon.png"
output_icon="$desktop_dir/build/icon.icns"
staging_dir=$(mktemp -d "${TMPDIR:-/tmp}/agentuse-icon-build.XXXXXX")
asset_catalog="$staging_dir/Assets.xcassets"
app_icon_set="$asset_catalog/AppIcon.appiconset"
compiled_assets="$staging_dir/compiled"

cleanup() {
  rm -rf "$staging_dir"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$app_icon_set" "$compiled_assets"
if [ ! -f "$source_icon" ]; then
  echo "Icon master not found at $source_icon" >&2
  exit 1
fi

render_size() {
  size=$1
  filename=$2
  sips -z "$size" "$size" "$source_icon" --out "$app_icon_set/$filename" >/dev/null
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
cp "$source_icon" "$app_icon_set/icon_512x512@2x.png"
cp "$desktop_dir/build/AppIcon.appiconset/Contents.json" "$app_icon_set/Contents.json"

xcrun actool "$asset_catalog" \
  --compile "$compiled_assets" \
  --platform macosx \
  --minimum-deployment-target 13.0 \
  --app-icon AppIcon \
  --output-partial-info-plist "$staging_dir/partial.plist" \
  >/dev/null

if [ ! -f "$compiled_assets/AppIcon.icns" ]; then
  echo "Xcode did not produce AppIcon.icns" >&2
  exit 1
fi

mv "$compiled_assets/AppIcon.icns" "$output_icon"
