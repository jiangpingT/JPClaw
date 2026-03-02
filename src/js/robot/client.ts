/**
 * JPRobot HTTP API 客户端
 *
 * 调用 JPRobot 控制服务器（端口 18792）生成机器人仿真 GIF。
 * JPROBOT_CONTROL_URL 可通过 .env 覆盖（兼容远程部署）。
 */

const JPROBOT_CONTROL_URL =
  process.env.JPROBOT_CONTROL_URL ?? "http://localhost:18792";

/**
 * 发送动作命令到 JPRobot 仿真服务，返回 GIF 二进制数据。
 * @param command 中文动作描述，例如 "向左走10步"
 */
export async function simulateRobot(command: string): Promise<Buffer> {
  const response = await fetch(`${JPROBOT_CONTROL_URL}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(30_000), // 30s 超时，足够仿真+GIF生成
  });
  if (!response.ok) {
    throw new Error(`JPRobot simulate failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
