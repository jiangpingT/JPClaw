import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { ChatEngine } from "../core/engine.js";
import { wrapChatEngine } from "../core/engine.js";
import { loadConfig, type JPClawConfig } from "../shared/config.js";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode, ErrorHandler } from "../shared/errors.js";
import { errorCodeToHttpStatus } from "../shared/http-status.js";
import { createTracingMiddleware, tracer } from "../shared/trace.js";
import { createMetricsMiddleware, metrics } from "../monitoring/metrics.js";
import { healthMonitor, addProviderHealthCheck } from "../monitoring/health.js";
import { createSecurityMiddleware } from "../security/middleware.js";
import { loadSecurityConfig, validateSecurityConfig, getSecurityConfigSummary } from "../shared/security-config.js";
import { handleFeishuWebhook, sendFeishuPing } from "../channels/feishu.js";
import { handleWecomWebhook, sendWecomPing } from "../channels/wecom.js";
import { listSkills, listAgentSkills, runSkill } from "../skills/registry.js";
import { VoiceWakeService } from "../voice/wake.js";
import { startDiscordChannel } from "../channels/discord.js";
import { startTelegramChannel } from "../channels/telegram.js";
import { startDmworkChannel } from "../channels/dmwork.js";
import { MultiAgentRouter } from "../agents/router.js";
import { FixedAgentEngine } from "../agents/fixed-agent-engine.js";
import { startScheduler } from "../scheduler/runner.js";
import { HeartbeatService } from "../heartbeat/service.js";
import { runDailyCleanup } from "../maintenance/cleanup.js";
import { runGatewaySelfCheck } from "./self-check.js";
import { enhancedMemoryManager } from "../memory/enhanced-memory-manager.js";
import { vectorMemoryStore } from "../memory/vector-store.js";
import { conflictResolver } from "../memory/conflict-resolver.js";
import type { DiscordBotConfig } from "../shared/config.js";
import { validateAndParse, commonValidators, type Validator } from "../shared/validation.js";
import { dashboardBus } from "../shared/dashboard-bus.js";

/**
 * P0-4: 全局异常处理器
 * 捕获未处理的异常和Promise拒绝，防止进程崩溃
 */
function setupGlobalErrorHandlers(): void {
  // 捕获未捕获的同步异常
  process.on('uncaughtException', (error: Error) => {
    logError(new JPClawError({
      code: ErrorCode.SYSTEM_INTERNAL,
      message: "Uncaught exception - potential fatal error",
      cause: error
    }));

    // 记录到metrics
    metrics.increment("system.uncaught_exception", 1, {
      errorName: error.name,
      errorMessage: error.message
    });

    // 判断是否需要退出
    // 一些错误是致命的，必须退出
    const fatalErrors = [
      'EADDRINUSE',  // 端口已被占用
      'ENOMEM',      // 内存不足
      'EMFILE',      // 打开文件过多
    ];

    const errorCode = 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    const isFatal = fatalErrors.some(code =>
      error.message.includes(code) || errorCode === code
    );

    if (isFatal) {
      log("error", "Fatal error detected, shutting down gracefully", {
        error: error.message,
        code: errorCode
      });

      // 给一些时间让日志写入
      setTimeout(() => {
        process.exit(1);
      }, 1000);
    } else {
      log("warn", "Non-fatal uncaught exception, continuing operation", {
        error: error.message
      });
      // 非致命错误，继续运行
    }
  });

  // 捕获未处理的Promise拒绝
  process.on('unhandledRejection', (reason: unknown, promise: Promise<any>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));

    logError(new JPClawError({
      code: ErrorCode.SYSTEM_INTERNAL,
      message: "Unhandled promise rejection",
      cause: error,
      context: { reason: String(reason) }
    }));

    // 记录到metrics
    metrics.increment("system.unhandled_rejection", 1, {
      reason: String(reason)
    });

    // 注意：Node.js 15+ 默认会在未处理的rejection时退出
    // 我们这里记录日志但不强制退出，让Node.js的默认行为生效
  });

  // 捕获警告（如弃用警告）
  process.on('warning', (warning: Error) => {
    log("warn", "Process warning", {
      name: warning.name,
      message: warning.message,
      stack: warning.stack
    });

    metrics.increment("system.warnings", 1, {
      warningName: warning.name
    });
  });

  log("info", "Global error handlers installed");
}

/**
 * 格式化运行时间（毫秒 -> 人类可读格式）
 */
