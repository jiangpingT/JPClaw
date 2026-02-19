/**
 * Doctor 命令 - 健康检查
 */

import { runDoctor } from "../doctor.js";

export async function run(args: string[]): Promise<number> {
  return runDoctor();
}
