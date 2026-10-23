#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
entry="$script_dir/../../dist-server/server.mjs"
if [ ! -f "$entry" ]; then
  echo "Missing production build. Run npm ci && npm run build:production first." >&2
  exit 1
fi
exec node "$entry" "$@"
