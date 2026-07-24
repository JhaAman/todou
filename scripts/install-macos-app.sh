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

if [[ -d "/Applications/Todou.app" ]]; then
  applications_dir="/Applications"
else
  applications_dir="$HOME/Applications"
fi
destination_app="$applications_dir/Todou.app"
mkdir -p "$applications_dir"

running_app="$destination_app/Contents/MacOS/todou"
running_pids=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  executable="$(/bin/ps -ww -p "$pid" -o comm= 2>/dev/null || true)"
  [[ "$executable" == "$running_app" ]] && running_pids+=("$pid")
done < <(/usr/bin/pgrep -x todou || true)

if (( ${#running_pids[@]} )); then
  /bin/kill -TERM "${running_pids[@]}" || fail "The running production app could not be stopped."
  for _ in {1..50}; do
    stopped=true
    for pid in "${running_pids[@]}"; do
      /bin/kill -0 "$pid" >/dev/null 2>&1 && stopped=false
    done
    if "$stopped"; then
      break
    fi
    sleep 0.1
  done
  for pid in "${running_pids[@]}"; do
    /bin/kill -0 "$pid" >/dev/null 2>&1 &&
      fail "Quit the installed Todou app, then run the installer again."
  done
fi

staging_app="$applications_dir/.Todou-install-$$.app"
cleanup_staging() {
  [[ ! -e "$staging_app" ]] || rm -R "$staging_app"
}
trap cleanup_staging EXIT

/usr/bin/ditto "$source_app" "$staging_app"
[[ -d "$staging_app" ]] || fail "The production app could not be staged."

backup_app=""
if [[ -e "$destination_app" ]]; then
  backup_app="$applications_dir/Todou-backup-$(date +%Y%m%d%H%M%S).app"
  mv "$destination_app" "$backup_app"
fi

if ! mv "$staging_app" "$destination_app"; then
  [[ -z "$backup_app" || ! -e "$backup_app" ]] || mv "$backup_app" "$destination_app"
  fail "The production app could not replace the installed copy."
fi

if [[ "${TODOU_OPEN_AFTER_INSTALL:-1}" != "0" ]] && ! /usr/bin/open "$destination_app"; then
  printf 'Warning: Todou was installed but could not be opened automatically.\n' >&2
fi

printf '%s\n' "Todou is installed at $destination_app."
printf '%s\n' "To enable hosted sync, open Cmd+K → Connection settings and enter your project URL and publishable key. Never use a service-role key."