function formatUptime(uptimeMs: number): string {
  const seconds = Math.floor(uptimeMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * 获取指标摘要
 */
function getMetricsSummary() {
  try {
    const snapshot = metrics.generateSnapshot();
    return {
      totalRequests: snapshot.summary.totalRequests,
      errorRate: snapshot.summary.errorRate,
      avgResponseTime: snapshot.summary.avgResponseTime
    };
  } catch {
    return {
      totalRequests: 0,
      errorRate: 0,
      avgResponseTime: 0
    };
  }
}

export interface ShutdownFunction {
  (): Promise<void>;
}

export async function startGateway(): Promise<ShutdownFunction> {
  // P0-4修复: 添加全局异常捕获，防止进程崩溃
  setupGlobalErrorHandlers();

  await runGatewaySelfCheck();
  const config = loadConfig();

  // 优化：启动时读取版本号（缓存，避免每次请求读文件）
  let cachedVersion = "unknown";
  try {
    const packageJson = JSON.parse(
      await fs.promises.readFile(path.join(process.cwd(), "package.json"), "utf-8")
    );
    cachedVersion = packageJson.version;
  } catch (error) {
    log("warn", "gateway.version.read_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // 加载和验证安全配置
  const securityConfig = loadSecurityConfig();
  const configValidation = validateSecurityConfig(securityConfig);
  
  if (!configValidation.valid) {
    log("error", "Invalid security configuration", { errors: configValidation.errors });
    throw new Error(`Security configuration errors: ${configValidation.errors.join(", ")}`);
  }
  
  log("info", "Security configuration loaded", getSecurityConfigSummary(securityConfig));

  // 优化：验证Admin API配置（防止安全漏洞）
  const adminToken = process.env.JPCLAW_ADMIN_TOKEN;
  const disableAdmin = process.env.JPCLAW_DISABLE_ADMIN === "true";

  if (!adminToken && !disableAdmin) {
    log("error", "Admin API security not configured", {
      message: "JPCLAW_ADMIN_TOKEN is not set and JPCLAW_DISABLE_ADMIN is not true",
      suggestion: "Set JPCLAW_ADMIN_TOKEN or set JPCLAW_DISABLE_ADMIN=true to disable admin endpoints"
    });
    throw new Error(
      "Admin API security error: JPCLAW_ADMIN_TOKEN must be set, or set JPCLAW_DISABLE_ADMIN=true to disable admin endpoints"
    );
  }

  if (disableAdmin) {
    log("warn", "Admin API disabled", { reason: "JPCLAW_DISABLE_ADMIN=true" });
  } else {
    log("info", "Admin API enabled", {
      tokenConfigured: !!adminToken,
      tokenLength: adminToken?.length
    });
  }

  // 创建安全中间件
  const security = createSecurityMiddleware(securityConfig.middleware);
  const router = new MultiAgentRouter(config);
  const engine: ChatEngine = router;
  const engineV2 = wrapChatEngine(engine); // 阶段2.5：包装为 V2
  const admin = router.adminApi();
  const canvasClients = new Set<WebSocket>();

  // 支持多个 Discord bot
  const discordBots: ReturnType<typeof startDiscordChannel>[] = [];
  const discordConfig = config.channels.discord;

  if (discordConfig) {
    if (Array.isArray(discordConfig)) {
      // 多 bot 模式 - 传入完整数组，让 startDiscordChannel 内部处理协作逻辑
      log("info", "discord.multi_bot.mode_detected", {
        botCount: discordConfig.length,
        bots: discordConfig.map(b => ({ name: b.name, agentId: b.agentId }))
      });

      const multiBot = startDiscordChannel(discordConfig, engine, admin);
      discordBots.push(multiBot);
    } else {
      // 单 bot 模式（向后兼容）
      const bot = startDiscordChannel(discordConfig, engine, admin);
      discordBots.push(bot);
      log("info", "discord.bot.started", { mode: "single" });
    }
  }

  // 兼容旧代码：使用第一个 bot 作为默认 discord 实例
  const discord = discordBots[0];

  // Telegram 渠道（Polling 模式）
  const telegram = startTelegramChannel(config.channels.telegram, engine);

  // DMWork 渠道（WebSocket 模式）
  const dmwork = startDmworkChannel(config.channels.dmwork, engine);

  const heartbeat = new HeartbeatService({
    enabled: process.env.JPCLAW_HEARTBEAT_ENABLED === "true",
    intervalMinutes: Number(process.env.JPCLAW_HEARTBEAT_INTERVAL_MINUTES || "30"),
    inboxDir: path.resolve(process.cwd(), "sessions", "inbox"),
    ownerUserId: process.env.JPCLAW_OWNER_DISCORD_ID || "1351911386602672133",
    ownerDmEnabled: process.env.JPCLAW_HEARTBEAT_OWNER_DM === "true",
    ownerDmMode:
      (process.env.JPCLAW_HEARTBEAT_DM_MODE || "important").toLowerCase() === "always"
        ? "always"
        : "important",
    startupGraceSeconds: Number(process.env.JPCLAW_HEARTBEAT_STARTUP_GRACE_SECONDS || "60"),
    disconnectDmThreshold: Number(process.env.JPCLAW_HEARTBEAT_DISCONNECT_DM_THRESHOLD || "2"),
    onDailyFirstTick: async () => {
      const cleanupResult = await runDailyCleanup({
        transcriptRetentionDays: Number(process.env.JPCLAW_CLEANUP_TRANSCRIPT_RETENTION_DAYS || "7"),
        logMaxBytes: Number(process.env.JPCLAW_CLEANUP_LOG_MAX_BYTES || String(5 * 1024 * 1024))
      });

      // 每日记忆生命周期评估
      let lifecycleMessage = "";
      try {
        log("info", "Running daily memory lifecycle evaluation...");

        const allMemories = vectorMemoryStore.getAllMemories();
        const userIds = new Set(allMemories.map(m => m.metadata.userId));

        let totalUpgraded = 0;
        let totalDowngraded = 0;
        let totalDeleted = 0;

        for (const userId of userIds) {
          const result = await enhancedMemoryManager.evaluateMemoryLifecycle(userId);
          totalUpgraded += result.upgraded;
          totalDowngraded += result.downgraded;
          totalDeleted += result.deleted;
        }

        log("info", "Daily memory lifecycle evaluation completed", {
          users: userIds.size,
          upgraded: totalUpgraded,
          downgraded: totalDowngraded,
          deleted: totalDeleted
        });

        lifecycleMessage = `\n\nMemory Lifecycle: Evaluated ${userIds.size} users - ↑${totalUpgraded} ↓${totalDowngraded} 🗑${totalDeleted}`;
      } catch (error) {
        log("error", "Daily memory lifecycle evaluation failed", {
          error: error instanceof Error ? error.message : String(error)
        });

        lifecycleMessage = "\n\nMemory Lifecycle: ⚠️ Evaluation failed";
      }

      // 合并清理报告和生命周期评估
      if (cleanupResult) {
        return {
          title: cleanupResult.title,
          body: cleanupResult.body + lifecycleMessage,
          important: cleanupResult.important
        };
      } else {
        return {
          title: "Daily Maintenance",
          body: "Routine tasks completed." + lifecycleMessage,
          important: false
        };
      }
    }
  });
  heartbeat.start(discord);

  // 启动记忆生命周期管理（自动升级、降级、淘汰）
  try {
    enhancedMemoryManager.startLifecycleEvaluation();
    log("info", "Memory lifecycle management started", {
      interval: "24 hours",
      features: ["auto-upgrade", "auto-downgrade", "auto-cleanup"]
    });
  } catch (error) {
    logError(new JPClawError({
      code: ErrorCode.MEMORY_OPERATION_FAILED,
      message: "Failed to start memory lifecycle management",
      cause: error instanceof Error ? error : undefined
    }));
    // 不影响系统启动，继续运行
  }

  const server = http.createServer(async (req, res) => {
    // 安全响应写入函数（防止重复写入）
    const safeResponse = (status: number, body: unknown): boolean => {
      if (res.headersSent || res.destroyed) return false;
      try {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return true;
      } catch (error) {
        // 写入失败（可能socket已关闭），记录日志但不抛异常
        log("warn", "gateway.response.write_failed", {
          error: String(error),
          status
        });
        return false;
      }
    };

    // #55修复: 通用 POST 端点处理器（消除验证+错误处理的代码重复）
    const handlePost = async <T>(
      validator: Validator<T>,
      handler: (payload: T) => Promise<unknown>,
      errorLabel: string
    ): Promise<void> => {
      try {
        const payload = await validateAndParse(req, validator);
        const result = await handler(payload);
        safeResponse(200, result);
      } catch (error) {
        log("error", `${errorLabel}.error`, { error: String(error) });
        if (error instanceof JPClawError && error.code === ErrorCode.INPUT_VALIDATION_FAILED) {
          safeResponse(400, { error: "validation_failed", details: error.context });
        } else {
          safeResponse(500, { error: "internal_error" });
        }
      }
    };

    // #55修复: 通用 URL 查询参数提取器（消除 new URL + searchParams 重复）
    const getQueryParam = (paramName: string): string => {
      const url = new URL(req.url || "", "http://127.0.0.1");
      return url.searchParams.get(paramName) || "";
    };

    // 应用安全中间件
    let middlewareError: Error | null = null;

    // 模拟中间件链
    const runMiddleware = (middleware: Function): Promise<void> => {
      return new Promise((resolve, reject) => {
        middleware(req, res, (error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    };

    try {
      await runMiddleware(security.securityHeaders);
      await runMiddleware(security.rateLimit);
      await runMiddleware(security.resourceProtection);

      // 认证中间件内部已有公共路由判断，直接应用
      await runMiddleware(security.auth);

    } catch (error) {
      middlewareError = error instanceof Error ? error : new Error(String(error));

      logError(new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: "Security middleware error",
        cause: middlewareError
      }));

      safeResponse(500, { error: "Security system error" });
      return;
    }

    // 如果中间件返回了响应，停止处理
    if (res.headersSent) return;

    // 优化：Admin API认证逻辑（防止安全漏洞）
    const ensureAdmin = (): boolean => {
      // 如果Admin功能被禁用，拒绝所有访问
      if (disableAdmin) {
        return false;
      }

      // 验证token（此时adminToken一定存在，因为启动时已验证）
      const auth = String(req.headers.authorization || "");
      const header = String(req.headers["x-admin-token"] || "");
      const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
      return bearer === adminToken || header === adminToken;
    };

    if ((req.url || "").startsWith("/admin/")) {
      if (!ensureAdmin()) {
        const errorMessage = disableAdmin
          ? "Admin API is disabled"
          : "Unauthorized";

        safeResponse(disableAdmin ? 403 : 401, { error: errorMessage });
        return;
      }
    }

    if (req.method === "POST" && req.url === "/webhook/feishu") {
      await handleFeishuWebhook(req, res, config.channels.feishu, engine);
      return;
    }

    if ((req.method === "POST" || req.method === "GET") && (req.url || "").startsWith("/webhook/wecom")) {
      await handleWecomWebhook(req, res, config.channels.wecom, engine);
      return;
    }

    if (req.method === "GET" && req.url === "/skills") {
      const skills = listSkills().map((skill) => skill.manifest);
      const agentSkills = listAgentSkills().map((skill) => skill.manifest);
      safeResponse(200, { skills, agentSkills });
      return;
    }

    // 阶段 5.2：增强健康检查端点
    if (req.method === "GET" && req.url === "/health") {
      try {
        const health = await healthMonitor.runAllChecks();
        const httpStatus = health.overall === "healthy" ? 200 :
                          health.overall === "degraded" ? 200 : 503;

        safeResponse(httpStatus, {
          status: health.overall,
          version: cachedVersion, // 优化：使用缓存的版本号
          timestamp: health.timestamp,
          uptime: health.uptime,
          uptimeFormatted: formatUptime(health.uptime),
          summary: health.summary,
          checks: health.checks,
          components: {
            discord: discordBots.length === 1
              ? discord?.getStatus()
              : discordBots.map((bot, idx) => ({
                  index: idx,
                  status: bot.getStatus()
                })),
            telegram: telegram.getStatus(),
            memory: process.memoryUsage(),
            cpu: process.cpuUsage()
          },
          metrics: getMetricsSummary()
        });
      } catch (error) {
        logError(new JPClawError({
          code: ErrorCode.SYSTEM_INTERNAL,
          message: "Health check failed",
          cause: error instanceof Error ? error : undefined
        }));

        safeResponse(503, {
          status: "unhealthy",
          error: "Health check system failed"
        });
      }
      return;
    }

    // 阶段 5.2：K8s 兼容的就绪检查端点
    if (req.method === "GET" && req.url === "/readiness") {
      try {
        const health = await healthMonitor.runAllChecks();

        // 就绪检查：只有所有关键检查都通过才算就绪
        const criticalChecks = Object.entries(health.checks).filter(
          ([_, result]) => result.details?.critical === true
        );
        const allCriticalHealthy = criticalChecks.every(
          ([_, result]) => result.status === "healthy"
        );

        const ready = health.overall !== "unhealthy" && allCriticalHealthy;
        const httpStatus = ready ? 200 : 503;

        safeResponse(httpStatus, {
          ready,
          status: health.overall,
          timestamp: health.timestamp,
          checks: health.checks
        });
      } catch (error) {
        safeResponse(503, {
          ready: false,
          error: "Readiness check failed"
        });
      }
      return;
    }

    if (req.method === "GET" && req.url === "/metrics") {
      try {
        const snapshot = metrics.generateSnapshot();
        safeResponse(200, snapshot);
      } catch (error) {
        logError(new JPClawError({
          code: ErrorCode.SYSTEM_INTERNAL,
          message: "Metrics collection failed",
          cause: error instanceof Error ? error : undefined
        }));

        safeResponse(500, { error: "Metrics system failed" });
      }
      return;
    }

    if (req.method === "GET" && req.url === "/api/status") {
      try {
        const health = await healthMonitor.runAllChecks();
        const snap = metrics.generateSnapshot();
        const tasksPath = path.join(process.cwd(), "sessions", "schedules", "tasks.json");
        let tasks: unknown[] = [];
        try { tasks = JSON.parse(await fs.promises.readFile(tasksPath, "utf-8")); } catch {}

        safeResponse(200, {
          timestamp: Date.now(),
          health: {
            overall: health.overall,
            uptime: health.uptime,
            uptimeFormatted: formatUptime(health.uptime),
            checks: health.checks,
          },
          metrics: snap.summary,
          tasks,
        });
      } catch (err) {
        safeResponse(500, { error: "Status collection failed" });
      }
      return;
    }

    // 阶段4：Benchmark 端点
    if (req.method === "POST" && req.url === "/benchmark") {
      try {
        const { BenchmarkRunner } = await import("../benchmark/runner.js");
        const runner = new BenchmarkRunner();
        const report = await runner.run();

        safeResponse(200, report);
      } catch (error) {
        logError(new JPClawError({
          code: ErrorCode.SYSTEM_INTERNAL,
          message: "Benchmark failed",
          cause: error instanceof Error ? error : undefined
        }));

        safeResponse(500, { error: "Benchmark execution failed" });
      }
      return;
    }

    if (req.method === "GET" && req.url === "/benchmark/report") {
      try {
        const reportPath = path.join(process.cwd(), "benchmark-reports", "latest.json");
        const reportContent = await fs.promises.readFile(reportPath, "utf-8");

        safeResponse(200, JSON.parse(reportContent));
      } catch (error) {
        safeResponse(404, { error: "No benchmark report found" });
      }
      return;
    }

    if (req.method === "GET" && req.url === "/dashboard") {
      try {
        const dashboardPath = path.join(process.cwd(), "dashboard", "index.html");
        const dashboardContent = await fs.promises.readFile(dashboardPath, "utf-8");

        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardContent);
      } catch (error) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Dashboard not found");
      }
      return;
    }

    if (req.method === "GET" && req.url === "/dashboard/benchmark") {
      try {
        const dashboardPath = path.join(process.cwd(), "src", "js", "gateway", "dashboard.html");
        const dashboardContent = await fs.promises.readFile(dashboardPath, "utf-8");

        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardContent);
      } catch (error) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Benchmark dashboard not found");
      }
      return;
    }

    if (req.method === "GET" && req.url === "/admin/agents") {
      safeResponse(200, {
        defaultAgentId: admin.getDefaultAgentId(),
        agents: admin.listAgents()
      });
      return;
    }

    if (req.method === "POST" && req.url === "/admin/agents") {
      await handlePost(commonValidators.agentCreate, async (payload) => {
        const created = admin.createAgent({ id: payload.id, name: payload.name });
        return { ok: true, agent: created };
      }, "admin.agents.create");
      return;
    }

    if (req.method === "GET" && req.url === "/admin/bindings") {
      safeResponse(200, { bindings: admin.listBindings() });
      return;
    }

    if (req.method === "POST" && req.url === "/admin/bindings") {
      await handlePost(commonValidators.channelBinding, async (payload) => {
        const bound = admin.bindDiscordChannel(payload.channelId, payload.agentId);
        return { ok: true, binding: bound };
      }, "admin.bindings.create");
      return;
    }

    if (req.method === "DELETE" && (req.url || "").startsWith("/admin/bindings")) {
      const channelId = getQueryParam("channelId");
      if (!channelId) { safeResponse(400, { error: "missing_channelId" }); return; }
      try {
        safeResponse(200, { ok: true, ...admin.unbindDiscordChannel(channelId) });
      } catch (error) { safeResponse(400, { error: String(error) }); }
      return;
    }

    if (req.method === "DELETE" && (req.url || "").startsWith("/admin/agents")) {
      const agentId = getQueryParam("agentId");
      if (!agentId) { safeResponse(400, { error: "missing_agentId" }); return; }
      try {
        safeResponse(200, { ok: true, ...admin.deleteAgent(agentId) });
      } catch (error) { safeResponse(400, { error: String(error) }); }
      return;
    }

    if (req.method === "GET" && (req.url || "").startsWith("/wecom/ping")) {
      try {
        const url = new URL(req.url || "", "http://127.0.0.1");
        const toUser = url.searchParams.get("toUser") || undefined;
        const chatId = url.searchParams.get("chatId") || undefined;
        const text = url.searchParams.get("text") || "Ping from JPClaw";
        const result = await sendWecomPing(config.channels.wecom, { toUser, chatId, text });
        safeResponse(result.ok ? 200 : 400, { ok: result.ok, detail: result.detail });
      } catch (error) {
        log("error", "wecom.ping.error", { error: String(error) });
        safeResponse(500, { ok: false, error: "internal_error" });
      }
      return;
    }

    if (req.method === "GET" && (req.url || "").startsWith("/feishu/ping")) {
      try {
        const url = new URL(req.url || "", "http://127.0.0.1");
        const chatId = url.searchParams.get("chatId") || undefined;
        const text = url.searchParams.get("text") || "Ping from JPClaw";
        const result = await sendFeishuPing(config.channels.feishu, { chatId, text });
        safeResponse(result.ok ? 200 : 400, { ok: result.ok, detail: result.detail });
      } catch (error) {
        log("error", "feishu.ping.error", { error: String(error) });
        safeResponse(500, { ok: false, error: "internal_error" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/skills/run") {
      await handlePost(commonValidators.skillRun, async (payload) => {
        const output = await runSkill(payload.name, payload.input || "", { scope: payload.scope });
        return { output };
      }, "skills.run");
      return;
    }

    if (req.method === "POST" && req.url === "/canvas/push") {
      try {
        const payload = await validateAndParse(req, commonValidators.canvasPush);
        const message = JSON.stringify({
          type: payload.type || "html",
          html: payload.html || ""
        });
        // P0-NEW-5修复: send 失败时自动清理僵尸连接
        for (const client of canvasClients) {
          if (client.readyState === client.OPEN) {
            try {
              client.send(message);
            } catch {
              canvasClients.delete(client);
              try { client.terminate(); } catch {}
            }
          }
        }
        safeResponse(200, { ok: true });
      } catch (error) {
        log("error", "canvas.push.error", { error: String(error) });
        if (error instanceof JPClawError && error.code === ErrorCode.INPUT_VALIDATION_FAILED) {
          safeResponse(400, { error: "validation_failed", details: error.context });
        } else {
          safeResponse(500, { error: "internal_error" });
        }
      }
      return;
    }

    // 记忆系统 API 端点（#55修复: 使用 handlePost 消除重复）
    if (req.method === "POST" && req.url === "/memory/query") {
      await handlePost(commonValidators.memoryQuery, async (payload) => {
        return enhancedMemoryManager.query({
          text: payload.text, userId: payload.userId, options: payload.options
        });
      }, "memory.query");
      return;
    }

    if (req.method === "POST" && req.url === "/memory/update") {
      await handlePost(commonValidators.memoryUpdate, async (payload) => {
        return enhancedMemoryManager.updateMemory(payload.userId, payload.input, payload.options || {});
      }, "memory.update");
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/memory/stats")) {
      const userId = getQueryParam("userId");
      if (!userId) { safeResponse(400, { error: "missing_userId" }); return; }
      try {
        safeResponse(200, await enhancedMemoryManager.getMemoryStats(userId));
      } catch (error) {
        log("error", "memory.stats.error", { error: String(error) });
        safeResponse(500, { error: "internal_error" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/memory/cleanup") {
      await handlePost(commonValidators.memoryCleanup, async (payload) => {
        return enhancedMemoryManager.cleanupMemory(payload.userId, payload.options || {});
      }, "memory.cleanup");
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/memory/conflicts")) {
      const userId = getQueryParam("userId");
      if (!userId) { safeResponse(400, { error: "missing_userId" }); return; }
      try {
        safeResponse(200, conflictResolver.getConflictSummary(userId));
      } catch (error) {
        log("error", "memory.conflicts.error", { error: String(error) });
        safeResponse(500, { error: "internal_error" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/memory/resolve-conflicts") {
      await handlePost(commonValidators.memoryResolveConflicts, async (payload) => {
        if (payload.conflictId) {
          return conflictResolver.resolveConflict(payload.conflictId);
        }
        return conflictResolver.resolveAllAutoConflicts(payload.userId);
      }, "memory.resolve");
      return;
    }

    if (req.method === "POST" && req.url === "/chat") {
      try {
        // 使用统一的validation系统
        const payload = await validateAndParse(req, commonValidators.chat);
        const input = payload.input || "";

        // 阶段2.5：使用 V2 API
        const result = await engineV2.replyV2(input, {
          userId: payload.userId,
          userName: payload.userName,
          channelId: payload.channelId
        });

        if (result.ok) {
          safeResponse(200, { ok: true, output: result.data, metadata: result.metadata });
        } else {
          const statusCode = errorCodeToHttpStatus(result.error.code);
          safeResponse(statusCode, {
            ok: false,
            error: {
              code: result.error.code,
              message: result.error.userMessage,
              retryable: result.retryable,
              retryAfterMs: result.retryAfterMs
            }
          });
        }
      } catch (error) {
        log("error", "gateway.chat.error", { error: String(error) });
        // 只有在 headers 还没发送时才写响应，避免崩溃
        if (!res.headersSent) {
          // 区分validation错误和其他错误
          if (error instanceof JPClawError && error.code === ErrorCode.INPUT_VALIDATION_FAILED) {
            safeResponse(400, { ok: false, error: { code: "VALIDATION_FAILED", message: error.message, context: error.context } });
          } else {
            safeResponse(500, { ok: false, error: { code: "SYSTEM_INTERNAL", message: "内部错误" } });
          }
        }
      }
      return;
    }

    // 临时帧文件服务（供 Vision API 下载，frpc 转发到公网）
    if (req.method === "GET" && (req.url || "").startsWith("/tmp-frames/")) {
      try {
        const filename = (req.url || "").split("/tmp-frames/")[1]?.split("?")[0] || "";
        // 安全校验：只允许字母/数字/连字符/下划线/点，防止路径穿越
        if (!filename || !/^[\w\-]+\.jpg$/.test(filename)) {
          safeResponse(400, { error: "invalid_filename" });
          return;
        }
        const filePath = path.join(process.cwd(), "tmp", "telegram-attachments", filename);
        const realPath = path.resolve(filePath);
        const allowedDir = path.resolve(process.cwd(), "tmp", "telegram-attachments");
        if (!realPath.startsWith(allowedDir)) {
          safeResponse(403, { error: "forbidden" });
          return;
        }
        const fileBuffer = await fs.promises.readFile(realPath);
        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": fileBuffer.length });
        res.end(fileBuffer);
      } catch {
        safeResponse(404, { error: "tmp_frame_not_found" });
      }
      return;
    }

    safeResponse(404, { error: "not_found" });
  });

  const wss = new WebSocketServer({ noServer: true });

  // P0-NEW-5修复: WebSocket 僵尸连接检测
  const WS_PING_INTERVAL_MS = 30000; // 30秒发一次 ping
  const WS_PONG_TIMEOUT_MS = 10000;  // 10秒内没 pong 视为死连接

  wss.on("connection", (socket) => {
    log("info", "canvas.client.connected", { clients: canvasClients.size + 1 });
    canvasClients.add(socket);

    // P0-NEW-5修复: 心跳检测 - 标记连接存活
    let isAlive = true;

    socket.on("pong", () => {
      isAlive = true;
    });

    socket.on("close", () => {
      canvasClients.delete(socket);
      log("info", "canvas.client.disconnected", { clients: canvasClients.size });
    });

    socket.on("error", (err) => {
      log("warn", "canvas.client.error", { error: String(err) });
      canvasClients.delete(socket);
      try { socket.terminate(); } catch {}
    });

    socket.on("message", (data) => {
      log("info", "canvas.message", { data: data.toString() });
    });

    // P0-NEW-5修复: 定期 ping 检测僵尸连接
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        log("warn", "canvas.client.zombie_detected", { clients: canvasClients.size });
        canvasClients.delete(socket);
        clearInterval(pingInterval);
        try { socket.terminate(); } catch {}
        return;
      }
      isAlive = false;
      try { socket.ping(); } catch {
        canvasClients.delete(socket);
        clearInterval(pingInterval);
      }
    }, WS_PING_INTERVAL_MS);

    // 连接关闭时清理 ping 定时器
    socket.on("close", () => {
      clearInterval(pingInterval);
    });
  });

  // Dashboard WebSocket：实时推送群聊事件
  const dashboardClients = new Set<WebSocket>();
  const dashboardWss = new WebSocketServer({ noServer: true });

  dashboardWss.on("connection", (socket) => {
    dashboardClients.add(socket);
    socket.on("close", () => dashboardClients.delete(socket));
    socket.on("error", () => { dashboardClients.delete(socket); try { socket.terminate(); } catch {} });
  });

  // 统一路由 WebSocket upgrade 请求（ws 库多实例必须用 noServer 手动分发）
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/canvas") {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    } else if (pathname === "/dashboard/ws") {
      dashboardWss.handleUpgrade(request, socket, head, (ws) => dashboardWss.emit("connection", ws, request));
    } else {
      socket.destroy();
    }
  });

  dashboardBus.on("message", (event) => {
    const data = JSON.stringify(event);
    for (const client of dashboardClients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(data); } catch { dashboardClients.delete(client); }
      }
    }
  });

  const voiceWake = new VoiceWakeService({
    enabled: process.env.VOICE_WAKE_ENABLED === "true",
    accessKey: process.env.PORCUPINE_ACCESS_KEY,
    keyword: process.env.VOICE_WAKE_KEYWORD,
    onWake: async () => {
      log("info", "voicewake.callback");
      const message = JSON.stringify({
        type: "html",
        html: "<div style=\"color:#fff;font-size:18px;\">Wake detected ✅</div>"
      });
      // P0-NEW-5修复: send 失败时自动清理僵尸连接
      for (const client of canvasClients) {
        if (client.readyState === client.OPEN) {
          try {
            client.send(message);
          } catch {
            canvasClients.delete(client);
            try { client.terminate(); } catch {}
          }
        }
      }
    }
  });

  // 优化：捕获语音唤醒服务的异步错误
  voiceWake.start().catch(error => {
    logError(new JPClawError({
      code: ErrorCode.SYSTEM_INTERNAL,
      message: "Voice wake service start failed",
      cause: error instanceof Error ? error : undefined
    }));
  });

  // 初始化监控系统
  initializeMonitoring(config);

  if (process.env.JPCLAW_SCHEDULER_ENABLED === "true") {
    startScheduler();
    log("info", "scheduler.started", { intervalMs: process.env.JPCLAW_SCHEDULER_INTERVAL_MS || "60000" });
  }

  server.listen(config.gateway.port, config.gateway.host, () => {
    log("info", "gateway.started", {
      host: config.gateway.host,
      port: config.gateway.port
    });

    // 阶段4 优化：启动后自动运行 Benchmark（生成初始报告）
    // 默认启用，但生产环境建议禁用（JPCLAW_AUTO_BENCHMARK=false）
    const isProduction = process.env.NODE_ENV === "production";
    const benchmarkEnv = process.env.JPCLAW_AUTO_BENCHMARK;

    // 决策逻辑：
    // - 明确设置 JPCLAW_AUTO_BENCHMARK=true → 强制启用
    // - 明确设置 JPCLAW_AUTO_BENCHMARK=false → 强制禁用
    // - 未设置：生产环境禁用，开发环境启用
    const shouldRunBenchmark = benchmarkEnv === "true" ||
                               (benchmarkEnv !== "false" && !isProduction);

    if (shouldRunBenchmark) {
      // 优化：延迟 30 秒运行，避免启动后立即占用资源
      const delaySeconds = Number(process.env.JPCLAW_BENCHMARK_DELAY) || 30;

      log("info", "benchmark.auto_run.scheduled", {
        delaySeconds,
        environment: isProduction ? "production" : "development"
      });

      setTimeout(async () => {
        try {
          log("info", "benchmark.auto_run.start", { trigger: "gateway_startup" });
          const { BenchmarkRunner } = await import("../benchmark/runner.js");
          const runner = new BenchmarkRunner();
          const report = await runner.run();

          log("info", "benchmark.auto_run.complete", {
            grade: report.grade.overall,
            duration: report.duration,
            correctness: (report.metrics.correctness.overall * 100).toFixed(1) + "%",
            aiNative: (report.metrics.aiNative.aiDriven * 100).toFixed(1) + "%"
          });

          console.log("\n✅ Benchmark 初始报告已生成");
          console.log(`   访问 Dashboard: http://${config.gateway.host}:${config.gateway.port}/dashboard\n`);
        } catch (error) {
          log("warn", "benchmark.auto_run.failed", {
            error: error instanceof Error ? error.message : String(error)
          });
          console.log("\n⚠️  Benchmark 自动运行失败（不影响服务）");
          console.log(`   可手动运行: npm run benchmark\n`);
        }
      }, delaySeconds * 1000);
    } else {
      log("info", "benchmark.auto_run.disabled", {
        reason: isProduction ? "production_mode" : "explicit_disable"
      });
    }
  });

  // 阶段 5.3：优雅关闭函数
  const shutdown: ShutdownFunction = async () => {
    log("info", "gateway.shutdown.start");
    console.log("\n🛑 开始优雅关闭...\n");

    try {
      // 1. 停止接受新连接（P0-10修复：等待server.close完成）
      console.log("  • 停止接受新连接...");
      await new Promise<void>((resolve) => {
        server.close(() => {
          log("info", "gateway.shutdown.server_closed");
          resolve();
        });
      });

      // 2. 优雅关闭所有 WebSocket 连接
      console.log("  • 关闭 WebSocket 连接...");

      // 优化：先暂停接收新消息
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          // 暂停接收（如果支持）
          const pausableClient = client as unknown as { pause?: () => void };
          if (typeof pausableClient.pause === 'function') {
            pausableClient.pause();
          }
        }
      });

      // 等待发送队列清空（最多 1 秒）
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 关闭所有连接
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1001, "Server shutting down");
        }
      });
      wss.close();

      // 3. 停止 Telegram polling
      if (telegram.getStatus().enabled) {
        console.log("  • 停止 Telegram polling...");
        telegram.stop();
        log("info", "gateway.shutdown.telegram_stopped");
      }

      // 4. Discord 连接状态记录（P0-10改进：记录最终状态）
      if (discordBots.length > 0) {
        console.log("  • Discord Bots 将自动断开连接...");
        discordBots.forEach((bot, idx) => {
          try {
            const status = bot.getStatus();
            log("info", "gateway.shutdown.discord_bot_status", {
              index: idx,
              enabled: status.enabled,
              connected: status.connected,
              user: status.user
            });
          } catch (error) {
            log("warn", "gateway.shutdown.discord_bot_status_error", {
              index: idx,
              error: String(error)
            });
          }
        });
      }

      // 4. 保存缓存和内存数据（P0-10修复：显式保存向量数据）
      console.log("  • 保存内存数据...");
      try {
        // 保存向量存储（如果有未保存的数据）
        await vectorMemoryStore.flush();
        log("info", "gateway.shutdown.vector_store_saved");
      } catch (error) {
        log("error", "gateway.shutdown.vector_store_save_failed", {
          error: String(error)
        });
      }

      // 5. 关闭心跳服务
      if (heartbeat) {
        console.log("  • 关闭心跳服务...");
        heartbeat.stop();
      }

      // 5.5. 优化：清理监控和安全资源
      console.log("  • 清理系统资源...");
      try {
        const { destroyMetrics } = await import("../monitoring/metrics.js");
        destroyMetrics();
      } catch (error) {
        log("warn", "gateway.shutdown.metrics_cleanup_failed", { error: String(error) });
      }

      try {
        const { destroySecurity } = await import("../security/middleware.js");
        destroySecurity();
      } catch (error) {
        log("warn", "gateway.shutdown.security_cleanup_failed", { error: String(error) });
      }

      // 6. 等待所有活跃请求完成（最多等待 10 秒）
      console.log("  • 等待活跃请求完成...");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      log("info", "gateway.shutdown.complete");
      console.log("\n✅ 优雅关闭完成\n");
    } catch (error) {
      log("error", "gateway.shutdown.error", {
        error: error instanceof Error ? error.message : String(error)
      });
      console.error("\n❌ 关闭过程中发生错误");
      console.error(error instanceof Error ? error.stack : String(error));
      throw error;
    }
  };

  return shutdown;
}

