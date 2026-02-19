/**
 * CLI 命令注册系统
 * 提供延迟加载和模块化的命令管理
 */

export interface CliCommand {
  name: string;
  description: string;
  run: (args: string[]) => Promise<number>;
}

export interface CliCommandEntry {
  name: string;
  description: string;
  loader: () => Promise<{ run: (args: string[]) => Promise<number> }>;
}

/**
 * CLI 命令注册表
 */
export class CliRegistry {
  private commands = new Map<string, CliCommandEntry>();

  /**
   * 注册命令
   */
  register(entry: CliCommandEntry): void {
    if (this.commands.has(entry.name)) {
      throw new Error(`命令 '${entry.name}' 已经注册`);
    }
    this.commands.set(entry.name, entry);
  }

  /**
   * 批量注册命令
   */
  registerAll(entries: CliCommandEntry[]): void {
    for (const entry of entries) {
      this.register(entry);
    }
  }

  /**
   * 获取命令
   */
  get(name: string): CliCommandEntry | undefined {
    return this.commands.get(name);
  }

  /**
   * 获取所有命令
   */
  getAll(): CliCommandEntry[] {
    return Array.from(this.commands.values());
  }

  /**
   * 运行命令
   */
  async run(name: string, args: string[]): Promise<number> {
    const entry = this.get(name);
    if (!entry) {
      console.error(`❌ 未知命令: ${name}`);
      console.error(`\n运行 'jpclaw help' 查看可用命令\n`);
      return 1;
    }

    try {
      // 延迟加载命令模块
      const module = await entry.loader();
      return await module.run(args);
    } catch (error) {
      console.error(`\n❌ 命令执行失败: ${name}`);
      console.error(error instanceof Error ? error.message : String(error));
      console.error("");
      return 1;
    }
  }

  /**
   * 显示帮助信息
   */
  showHelp(): void {
    console.log("\n📦 JPClaw CLI\n");
    console.log("用法: jpclaw <命令> [选项]\n");
    console.log("可用命令:\n");

    const commands = this.getAll().sort((a, b) => a.name.localeCompare(b.name));
    const maxNameLength = Math.max(...commands.map(c => c.name.length));

    for (const cmd of commands) {
      const padding = " ".repeat(maxNameLength - cmd.name.length + 2);
      console.log(`  ${cmd.name}${padding}${cmd.description}`);
    }

    console.log("\n示例:");
    console.log("  jpclaw gateway      # 启动网关服务");
    console.log("  jpclaw doctor       # 运行健康检查");
    console.log("  jpchat 你好世界     # 命令行聊天");
    console.log("");
  }
}

/**
 * 全局 CLI 注册表实例
 */
export const cliRegistry = new CliRegistry();

/**
 * 注册核心命令
 */
export function registerCoreCommands(): void {
  cliRegistry.registerAll([
    {
      name: "gateway",
      description: "启动网关服务",
      loader: () => import("./commands/gateway.js")
    },
    {
      name: "chat",
      description: "命令行聊天（已弃用，请使用 jpchat）",
      loader: () => import("./commands/chat.js")
    },
    {
      name: "doctor",
      description: "运行健康检查",
      loader: () => import("./commands/doctor.js")
    },
    {
      name: "test-routing",
      description: "运行技能路由测试",
      loader: () => import("./commands/test-routing.js")
    },
    {
      name: "help",
      description: "显示帮助信息",
      loader: async () => ({
        run: async () => {
          cliRegistry.showHelp();
          return 0;
        }
      })
    }
  ]);
}
