/**
 * Discord 协作编排器（已废弃）
 *
 * ⚠️  此文件已被新的无状态多Bot系统取代
 * @deprecated 使用 discord-multi-bot.ts 和 bot-roles.ts 替代
 *
 * 保留此文件仅为向后兼容，实际功能已移至新系统
 */

import type { Message, Client } from "discord.js";
import { log } from "../shared/logger.js";

/**
 * 空的协作编排器（向后兼容占位符）
 */
export class CollaborationOrchestrator {
  registerBot(_userId: string, _agentId: string): void {
    log("warn", "discord.collaboration.deprecated", {
      message: "CollaborationOrchestrator已废弃，请使用新的多Bot系统"
    });
  }

  async detectBotsInChannel(_client: Client, _channelId: string): Promise<any[]> {
    return [];
  }

  async initCollaboration(
    _client: Client,
    _message: Message,
    _initiatorBotUserId: string
  ): Promise<void> {
    // No-op
  }

  async onBotReplied(
    _client: Client,
    _originalMessageId: string,
    _botUserId: string,
    _replyMessage: Message
  ): Promise<void> {
    // No-op
  }

  isCollaborationTrigger(_message: Message): boolean {
    return false;
  }

  cleanup(): void {
    // No-op
  }
}

// 全局单例（向后兼容）
export const collaborationOrchestrator = new CollaborationOrchestrator();
