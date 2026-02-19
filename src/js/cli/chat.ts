import http from "node:http";
import { loadConfig } from "../shared/config.js";

/**
 * 格式化响应输出，美化 skill 返回的 JSON
 */
function formatResponse(response: string): string {
  // 检测是否包含 [skill:xxx] 标记
  const skillMatch = response.match(/^\[skill:([^\]]+)\]\s*([\s\S]*)/);

  if (!skillMatch) {
    // 不是 skill 响应，直接返回
    return response;
  }

  const skillName = skillMatch[1];
  const content = skillMatch[2].trim();

  // 尝试解析 JSON
  try {
    const jsonData = JSON.parse(content);

    // 构建格式化输出
    let output = `🔧 技能：${skillName}\n\n`;

    // 提取并显示主要结果
    if (jsonData.result) {
      output += jsonData.result;
    } else if (jsonData.error) {
      output += `❌ 错误：${jsonData.error}`;
    } else {
      // 如果没有 result 或 error 字段，显示格式化的 JSON
      output += JSON.stringify(jsonData, null, 2);
    }

    // 添加元信息（可选）
    const metadata: string[] = [];
    if (jsonData.provider) metadata.push(`提供商: ${jsonData.provider}`);
    if (jsonData.traceId) metadata.push(`追踪ID: ${jsonData.traceId}`);

    if (metadata.length > 0) {
      output += `\n\n---\n💡 ${metadata.join(' | ')}`;
    }

    return output;
  } catch (error) {
    // JSON 解析失败，返回原始内容
    return response;
  }
}

/**
 * 通过HTTP调用gateway的/chat接口发送查询
 */
export async function sendChatMessage(query: string, options: {
  userId?: string;
  userName?: string;
  channelId?: string;
} = {}): Promise<string> {
  const config = loadConfig();
  const host = config.gateway.host || "127.0.0.1";
  const port = config.gateway.port || 8341;

  const payload = JSON.stringify({
    input: query,
    userId: options.userId || "cli-test-user",
    userName: options.userName || "CLI Test",
    channelId: options.channelId || "cli-channel"
  });

  // 准备请求头
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(payload))
  };

  // 添加认证token（如果存在）
  const adminToken = process.env.JPCLAW_ADMIN_TOKEN;
  const apiKeys = process.env.JPCLAW_API_KEYS;

  if (adminToken) {
    headers["x-admin-token"] = adminToken;
  } else if (apiKeys) {
    headers["x-api-key"] = apiKeys.split(",")[0];
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port: port,
        path: "/chat",
        method: "POST",
        headers,
        timeout: 300000 // 300秒超时（支持图像生成等耗时任务）
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const result = JSON.parse(body);
              resolve(result.output || "");
            } catch (error) {
              reject(new Error(`Failed to parse response: ${body}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout (300s)"));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * CLI命令: jpclaw chat "你的查询"
 */
export async function runChatCommand(args: string[]): Promise<number> {
  const query = args.join(" ");

  if (!query) {
    console.log("用法: jpclaw chat <查询内容>");
    console.log("");
    console.log("示例:");
    console.log("  jpclaw chat \"搜索一下今天的科技新闻\"");
    console.log("  jpclaw chat \"附近有什么咖啡馆\"");
    console.log("  jpclaw chat \"查询北京的天气\"");
    return 1;
  }

  console.log(`\n📤 发送查询: "${query}"\n`);

  try {
    const startTime = Date.now();
    const response = await sendChatMessage(query);
    const duration = Date.now() - startTime;

    console.log(`📥 JPClaw 回复 (${duration}ms):\n`);
    console.log(formatResponse(response));
    console.log("");

    return 0;
  } catch (error) {
    console.error(`\n❌ 错误: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error("提示:");
    console.error("  - 确保 gateway 正在运行: jpclaw gateway");
    console.error("  - 检查配置: jpclaw doctor");
    console.error("");
    return 1;
  }
}
