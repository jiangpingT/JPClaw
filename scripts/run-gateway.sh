#!/usr/bin/env bash
set -euo pipefail

cd /Users/mlamp/Workspace/JPClaw

# NOTE: Do not `source .env` here.
# `.env` is not a shell script (it can contain values that break bash parsing).
# The Node entrypoint loads `.env` via dotenv, which is safer and consistent.

# Keep tsx in one-shot mode so it works reliably under launchd.
export TSX_DISABLE_CACHE=1

# 明确给 V8 512MB 堆上限，避免动态堆碰天花板时 OOM 崩溃
# proactive-coder 等高负载任务会产生大量临时对象，需要足够的 GC 缓冲空间
exec /opt/homebrew/bin/node --max-old-space-size=512 --import tsx src/js/cli/index.ts gateway
