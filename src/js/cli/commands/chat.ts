/**
 * Chat 命令 - 命令行聊天（已弃用）
 */

import { runChatCommand } from "../chat.js";

export async function run(args: string[]): Promise<number> {
  // 只在直接通过 'jpclaw chat' 调用时显示弃用警告
  // 通过 'jpchat' 调用时会设置 JPCHAT_COMMAND 环境变量
  if (!process.env.JPCHAT_COMMAND) {
    console.warn("\n⚠️  'jpclaw chat' 已弃用，请使用 'jpchat' 代替\n");
    console.warn("  示例: jpchat 你好世界\n");
  }

  return runChatCommand(args);
}
