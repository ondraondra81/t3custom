#!/bin/bash
set -euo pipefail
umask 077

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Tento nastroj je urceny pro Mac.' >&2
  exit 1
fi
if [[ -n "${T3CODE_HOME:-}" ]]; then
  echo 'T3CODE_HOME je nastavene. Nastroj podporuje pouze vychozi profily.' >&2
  exit 1
fi

sync_dir=$(cd "$(dirname "$0")" && pwd -P)
for app in /Applications/*.app "$HOME"/Applications/*.app; do
  [[ -f "$app/Contents/Info.plist" ]] || continue
  bundle=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || true)
  if [[ "$bundle" == dev.ondraondra81.t3custom ]]; then
    executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
    exec env ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/$executable" "$sync_dir/sync-profiles.mjs" "$@"
  fi
done
echo 'Nenalezeno T3 Custom v /Applications nebo ~/Applications.' >&2
exit 1
