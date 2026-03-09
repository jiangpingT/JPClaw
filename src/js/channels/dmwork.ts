/**
 * DMWork 渠道入口
 *
 * 根据配置启动一个或多个 DMWork Bot，返回 start/stop/getStatus 接口。
 */

import type { ChatEngine } from "../core/engine.js";
import { DmworkBotHandler, type DmworkBotConfig } from "./dmwork-bot-handler.js";
import { log } from "../shared/logger.js";

export type { DmworkBotConfig };

export interface DmworkRuntime {
  start(): void;
  stop(): void;
  getStatus(): { enabled: boolean; connected: boolean; robotId: string; name?: string };
}

export function startDmworkChannel(
  config: DmworkBotConfig | DmworkBotConfig[] | undefined,
  agent: ChatEngine
): DmworkRuntime {
  if (!config) {
    log("info", "dmwork.disabled");
    return makeNoop();
  }

  // 多 bot 模式
  if (Array.isArray(config)) {
    if (config.length === 0) {
      log("info", "dmwork.disabled");
      return makeNoop();
    }

    log("info", "dmwork.multi_bot.mode_detected", {
      botCount: config.length,
      bots: config.map(b => ({ name: b.name, robotId: b.robotId }))
    });

    // 收集所有 robotId + 显示名，传给每个 handler 做 peer 识别与 @mention 归属
    const allRobotIds = config.map(c => c.robotId);
    const peerBotNames = new Map(config.map(c => [c.robotId, c.name ?? c.robotId]));

    const handlers = config
      .filter(c => c.enabled && c.botToken && c.imToken)
      .map(c => {
        const peerIds = allRobotIds.filter(id => id !== c.robotId);
        const h = new DmworkBotHandler(c, agent, peerIds, peerBotNames);
        h.start();
        log("info", "dmwork.started", { robotId: c.robotId, name: c.name });
        return h;
      });

    if (handlers.length === 0) return makeNoop();

    return {
      start: () => handlers.forEach(h => h.start()),
      stop: () => handlers.forEach(h => h.stop()),
      getStatus: () => handlers[0].getStatus(),
    };
  }

  // 单 bot 模式（向后兼容）
  if (!config.enabled || !config.botToken || !config.imToken) {
    log("info", "dmwork.disabled");
    return makeNoop();
  }

  const handler = new DmworkBotHandler(config, agent);
  handler.start();
  log("info", "dmwork.started", { robotId: config.robotId, name: config.name });

  return {
    start: () => handler.start(),
    stop: () => handler.stop(),
    getStatus: () => handler.getStatus(),
  };
}

function makeNoop(): DmworkRuntime {
  return {
    start: () => {},
    stop: () => {},
    getStatus: () => ({ enabled: false, connected: false, robotId: "" }),
  };
}
