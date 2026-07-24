#!/usr/bin/env bash
set -euo pipefail

for app in "$HOME/Applications/Todou.app" "/Applications/Todou.app"; do
  bridge="$app/Contents/Resources/todou-mcp"
  executable="$app/Contents/MacOS/todou"

  if [[ -x "$bridge" ]]; then
    if [[ -x "$executable" ]]; then
      export TODOU_APP_PATH="$executable"
    fi
    exec "$bridge"
  fi
done

printf '%s\n' "Todou is not installed. Follow the setup at https://github.com/JhaAman/todou first." >&2
exit 1
