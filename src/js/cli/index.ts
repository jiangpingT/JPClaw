#!/usr/bin/env node
import { loadEnv } from "../shared/env.js";

// CRITICAL: Load env BEFORE any other imports that might use proxy settings
// pi-ai module loads http-proxy.js at import time, which reads process.env
loadEnv();

import { cliRegistry, registerCoreCommands } from "./registry.js";
import { log } from "../shared/logger.js";

const args = process.argv.slice(2);

// ============================================================================
// 全局错误处理器（阶段 1.1：防御性加固）
// ============================================================================

/**
 * 捕获未处理的 Promise rejection
 * 这些通常是 async 函数中未捕获的错误
 */
process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  log("error", "global.unhandled_rejection", {
    reason: String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: String(promise)
  });

  // 注意：不要退出进程，让应用继续运行
  // 特别是 Discord Bot 等长期运行的服务，不应因为单个异常而崩溃
  console.error("\n⚠️  捕获到未处理的 Promise rejection，已记录到日志");
});

/**
 * 捕获未捕获的异常
 * 这些是同步代码中抛出的未捕获错误
 */
process.on("uncaughtException", (error: Error) => {
  log("error", "global.uncaught_exception", {
    error: String(error),
    stack: error.stack,
    message: error.message
  });

  console.error("\n❌ 捕获到未捕获的异常，进程即将退出");
  console.error(error.stack || error.message);
  console.error("\n💡 建议：检查日志文件获取详细错误信息\n");

  // uncaughtException 表示程序状态可能已损坏，应该优雅退出
  // 给异步操作一些时间完成日志写入
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

async function main(): Promise<void> {
  // 注册核心命令
  registerCoreCommands();

  const command = args[0];

  // 如果没有命令或者是 help，显示帮助
  if (!command || command === "help" || command === "--help" || command === "-h") {
    cliRegistry.showHelp();
    process.exit(0);
  }

  // 运行命令
  const exitCode = await cliRegistry.run(command, args.slice(1));
  process.exit(exitCode);
}

main().catch((error) => {
  log("error", "cli.error", { error: String(error) });
  console.error("\n❌ CLI 执行失败");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  process.exit(1);
});
