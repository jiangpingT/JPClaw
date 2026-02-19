#!/usr/bin/env bash
set -euo pipefail

if npm run lint -- --help >/dev/null 2>&1; then
  npm run lint -- "$@"
else
  echo "No lint script found"
fi
