#!/usr/bin/env tsx
/**
 * Discord 多Bot协作系统测试（V2 - 无状态观察者模式）
 *
 * 用法：tsx test-multi-bot-v2.ts "你的测试问题"
 *
 * 测试场景：
 * 1. Bot1 (expert) 立即回答用户问题
 * 2. Bot2 (critic) 观察3秒后，AI决定是否质疑
 * 3. Bot3 (thinker) 观察6秒后，AI决定是否深度分析
 *
 * 核心特性：
 * - 无状态：不维护协作上下文
 * - AI驱动：Bot2/Bot3通过AI自主决定参与
 * - 无通信：Bot之间不直接通信，避免循环
 */

import { loadConfig } from "./src/js/shared/config.js";
import { PiEngine } from "./src/js/pi/engine.js";
import {
  getRoleConfig,
  formatConversationHistory,
  aiDecideParticipation
} from "./src/js/channels/bot-roles.js";

/**
 * 模拟对话历史
 */
interface ConversationMessage {
  author: string;
  content: string;
  isBot: boolean;
  timestamp: Date;
}

/**
 * 测试单个Bot的行为
 */
async function testBot(
  botName: string,
  agentId: string,
  userQuestion: string,
  conversationHistory: ConversationMessage[]
) {
  console.log("=".repeat(80));
  console.log(`🤖 测试 ${botName} (${agentId})`);
  console.log("=".repeat(80));

  const config = loadConfig();
  const roleConfig = getRoleConfig(agentId);

  console.log(`📋 角色配置:`);
  console.log(`  名称: ${roleConfig.name}`);
  console.log(`  描述: ${roleConfig.description}`);
  console.log(`  策略: ${roleConfig.participationStrategy}`);
  console.log(`  观察延迟: ${roleConfig.observationDelay}ms`);
  console.log();

  const engine = new PiEngine(config, agentId);

  if (roleConfig.participationStrategy === "always_user_question") {
    // Bot1: 总是回答用户问题
    console.log(`✅ ${botName} 作为 expert，立即回答用户问题`);
    console.log();

    const startTime = Date.now();

    try {
      const response = await engine.reply(userQuestion, {
        userId: "test_user",
        userName: "测试用户",
        channelId: "test_channel",
        agentId
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(`⏱️  用时: ${duration}s`);
      console.log();
      console.log("💬 回复:");
      console.log("┌────────────────────────────────────────────────────");
      console.log(response);
      console.log("└────────────────────────────────────────────────────");
      console.log();

      // 添加到对话历史
      conversationHistory.push({
        author: botName,
        content: response,
        isBot: true,
        timestamp: new Date()
      });

      return response;
    } catch (error) {
      console.error(`❌ ${botName} 回复失败:`, error);
      throw error;
    }
  } else if (roleConfig.participationStrategy === "ai_decide") {
    // Bot2/Bot3: 观察后AI决策
    console.log(`⏳ ${botName} 进入观察期，延迟 ${roleConfig.observationDelay}ms...`);

    // 模拟观察延迟
    await new Promise(resolve => setTimeout(resolve, roleConfig.observationDelay));

    console.log();
    console.log(`🔍 观察期结束，开始分析对话历史...`);
    console.log();

    // 格式化对话历史
    const formattedHistory = formatConversationHistory(conversationHistory);

    console.log("📜 对话历史:");
    console.log("┌────────────────────────────────────────────────────");
    console.log(formattedHistory);
    console.log("└────────────────────────────────────────────────────");
    console.log();

    // AI决策
    console.log(`🤔 ${botName} 正在通过AI判断是否参与讨论...`);

    const decisionStartTime = Date.now();

    const decision = await aiDecideParticipation(
      engine,
      roleConfig,
      formattedHistory
    );

    const decisionTime = ((Date.now() - decisionStartTime) / 1000).toFixed(2);

    console.log();
    console.log(`🎯 AI决策结果 (用时 ${decisionTime}s):`);
    console.log(`  是否参与: ${decision.shouldParticipate ? "YES ✅" : "NO ❌"}`);
    console.log(`  原因: ${decision.reason}`);
    console.log();

    if (!decision.shouldParticipate) {
      console.log(`⏭️  ${botName} 决定不参与讨论`);
      console.log();
      return null;
    }

    // 参与讨论
    console.log(`✅ ${botName} 决定参与讨论`);
    console.log();

    const fullPrompt = `${formattedHistory}\n\n---\n\n你是【${roleConfig.name}】，${roleConfig.description}。请从你的角色出发，对上述对话进行回应。`;

    const replyStartTime = Date.now();

    try {
      const response = await engine.reply(fullPrompt, {
        userId: "system",
        userName: roleConfig.name,
        channelId: "test_channel",
        agentId
      });

      const replyTime = ((Date.now() - replyStartTime) / 1000).toFixed(2);

      console.log(`⏱️  回复用时: ${replyTime}s`);
      console.log();
      console.log("💬 回复:");
      console.log("┌────────────────────────────────────────────────────");
      console.log(response);
      console.log("└────────────────────────────────────────────────────");
      console.log();

      // 添加到对话历史
      conversationHistory.push({
        author: botName,
        content: response,
        isBot: true,
        timestamp: new Date()
      });

      return response;
    } catch (error) {
      console.error(`❌ ${botName} 回复失败:`, error);
      throw error;
    }
  }
}

/**
 * 主测试流程
 */
async function runTest(userQuestion: string) {
  console.log("╔" + "═".repeat(78) + "╗");
  console.log("║" + " ".repeat(15) + "Discord 多Bot协作系统测试 (V2)" + " ".repeat(15) + "║");
  console.log("╚" + "═".repeat(78) + "╝");
  console.log();
  console.log(`📝 用户问题: ${userQuestion}`);
  console.log();

  const conversationHistory: ConversationMessage[] = [];

  // 添加用户问题到历史
  conversationHistory.push({
    author: "测试用户",
    content: userQuestion,
    isBot: false,
    timestamp: new Date()
  });

  const bots = [
    { name: "JPClaw", agentId: "expert" },
    { name: "JPClaw2", agentId: "critic" },
    { name: "JPClaw3", agentId: "thinker" }
  ];

  const overallStartTime = Date.now();

  try {
    for (const bot of bots) {
      await testBot(bot.name, bot.agentId, userQuestion, conversationHistory);
    }

    const totalTime = ((Date.now() - overallStartTime) / 1000).toFixed(2);

    console.log("╔" + "═".repeat(78) + "╗");
    console.log("║" + " ".repeat(32) + "测试完成" + " ".repeat(32) + "║");
    console.log("╚" + "═".repeat(78) + "╝");
    console.log();
    console.log(`⏱️  总用时: ${totalTime}s`);
    console.log(`💬 消息总数: ${conversationHistory.length}`);
    console.log();
    console.log("📋 完整对话历史:");
    console.log(formatConversationHistory(conversationHistory));
    console.log();
  } catch (error) {
    console.error("\n❌ 测试失败:", error);
    throw error;
  }
}

// 获取命令行参数
const userQuestion = process.argv[2] || "人工智能是否会取代人类？";

runTest(userQuestion)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("测试执行失败:", error);
    process.exit(1);
  });
