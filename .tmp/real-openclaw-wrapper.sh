#!/bin/sh
cmd="$1"
shift
if [ "$cmd" = "gateway" ]; then
  exec npx -y openclaw@2026.3.2 gateway "$@" --allow-unconfigured --dev
fi
exec npx -y openclaw@2026.3.2 "$cmd" "$@"
