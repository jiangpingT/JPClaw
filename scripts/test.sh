#!/usr/bin/env bash
set -euo pipefail

if npm run test -- --help >/dev/null 2>&1; then
  npm run test -- "$@"
else
  echo "No test script found"
fi
