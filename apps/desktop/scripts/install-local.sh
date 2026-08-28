#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
desktop_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repository_dir=$(CDPATH= cd -- "$desktop_dir/../.." && pwd)
applications_dir="${HOME:?}/Applications"
destination_app="$applications_dir/AgentUse.app"
staging_root=$(mktemp -d "${TMPDIR:-/tmp}/agentuse-desktop-install.XXXXXX")
package_output="$staging_root/package"
incoming_app="$applications_dir/.AgentUse.app.installing.$$"
backup_app="$applications_dir/.AgentUse.app.previous.$$"

cleanup() {
  rm -rf "$staging_root" "$incoming_app"
  if [ -d "$backup_app" ] && [ ! -d "$destination_app" ]; then
    mv "$backup_app" "$destination_app"
  fi
}
trap cleanup EXIT HUP INT TERM

case $(uname -m) in
  arm64)
    builder_arch=arm64
    output_dir=mac-arm64
    ;;
  x86_64)
    builder_arch=x64
    output_dir=mac
    ;;
  *)
    echo "Unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

echo "Building AgentUse and its dashboard..."
(
  cd "$repository_dir"
  bun run build
)

echo "Packaging AgentUse for $builder_arch..."
(
  cd "$desktop_dir"
  AGENTUSE_SETTINGS_UNIVERSAL=1 bun run build
  CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder \
    --mac --dir "--$builder_arch" --config.npmRebuild=false \
    --config.directories.output="$package_output"
)

built_app="$package_output/$output_dir/AgentUse.app"
if [ ! -d "$built_app" ]; then
  echo "Packaged app not found at $built_app" >&2
  exit 1
fi

bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$built_app/Contents/Info.plist")
if [ "$bundle_id" != "io.agentuse.desktop" ]; then
  echo "Unexpected AgentUse bundle identifier: $bundle_id" >&2
  exit 1
fi

echo "Stopping running AgentUse desktop copies..."
running_pids=$(pgrep -f '/AgentUse[.]app/Contents/MacOS/AgentUse( |$)' || true)
if [ -n "$running_pids" ]; then
  for running_pid in $running_pids; do
    kill -TERM "$running_pid" 2>/dev/null || true
  done

  attempts=0
  while [ "$attempts" -lt 200 ]; do
    remaining_pids=$(pgrep -f '/AgentUse[.]app/Contents/MacOS/AgentUse( |$)' || true)
    [ -z "$remaining_pids" ] && break
    sleep 0.1
    attempts=$((attempts + 1))
  done

  remaining_pids=$(pgrep -f '/AgentUse[.]app/Contents/MacOS/AgentUse( |$)' || true)
  if [ -n "$remaining_pids" ]; then
    echo "AgentUse did not exit cleanly; stopping the stale desktop process."
    for remaining_pid in $remaining_pids; do
      kill -KILL "$remaining_pid" 2>/dev/null || true
    done
  fi
fi

mkdir -p "$applications_dir"
ditto "$built_app" "$incoming_app"

if [ -d "$destination_app" ]; then
  mv "$destination_app" "$backup_app"
fi
mv "$incoming_app" "$destination_app"
rm -rf "$backup_app"

# Finder can retain a small icon from an older unsigned build when the bundle
# path, identifier, and version stay the same. Update the bundle timestamp and
# explicitly refresh Launch Services after each local replacement.
touch "$destination_app"
launch_services_register="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$launch_services_register" ]; then
  "$launch_services_register" -f "$destination_app"
fi

echo "Installed $destination_app"
if [ "${AGENTUSE_DESKTOP_NO_LAUNCH:-0}" != "1" ]; then
  open "$destination_app"
  echo "Launched AgentUse."
fi
