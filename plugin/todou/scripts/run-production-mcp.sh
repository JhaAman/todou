#!/usr/bin/env bash
set -euo pipefail

for app in "$HOME/Applications/Todou.app" "/Applications/Todou.app"; do
  bridge="$app/Contents/Resources/todou-mcp"

  if [[ -x "$bridge" ]]; then
    export TODOU_APP_BUNDLE_PATH="$app"
    exec "$bridge"
  fi
done

printf '%s\n' "Todou is not installed. Follow the setup at https://github.com/JhaAman/todou first." >&2
exit 1
