#!/usr/bin/env bash
# JPClaw Service Manager - 统一管理launchd服务

set -euo pipefail

PLIST_GATEWAY="$HOME/Library/LaunchAgents/com.jpclaw.gateway.plist"
PLIST_FRPC="$HOME/Library/LaunchAgents/com.jpclaw.frpc.plist"

function show_status() {
    echo "=== JPClaw Service Status ==="
    echo ""

    echo "Gateway Service:"
    if launchctl list | grep -q "com.jpclaw.gateway"; then
        echo "  ✅ Running (launchd)"
        launchctl list | grep com.jpclaw.gateway || true
    else
        echo "  ⭕ Not running (launchd)"
    fi

    echo ""
    echo "Port 18790:"
    if lsof -i:18790 >/dev/null 2>&1; then
        echo "  ✅ In use"
        lsof -i:18790 | head -2
    else
        echo "  ⭕ Free"
    fi

    echo ""
    echo "Manual Processes:"
    ps aux | grep -E "tsx.*gateway|node.*gateway" | grep -v grep || echo "  ⭕ None"
}

function stop_service() {
    echo "🛑 Stopping JPClaw Gateway..."

    # 1. Stop launchd service
    if launchctl list | grep -q "com.jpclaw.gateway"; then
        echo "  - Stopping launchd service..."
        launchctl stop com.jpclaw.gateway 2>/dev/null || true
        launchctl unload "$PLIST_GATEWAY" 2>/dev/null || true
        sleep 1
    fi

    # 2. Kill any remaining processes
    echo "  - Cleaning up processes..."
    pkill -9 -f "tsx.*gateway" 2>/dev/null || true
    pkill -9 -f "node.*gateway" 2>/dev/null || true

    # 3. Wait for port to be released
    local count=0
    while lsof -i:18790 >/dev/null 2>&1 && [ $count -lt 10 ]; do
        echo "  - Waiting for port 18790 to be released..."
        sleep 1
        count=$((count + 1))
    done

    if lsof -i:18790 >/dev/null 2>&1; then
        echo "  ⚠️  Port 18790 still in use, force killing..."
        lsof -ti:18790 | xargs kill -9 2>/dev/null || true
        sleep 1
    fi

    echo "✅ Service stopped"
}

function start_service() {
    echo "🚀 Starting JPClaw Gateway..."

    # Check if launchd service exists
    if [ ! -f "$PLIST_GATEWAY" ]; then
        echo "  ⚠️  Launchd plist not found: $PLIST_GATEWAY"
        echo "  Starting manually instead..."
        cd /Users/mlamp/Workspace/JPClaw
        npx tsx src/js/cli/index.ts gateway &
        echo "✅ Gateway started manually (PID: $!)"
        return
    fi

    # Load launchd service
    echo "  - Loading launchd service..."
    launchctl load "$PLIST_GATEWAY" 2>/dev/null || true
    sleep 2

    # Start service
    echo "  - Starting service..."
    launchctl start com.jpclaw.gateway 2>/dev/null || true
    sleep 3

    # Verify
    if launchctl list | grep -q "com.jpclaw.gateway"; then
        echo "✅ Gateway started via launchd"
    else
        echo "❌ Failed to start gateway"
        return 1
    fi
}

function restart_service() {
    stop_service
    echo ""
    sleep 2
    start_service
}

function start_manual() {
    echo "🚀 Starting JPClaw Gateway (manual mode)..."

    # Stop launchd first
    if launchctl list | grep -q "com.jpclaw.gateway"; then
        echo "  - Stopping launchd service first..."
        launchctl stop com.jpclaw.gateway 2>/dev/null || true
        launchctl unload "$PLIST_GATEWAY" 2>/dev/null || true
        sleep 2
    fi

    # Start manually
    cd /Users/mlamp/Workspace/JPClaw
    echo "  - Starting in foreground..."
    npx tsx src/js/cli/index.ts gateway
}

function logs() {
    echo "📋 Showing gateway logs (Ctrl+C to exit)..."
    echo ""
    tail -f /Users/mlamp/Workspace/JPClaw/log/launchd-gateway.out.log
}

# Main
case "${1:-status}" in
    status)
        show_status
        ;;
    stop)
        stop_service
        ;;
    start)
        start_service
        ;;
    restart)
        restart_service
        ;;
    manual)
        start_manual
        ;;
    logs)
        logs
        ;;
    *)
        echo "Usage: $0 {status|start|stop|restart|manual|logs}"
        echo ""
        echo "Commands:"
        echo "  status   - Show service status"
        echo "  start    - Start launchd service"
        echo "  stop     - Stop service completely"
        echo "  restart  - Stop and start service"
        echo "  manual   - Start in foreground (manual mode)"
        echo "  logs     - Tail gateway logs"
        exit 1
        ;;
esac
