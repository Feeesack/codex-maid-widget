#!/bin/sh
set -eu
maid_project_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$maid_project_dir"
if ! command -v node >/dev/null 2>&1; then printf '%s\n' 'Node.js 22.12 or newer is required for the optional local plugin.' >&2; exit 1; fi
node scripts/prepare-plugin.cjs
if [ "${1:-}" = --register ]; then
  if ! command -v codex >/dev/null 2>&1; then printf '%s\n' 'Codex CLI was not found. Install from this repository marketplace in Codex Plugins.' >&2; exit 1; fi
  codex plugin marketplace add "$maid_project_dir"
  printf '%s\n' 'Marketplace registered. Restart Codex and install Codex Maid Widget in Plugins.'
elif [ "$#" -gt 0 ]; then
  printf '%s\n' 'Usage: sh install-plugin.command [--register]' >&2; exit 1
else
  printf '%s\n' 'Local plugin paths prepared. No Codex user settings were changed.' 'To register with Codex CLI explicitly: sh install-plugin.command --register'
fi
