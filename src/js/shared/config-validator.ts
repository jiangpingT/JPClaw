/**
 * 配置验证系统 - 运行时验证
 *
 * 在启动时验证配置的可用性和正确性
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger.js";
import type { JPClawConfig } from "./config-schema.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ValidationOptions {
  checkPortAvailability?: boolean;
  checkFilePermissions?: boolean;
  checkNetworkConnectivity?: boolean;
}

/**
 * 完整配置验证（启动时调用）
 */
export async function validateRuntimeConfig(
  config: JPClawConfig,
  options: ValidationOptions = {}
): Promise<ValidationResult> {
  const {
    checkPortAvailability = true,
    checkFilePermissions = true,
    checkNetworkConnectivity = false
  } = options;

  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 端口可用性检查
  if (checkPortAvailability) {
    const portResult = await checkPortAvailable(config.gateway.port, config.gateway.host);
    if (!portResult.available) {
      errors.push(`端口 ${config.gateway.port} 已被占用${portResult.process ? ` (进程: ${portResult.process})` : ""}`);
    }
  }

  // 2. 数据目录权限检查
  if (checkFilePermissions) {
    const dirResult = checkDirectoryPermissions(config.dataDir);
    if (!dirResult.readable || !dirResult.writable) {
      errors.push(`数据目录 ${config.dataDir} 权限不足 (可读: ${dirResult.readable}, 可写: ${dirResult.writable})`);
    }
    if (dirResult.created) {
      warnings.push(`数据目录 ${config.dataDir} 不存在，已自动创建`);
    }
  }

  // 3. 必需目录创建
  const requiredDirs = [
    config.dataDir,
    path.join(process.cwd(), "benchmark-reports"),
    path.join(process.cwd(), "log")
  ];

  for (const dir of requiredDirs) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (error) {
      errors.push(`创建目录失败: ${dir} - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 4. API Key 验证（基础检查）
  for (const provider of config.providers) {
    if (provider.type === "anthropic" && !provider.apiKey) {
      errors.push(`Anthropic provider 缺少 API Key`);
    }
    if (provider.type === "openai" && !provider.apiKey) {
      warnings.push(`OpenAI provider 缺少 API Key（如果使用本地模型可忽略）`);
    }
  }

  // 5. Discord 配置验证
  const discordConfig = config.channels.discord;
  if (discordConfig) {
    if (Array.isArray(discordConfig)) {
      // 多 Bot 模式
      for (let i = 0; i < discordConfig.length; i++) {
        const bot = discordConfig[i];
        if (bot.enabled && !bot.token) {
          errors.push(`Discord Bot #${i + 1} (${bot.name || "未命名"}) 已启用但缺少 token`);
        }
      }
    } else {
      // 单 Bot 模式
      if (discordConfig.enabled && !discordConfig.token) {
        errors.push(`Discord Bot 已启用但缺少 token`);
      }
    }
  }

  // 6. 网络连接测试（可选，较慢）
  if (checkNetworkConnectivity) {
    const anthropicProvider = config.providers.find(p => p.type === "anthropic");
    if (anthropicProvider?.apiKey) {
      const anthropicResult = await testAnthropicConnection(anthropicProvider.apiKey);
      if (!anthropicResult.success) {
        warnings.push(`Anthropic API 连接测试失败: ${anthropicResult.error}`);
      }
    }

    if (discordConfig) {
      const discordResult = await testDiscordConnection();
      if (!discordResult.success) {
        warnings.push(`Discord 网关连接测试失败: ${discordResult.error}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * 检查端口是否可用
 */
async function checkPortAvailable(port: number, host: string): Promise<{ available: boolean; process?: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({ available: false, process: undefined });
      } else {
        resolve({ available: false });
      }
    });

    server.once("listening", () => {
      server.close();
      resolve({ available: true });
    });

    server.listen(port, host);
  });
}

/**
 * 检查目录权限
 */
function checkDirectoryPermissions(dirPath: string): {
  readable: boolean;
  writable: boolean;
  created: boolean;
} {
  let created = false;

  // 确保目录存在
  if (!fs.existsSync(dirPath)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      created = true;
    } catch {
      return { readable: false, writable: false, created: false };
    }
  }

  // 检查读写权限
  try {
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    return { readable: true, writable: true, created };
  } catch {
    // 尝试单独检查
    const readable = fs.existsSync(dirPath);
    const writable = (() => {
      try {
        const testFile = path.join(dirPath, `.write-test-${Date.now()}`);
        fs.writeFileSync(testFile, "test");
        fs.unlinkSync(testFile);
        return true;
      } catch {
        return false;
      }
    })();
    return { readable, writable, created };
  }
}

/**
 * 测试 Anthropic API 连接
 */
async function testAnthropicConnection(apiKey: string): Promise<{ success: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    // 任何非 5xx 响应都说明连接正常（包括 401 认证错误）
    if (response.status < 500) {
      return { success: true };
    } else {
      return { success: false, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { success: false, error: "连接超时" };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 测试 Discord 网关连接
 */
async function testDiscordConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("https://discord.com/api/v10/gateway", {
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { success: false, error: "连接超时" };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 打印验证结果
 */
export function printValidationResult(result: ValidationResult): void {
  if (result.valid) {
    console.log("\n✅ 配置验证通过\n");
  } else {
    console.error("\n❌ 配置验证失败\n");
  }

  if (result.errors.length > 0) {
    console.error("错误：");
    result.errors.forEach((err) => console.error(`  • ${err}`));
    console.error("");
  }

  if (result.warnings.length > 0) {
    console.warn("警告：");
    result.warnings.forEach((warn) => console.warn(`  ⚠️  ${warn}`));
    console.warn("");
  }

  if (!result.valid) {
    log("error", "config.validation_failed", {
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
      errors: result.errors
    });
  } else if (result.warnings.length > 0) {
    log("warn", "config.validation_warnings", {
      warningCount: result.warnings.length,
      warnings: result.warnings
    });
  } else {
    log("info", "config.validation_passed");
  }
}
