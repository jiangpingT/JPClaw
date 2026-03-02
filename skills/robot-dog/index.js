import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const JPROBOT_URL = process.env.JPROBOT_CONTROL_URL ?? "http://localhost:18792";

export async function run(input) {
  const command = String(input ?? "").trim();
  if (!command) {
    return JSON.stringify({ type: "robot_gif_error", message: "请告诉我机器狗要做什么动作" });
  }

  let response;
  try {
    response = await fetch(`${JPROBOT_URL}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return JSON.stringify({ type: "robot_gif_error", message: `无法连接机器狗服务：${String(err)}` });
  }

  if (!response.ok) {
    return JSON.stringify({ type: "robot_gif_error", message: `仿真失败：HTTP ${response.status}` });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const fileName = `robot-${crypto.randomUUID().slice(0, 8)}.gif`;
  const filePath = join(tmpdir(), fileName);
  await writeFile(filePath, buffer);

  return JSON.stringify({ type: "robot_gif", filePath, command });
}
