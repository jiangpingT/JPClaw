/**
 * Test Routing 命令 - 技能路由测试
 */

import { runTestRoutingCommand } from "../test-routing.js";

export async function run(args: string[]): Promise<number> {
  return runTestRoutingCommand(args);
}
