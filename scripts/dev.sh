#!/usr/bin/env bash
set -euo pipefail

if npm run dev -- --help >/dev/null 2>&1; then
  npm run dev -- "$@"
else
  npm start -- "$@"
fi