/**
 * 初始化监控系统
 */
function initializeMonitoring(config: JPClawConfig): void {
  log("info", "Initializing monitoring system...");

  // 为AI提供商添加健康检查
  for (const provider of config.providers) {
    if (provider.type === "anthropic" && provider.baseUrl) {
      // Anthropic 没有公开的健康检查端点，我们可以创建一个简单的连接测试
      healthMonitor.register({
        name: `provider_anthropic`,
        description: "Check Anthropic API connectivity",
        check: async () => {
          const startTime = Date.now();
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            // 尝试连接到 API 端点 (不发送实际请求)
            const response = await fetch(provider.baseUrl || "https://api.anthropic.com", {
              method: 'HEAD',
              signal: controller.signal,
              headers: { 'User-Agent': 'JPClaw-HealthCheck/1.0' }
            });
            
            clearTimeout(timeoutId);
            
            return {
              status: "healthy" as const,
              message: "Anthropic API is reachable",
              details: { baseUrl: provider.baseUrl },
              timestamp: Date.now(),
              duration: Date.now() - startTime
            };
          } catch (error) {
            return {
              status: "degraded" as const,
              message: "Anthropic API connectivity issue",
              details: { error: String(error), baseUrl: provider.baseUrl },
              timestamp: Date.now(),
              duration: Date.now() - startTime
            };
          }
        },
        timeout: 10000,
        interval: 120000, // 2分钟
        critical: true
      });
    }

    if (provider.type === "openai" && provider.baseUrl) {
      healthMonitor.register({
        name: `provider_openai`, 
        description: "Check OpenAI API connectivity",
        check: async () => {
          const startTime = Date.now();
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(provider.baseUrl || "https://api.openai.com", {
              method: 'HEAD',
              signal: controller.signal,
              headers: { 'User-Agent': 'JPClaw-HealthCheck/1.0' }
            });
            
            clearTimeout(timeoutId);
            
            return {
              status: "healthy" as const,
              message: "OpenAI API is reachable",
              details: { baseUrl: provider.baseUrl },
              timestamp: Date.now(),
              duration: Date.now() - startTime
            };
          } catch (error) {
            return {
              status: "degraded" as const,
              message: "OpenAI API connectivity issue", 
              details: { error: String(error), baseUrl: provider.baseUrl },
              timestamp: Date.now(),
              duration: Date.now() - startTime
            };
          }
        },
        timeout: 10000,
        interval: 120000, // 2分钟
        critical: true
      });
    }
  }

  // 添加会话存储健康检查
  healthMonitor.register({
    name: "sessions_storage",
    description: "Check sessions directory accessibility",
    check: async () => {
      const startTime = Date.now();
      try {
        const sessionsDir = path.resolve(process.cwd(), "sessions");
        const testFile = path.join(sessionsDir, "health_check_test.tmp");
        
        // 确保目录存在
        fs.mkdirSync(sessionsDir, { recursive: true });
        
        // 测试写入
        fs.writeFileSync(testFile, "health check");
        
        // 测试读取
        const content = fs.readFileSync(testFile, 'utf-8');
        
        // 清理测试文件
        fs.unlinkSync(testFile);
        
        if (content === "health check") {
          return {
            status: "healthy" as const,
            message: "Sessions storage is accessible",
            details: { path: sessionsDir },
            timestamp: Date.now(),
            duration: Date.now() - startTime
          };
        } else {
          return {
            status: "unhealthy" as const,
            message: "Sessions storage read/write mismatch",
            timestamp: Date.now(),
            duration: Date.now() - startTime
          };
        }
      } catch (error) {
        return {
          status: "unhealthy" as const,
          message: "Sessions storage is not accessible",
          details: { error: String(error) },
          timestamp: Date.now(),
          duration: Date.now() - startTime
        };
      }
    },
    timeout: 5000,
    interval: 60000, // 1分钟
    critical: true
  });

  // 添加向量记忆系统健康检查
  healthMonitor.register({
    name: "vector_memory",
    description: "Check vector memory system health",
    check: async () => {
      const startTime = Date.now();
      try {
        const stats = vectorMemoryStore.getStatistics();
        
        return {
          status: "healthy" as const,
          message: "Vector memory system operational",
          details: {
            totalVectors: stats.totalVectors,
            userCount: stats.userCount,
            averageImportance: stats.averageImportance
          },
          timestamp: Date.now(),
          duration: Date.now() - startTime
        };
      } catch (error) {
        return {
          status: "unhealthy" as const,
          message: "Vector memory system error",
          details: { error: String(error) },
          timestamp: Date.now(),
          duration: Date.now() - startTime
        };
      }
    },
    timeout: 5000,
    interval: 300000, // 5分钟
    critical: false
  });

  // 添加冲突解决系统健康检查
  healthMonitor.register({
    name: "conflict_resolver",
    description: "Check conflict resolution system health",
    check: async () => {
      const startTime = Date.now();
      try {
        // 简单的系统状态检查
        const testUserId = "health_check_user";
        const summary = conflictResolver.getConflictSummary(testUserId);
        
        return {
          status: "healthy" as const,
          message: "Conflict resolver operational",
          details: { systemResponsive: true },
          timestamp: Date.now(),
          duration: Date.now() - startTime
        };
      } catch (error) {
        return {
          status: "unhealthy" as const,
          message: "Conflict resolver error",
          details: { error: String(error) },
          timestamp: Date.now(),
          duration: Date.now() - startTime
        };
      }
    },
    timeout: 5000,
    interval: 600000, // 10分钟
    critical: false
  });

  log("info", "Monitoring system initialized");
}
