#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then printf '%s\n' 'This launcher requires macOS.' >&2; exit 1; fi
maid_project_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$maid_project_dir"
maid_version=$(awk -F '"' '/^[ \t]*"version"[ \t]*:/{print $4; exit}' package.json)
maid_arch=$(uname -m)
if [ "$maid_arch" = x86_64 ]; then maid_arch=x64; fi
if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then maid_arch=arm64; fi
maid_app="$maid_project_dir/release/$maid_version/Codex-Maid-Widget-darwin-$maid_arch/Codex-Maid-Widget.app"
if [ -d "$maid_app" ]; then
  maid_built_version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$maid_app/Contents/Info.plist")
  if [ "$maid_built_version" != "$maid_version" ]; then printf '%s\n' 'Packaged version does not match package.json. Rebuild the app.' >&2; exit 1; fi
  exec /usr/bin/open "$maid_app" --args "$@"
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Source launch needs Node.js 22.12 or newer. See docs/macos.md.' >&2; exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<12)){console.error("Node.js 22.12 or newer is required.");process.exit(1)}'
if [ ! -f node_modules/electron/install.js ]; then npm ci; fi
maid_electron=$(node -p 'require("electron")' 2>/dev/null || true)
if [ ! -x "$maid_electron" ]; then node node_modules/electron/install.js; maid_electron=$(node -p 'require("electron")'); fi
nohup "$maid_electron" "$maid_project_dir" "$@" >/dev/null 2>&1 </dev/null &
printf '%s\n' 'Codex Maid Widget started.'
