import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const JPROBOT_URL = process.env.JPROBOT_CONTROL_URL ?? "http://localhost:18792";

export async function run(input) {
  const command = String(input ?? "").trim();
  if (!command) {
    return JSON.stringify({ type: "robot_gif_error", message: "请告诉我人形机器人要做什么动作" });
  }

  // 确保命令包含"人形"关键词，让 control_server 走人形路由
  const robotCommand = command.includes("人形") || command.includes("humanoid")
    ? command
    : `人形机器人 ${command}`;

  let response;
  try {
    response = await fetch(`${JPROBOT_URL}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: robotCommand }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    return JSON.stringify({ type: "robot_gif_error", message: `无法连接机器人服务：${String(err)}` });
  }

  if (!response.ok) {
    return JSON.stringify({ type: "robot_gif_error", message: `仿真失败：HTTP ${response.status}` });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const fileName = `humanoid-${crypto.randomUUID().slice(0, 8)}.gif`;
  const filePath = join(tmpdir(), fileName);
  await writeFile(filePath, buffer);

  return JSON.stringify({ type: "robot_gif", filePath, command: robotCommand });
}
