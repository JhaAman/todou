#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$2"
}

[[ "$(uname -s)" == "Darwin" ]] || fail "Todou production builds require macOS."
[[ "$(uname -m)" == "arm64" ]] || fail "Todou production builds currently require an Apple-silicon Mac."

require_command bun "Install Bun 1.3.14 or newer, then run this script again."
require_command cargo "Install Rust 1.85 or newer, then run this script again."
xcode-select -p >/dev/null 2>&1 || fail "Install the Xcode command-line tools with: xcode-select --install"

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

git config --local core.hooksPath "$project_dir/.githooks"
bun install --frozen-lockfile
CI=true bun run tauri build --bundles app

source_app="src-tauri/target/release/bundle/macos/Todou.app"
[[ -d "$source_app" ]] || fail "The build finished without a Todou.app bundle."

applications_dir="$HOME/Applications"
destination_app="$applications_dir/Todou.app"
mkdir -p "$applications_dir"

if [[ -e "$destination_app" ]]; then
  backup_app="$applications_dir/Todou-backup-$(date +%Y%m%d%H%M%S).app"
  mv "$destination_app" "$backup_app"
fi

ditto "$source_app" "$destination_app"
open "$destination_app"

printf '%s\n' "Todou is installed at $destination_app."
printf '%s\n' "To enable hosted sync, open Cmd+K → Connection settings and enter your project URL and publishable key. Never use a service-role key."
