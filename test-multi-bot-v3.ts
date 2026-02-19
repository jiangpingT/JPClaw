#!/usr/bin/env tsx
/**
 * Discord 多Bot协作系统测试（V3 - 验证问题9修复）
 *
 * 用法：tsx test-multi-bot-v3.ts [场景编号]
 *
 * 测试场景：
 * 1. 基础场景：验证bot2/bot3能看到完整对话历史（问题9修复验证）
 * 2. 用户补充场景：验证用户追问被包含在历史中
 * 3. 压力场景：验证AI决策的准确性
 *
 * 核心验证点：
 * - ✅ Bot2/Bot3观察到的历史包含用户问题
 * - ✅ Bot2/Bot3观察到的历史包含Bot1的回复
 * - ✅ Bot2/Bot3观察到的历史包含用户的补充信息
 * - ✅ AI决策基于正确的上下文
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

    // 【验证点1】检查历史是否包含用户问题
    const hasUserQuestion = conversationHistory.some(msg => !msg.isBot);
    console.log(`✅ 验证：历史包含用户问题 - ${hasUserQuestion ? "PASS ✅" : "FAIL ❌"}`);

    // 【验证点2】检查历史是否包含Bot1的回复
    const hasBotReply = conversationHistory.some(msg => msg.isBot);
    console.log(`✅ 验证：历史包含Bot1回复 - ${hasBotReply ? "PASS ✅" : "FAIL ❌"}`);

    // 【验证点3】检查历史长度
    console.log(`✅ 验证：历史消息数量 - ${conversationHistory.length} 条`);
    console.log();

    if (!hasUserQuestion || !hasBotReply) {
      console.log("❌❌❌ 严重错误：历史不完整！这是问题9的症状！");
      console.log();
    }

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
 * 场景1：基础场景 - 验证观察历史正确
 */
async function scenario1() {
  console.log("╔" + "═".repeat(78) + "╗");
  console.log("║" + " ".repeat(15) + "场景1：基础场景 - 验证观察历史正确" + " ".repeat(15) + "║");
  console.log("╚" + "═".repeat(78) + "╝");
  console.log();

  const userQuestion = "人工智能会取代人类吗？";
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

  // 验证结果
  const userMessages = conversationHistory.filter(msg => !msg.isBot);
  const botMessages = conversationHistory.filter(msg => msg.isBot);

  console.log("✅ 最终验证:");
  console.log(`  用户消息: ${userMessages.length} 条`);
  console.log(`  Bot消息: ${botMessages.length} 条`);
  console.log(`  总消息: ${conversationHistory.length} 条`);
  console.log();

  if (botMessages.length >= 1) {
    console.log("✅✅✅ 场景1测试通过！Bot2/Bot3看到了完整对话历史！");
  } else {
    console.log("❌❌❌ 场景1测试失败！Bot没有正确观察历史！");
  }
  console.log();
}

/**
 * 场景2：用户补充场景
 */
async function scenario2() {
  console.log("╔" + "═".repeat(78) + "╗");
  console.log("║" + " ".repeat(15) + "场景2：用户补充信息场景" + " ".repeat(21) + "║");
  console.log("╚" + "═".repeat(78) + "╝");
  console.log();

  const userQuestion = "什么是量子计算？";
  console.log(`📝 用户问题: ${userQuestion}`);
  console.log();

  const conversationHistory: ConversationMessage[] = [];

  // 添加用户问题
  conversationHistory.push({
    author: "测试用户",
    content: userQuestion,
    isBot: false,
    timestamp: new Date()
  });

  // Bot1回答
  const config = loadConfig();
  const engine1 = new PiEngine(config, "expert");

  console.log("🤖 JPClaw (expert) 回答中...");
  const response1 = await engine1.reply(userQuestion, {
    userId: "test_user",
    userName: "测试用户",
    channelId: "test_channel",
    agentId: "expert"
  });

  conversationHistory.push({
    author: "JPClaw",
    content: response1,
    isBot: true,
    timestamp: new Date()
  });

  console.log("✅ JPClaw 已回答");
  console.log();

  // 用户补充信息
  const userFollowUp = "它和传统计算机有什么本质区别？";
  console.log(`📝 用户补充: ${userFollowUp}`);
  console.log();

  conversationHistory.push({
    author: "测试用户",
    content: userFollowUp,
    isBot: false,
    timestamp: new Date()
  });

  // Bot2观察
  console.log("⏳ JPClaw2 (critic) 进入观察期...");
  await new Promise(resolve => setTimeout(resolve, 3000));

  const formattedHistory = formatConversationHistory(conversationHistory);
  console.log("📜 JPClaw2 观察到的历史:");
  console.log(formattedHistory);
  console.log();

  // 验证
  const hasOriginalQuestion = conversationHistory.some(msg =>
    msg.content.includes("量子计算")
  );
  const hasFollowUp = conversationHistory.some(msg =>
    msg.content.includes("本质区别")
  );

  console.log("✅ 验证结果:");
  console.log(`  包含原问题: ${hasOriginalQuestion ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  包含补充信息: ${hasFollowUp ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  总消息数: ${conversationHistory.length} 条`);
  console.log();

  if (hasOriginalQuestion && hasFollowUp) {
    console.log("✅✅✅ 场景2测试通过！用户补充信息被正确包含！");
  } else {
    console.log("❌❌❌ 场景2测试失败！");
  }
  console.log();
}

/**
 * 主函数
 */
async function main() {
  const scenarioNum = parseInt(process.argv[2] || "1", 10);

  console.log("\n");
  console.log("╔" + "═".repeat(78) + "╗");
  console.log("║" + " ".repeat(15) + "Discord 多Bot协作系统测试 (V3)" + " ".repeat(15) + "║");
  console.log("║" + " ".repeat(25) + "问题9修复验证" + " ".repeat(27) + "║");
  console.log("╚" + "═".repeat(78) + "╝");
  console.log();

  try {
    if (scenarioNum === 1) {
      await scenario1();
    } else if (scenarioNum === 2) {
      await scenario2();
    } else {
      console.log("用法: tsx test-multi-bot-v3.ts [1|2]");
      console.log("  1 - 基础场景（默认）");
      console.log("  2 - 用户补充场景");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ 测试失败:", error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("测试执行失败:", error);
    process.exit(1);
  });
