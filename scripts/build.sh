#!/usr/bin/env bash
set -euo pipefail

if npm run build -- --help >/dev/null 2>&1; then
  npm run build -- "$@"
else
  echo "No build script found"
fi
