/**
 * Gateway 命令 - 启动网关服务
 */

import { startGateway } from "../../gateway/index.js";
import { loadConfig } from "../../shared/config.js";
import { validateRuntimeConfig, printValidationResult } from "../../shared/config-validator.js";
import { log } from "../../shared/logger.js";

export async function run(args: string[]): Promise<number> {
  console.log("🚀 启动 JPClaw Gateway...\n");

  let shutdown: (() => Promise<void>) | null = null;

  try {
    // 阶段 5.1：配置验证
    console.log("📋 验证配置...");
    const config = loadConfig();

    const validationResult = await validateRuntimeConfig(config, {
      checkPortAvailability: true,
      checkFilePermissions: true,
      checkNetworkConnectivity: false // 默认关闭，避免启动过慢
    });

    printValidationResult(validationResult);

    if (!validationResult.valid) {
      console.error("\n💡 建议:");
      console.error("  • 运行 'jpclaw doctor' 进行详细诊断");
      console.error("  • 检查 .env 文件中的配置项");
      console.error("");
      return 1;
    }

    shutdown = await startGateway();

    // 阶段 5.3：优雅关闭 - 保持进程运行，等待终止信号
    await new Promise<void>((resolve) => {
      const handleShutdown = async () => {
        console.log('\n\n👋 收到停止信号...\n');
        resolve();
      };

      process.on('SIGINT', handleShutdown);
      process.on('SIGTERM', handleShutdown);
    });

    // 执行优雅关闭
    if (shutdown) {
      await shutdown();
    }

    return 0;
  } catch (error) {
    console.error("\n❌ Gateway 启动失败");
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n💡 建议:");
    console.error("  • 运行 'jpclaw doctor' 检查配置");
    console.error("  • 检查端口是否被占用");
    console.error("");

    // 尝试清理资源
    if (shutdown) {
      try {
        await shutdown();
      } catch (cleanupError) {
        log("error", "gateway.cleanup_failed", {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        });
      }
    }

    return 1;
  }
}
