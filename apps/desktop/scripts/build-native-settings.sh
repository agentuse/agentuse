#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
desktop_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_file="$desktop_dir/native-settings/AgentUseSettings.swift"
info_file="$desktop_dir/native-settings/Info.plist"
bundle_dir="$desktop_dir/dist/AgentUseSettings.app"
output_file="$bundle_dir/Contents/MacOS/AgentUseSettings"
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/agentuse-native-settings.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT INT TERM

mkdir -p "$bundle_dir/Contents/MacOS"
cp "$info_file" "$bundle_dir/Contents/Info.plist"

if [ "${AGENTUSE_SETTINGS_UNIVERSAL:-0}" = "1" ]; then
  xcrun swiftc -parse-as-library -O -module-cache-path "$build_dir/ModuleCache-arm64" -target arm64-apple-macosx13.0 "$source_file" -o "$build_dir/AgentUseSettings-arm64"
  xcrun swiftc -parse-as-library -O -module-cache-path "$build_dir/ModuleCache-x86_64" -target x86_64-apple-macosx13.0 "$source_file" -o "$build_dir/AgentUseSettings-x86_64"
  xcrun lipo -create "$build_dir/AgentUseSettings-arm64" "$build_dir/AgentUseSettings-x86_64" -output "$output_file"
else
  settings_arch=$(uname -m)
  xcrun swiftc -parse-as-library -O -module-cache-path "$build_dir/ModuleCache" -target "${settings_arch}-apple-macosx13.0" "$source_file" -o "$output_file"
fi

chmod 755 "$output_file"
