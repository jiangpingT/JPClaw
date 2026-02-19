#!/usr/bin/env bash
set -euo pipefail

cd /Users/mlamp/Workspace/JPClaw

# NOTE: Do not `source .env` here.
# `.env` is not a shell script (it can contain values that break bash parsing).
# The Node entrypoint loads `.env` via dotenv, which is safer and consistent.

# Keep tsx in one-shot mode so it works reliably under launchd.
export TSX_DISABLE_CACHE=1

exec /opt/homebrew/bin/node --import tsx src/js/cli/index.ts gateway
