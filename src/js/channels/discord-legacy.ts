import type { Client, Message } from "discord.js";
import { exec } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProxyAgent } from "undici";
import type { ChannelConfig, DiscordBotConfig } from "../shared/config.js";
import type { ChatEngine } from "../core/engine.js";
import type { AgentRouterAdminApi } from "../agents/router.js";
import { log } from "../shared/logger.js";
import { loadEnv } from "../shared/env.js";
import { resolveMessageChunkLimit, splitTextIntoChunks } from "../shared/text-chunk.js";
import { appendDiscordFeedback } from "../feedback/discord-feedback.js";
import { tryHandleOpsCommand } from "./ops.js";
import { searchWebWithOptions } from "../tools/web.js";
import { runSkill } from "../skills/registry.js";
import { maybeRunSkillFirst } from "./skill-router.js";
import { collaborationOrchestrator } from "./discord-collaboration.js";
import { looksLikeDocumentSummaryIntent, maybeHandleDocumentSummaryIntent } from "./document-intent.js";
import { looksLikeCapabilityMetaQuestion } from "./intent-classifier.js";
import { classifyOffTargetReply } from "./reply-guard.js";
import { MediaProcessor } from "../media/processor.js";
import { DiscordAttachmentProcessor } from "./discord-attachment-processor.js";
import { writeFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";

// Ensure .env is loaded before evaluating module-level env-derived constants.
loadEnv();

export type DiscordStatus = {
  enabled: boolean;
  connected: boolean;
  attempts: number;
  retryInMs: number | null;
  user?: string;
  lastError?: string;
};

export type DiscordRuntime = {
  getStatus: () => DiscordStatus;
  sendDm?: (userId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
};

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const FAST_ACK_MS = Number(process.env.DISCORD_FAST_ACK_MS || "850");
// Soft timeout: after this we notify the user we're still working, but we keep waiting for the result.
const WORK_TIMEOUT_MS = Number(process.env.DISCORD_WORK_TIMEOUT_MS || "45000");
const DISCORD_MESSAGE_LIMIT = resolveMessageChunkLimit("discord", 1900);
const DISCORD_SEND_TIMEOUT_MS = Number(process.env.DISCORD_SEND_TIMEOUT_MS || "12000");
// Hard close: if work is stuck too long, stop waiting and send a final fallback.
const DISCORD_HARD_CLOSE_MS = Number(process.env.DISCORD_HARD_CLOSE_MS || "300000");
const DEDUPE_WINDOW_MS = Number(process.env.DISCORD_DEDUPE_WINDOW_MS || "3000");
const LOCAL_OPS_CONFIRM_TTL_MS = Number(process.env.DISCORD_LOCAL_OPS_CONFIRM_TTL_MS || "600000");
const OWNER_USER_ID = process.env.JPCLAW_OWNER_DISCORD_ID || "1351911386602672133";

// 全局附件处理器实例（统一处理语音、文档、图片附件）
const attachmentProcessor = new DiscordAttachmentProcessor({
  proxyUrl: process.env.DISCORD_PROXY_URL
});
const DISCORD_REPLY_MODE = (process.env.DISCORD_REPLY_MODE || "mention_or_dm").toLowerCase();
const DISCORD_ALLOWED_CHANNEL_IDS = new Set(
  (process.env.DISCORD_ALLOWED_CHANNEL_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const DOWNLOADS_DIR = process.env.JPCLAW_DOWNLOADS_DIR || `${os.homedir()}/Downloads`;
const REPLAY_LOG_FILE = path.resolve(process.cwd(), "log", "discord-replay.log");
const lastAckByUser = new Map<string, number>();
const lastFeedbackAckByUser = new Map<string, number>();
const lastReactionAckAt = new Map<string, number>();
const REACTION_ACK_COOLDOWN_MS = Number(process.env.DISCORD_REACTION_ACK_COOLDOWN_MS || "60000");
const inFlightRequests = new Map<string, { startedAt: number; traceId: string }>();

// P1-11修复：Discord 背压控制
const MAX_INFLIGHT_REQUESTS = Number(process.env.DISCORD_MAX_INFLIGHT_REQUESTS || "100");
let droppedRequestsCount = 0;

// P0-NEW-2修复：定期清理过期的 inFlightRequests（防止极端情况下的内存泄漏）
const INFLIGHT_MAX_AGE_MS = 10 * 60 * 1000; // 10分钟
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of inFlightRequests.entries()) {
    if (now - value.startedAt > INFLIGHT_MAX_AGE_MS) {
      inFlightRequests.delete(key);
      cleaned++;
    }
  }
  // 同时清理过期的 pendingLocalOps
  for (const [userId, op] of pendingLocalOpsByUser.entries()) {
    if (now > op.expiresAt) {
      pendingLocalOpsByUser.delete(userId);
    }
  }
  // 清理过期的 ack 记录
  for (const [key, ts] of lastAckByUser.entries()) {
    if (now - ts > 300000) lastAckByUser.delete(key); // 5分钟
  }
  for (const [key, ts] of lastFeedbackAckByUser.entries()) {
    if (now - ts > 300000) lastFeedbackAckByUser.delete(key);
  }
  for (const [key, ts] of lastReactionAckAt.entries()) {
    if (now - ts > 300000) lastReactionAckAt.delete(key);
  }
  if (cleaned > 0) {
    log("warn", "discord.inflight.stale_cleanup", { cleaned, remaining: inFlightRequests.size });
  }
}, 60000).unref(); // 每分钟清理一次，unref 允许进程正常退出
const pendingLocalOpsByUser = new Map<
  string,
  { token: string; expiresAt: number; description: string; execute: () => string }
>();
type ReplyTrace = {
  id: string;
  userId: string;
  channelId: string;
  route: string;
};

type DiscordJs = typeof import("discord.js");
let discordJs: DiscordJs | null = null;
let discordWsProxyInstalled = false;

export function startDiscordChannel(
  config: ChannelConfig | DiscordBotConfig | undefined,
  agent: ChatEngine,
  adminApi?: AgentRouterAdminApi
): DiscordRuntime {
  const status: DiscordStatus = {
    enabled: Boolean(config?.enabled && config?.token),
    connected: false,
    attempts: 0,
    retryInMs: null
  };

  if (!config?.enabled || !config.token) {
    log("info", "discord.disabled");
    return {
      getStatus: () => ({ ...status })
    };
  }

  // 提取 bot 的频道白名单（如果配置了）
  const botChannels = (config as DiscordBotConfig).channels;
  const allowedChannelIds = botChannels ? new Set(botChannels) : new Set<string>();

  // P1-NEW-5修复: 启动时警告空白名单配置
  if (allowedChannelIds.size === 0) {
    log("warn", "discord.config.no_channel_whitelist", {
      message: "No channel whitelist configured. Bot will respond based on replyMode (default: DM or @mention only)."
    });
  }

  let client: Client | null = null;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryCount = 0;

  const baseReplyContextFor = (message: Message): { userId: string; userName: string; channelId: string; agentId?: string } => ({
    userId: message.author.id,
    userName: message.author.username,
    channelId: message.channelId,
    agentId: (config as DiscordBotConfig).agentId // Discord协作bot的角色ID
  });

  /**
   * 获取协作对话历史（通过消息引用链追溯）
   */
  const fetchCollaborationHistory = async (message: Message, client: Client): Promise<string> => {
    const history: Array<{ author: string; content: string; role?: string }> = [];
    let currentMessage: Message | null = message;
    const visited = new Set<string>();
    const maxDepth = 10; // 防止无限循环
    let depth = 0;

    try {
      // 向上追溯消息引用链
      while (currentMessage && depth < maxDepth) {
        if (visited.has(currentMessage.id)) break;
        visited.add(currentMessage.id);

        // 如果是 bot 的回复（不是触发消息），记录它
        if (currentMessage.author.bot && !collaborationOrchestrator.isCollaborationTrigger(currentMessage)) {
          const botNickname = currentMessage.member?.nickname || currentMessage.author.username;
          history.unshift({
            author: botNickname,
            content: currentMessage.content,
            role: botNickname
          });
        }

        // 如果是用户消息，记录它（这应该是原始问题）
        if (!currentMessage.author.bot) {
          history.unshift({
            author: currentMessage.author.username,
            content: currentMessage.content
          });
          break; // 找到用户的原始问题，停止追溯
        }

        // 获取引用的消息
        const refMessageId: string | undefined = currentMessage.reference?.messageId;
        if (refMessageId) {
          try {
            const channel: any = currentMessage.channel;
            if (channel && "messages" in channel) {
              currentMessage = await channel.messages.fetch(refMessageId);
              depth++;
            } else {
              break;
            }
          } catch (error) {
            log("warn", "discord.collaboration.history.fetch_failed", {
              messageId: refMessageId,
              error: String(error)
            });
            break;
          }
        } else {
          break;
        }
      }

      // 格式化历史消息
      if (history.length === 0) {
        return "";
      }

      const formattedHistory = history.map(msg => {
        const roleTag = msg.role ? ` [${msg.role}]` : "";
        return `【${msg.author}${roleTag}】：${msg.content}`;
      }).join("\n\n");

      log("info", "discord.collaboration.history.fetched", {
        messageCount: history.length,
        depth
      });

      return formattedHistory;
    } catch (error) {
      log("error", "discord.collaboration.history.failed", {
        error: String(error)
      });
      return "";
    }
  };

  const scheduleReconnect = (reason: string): void => {
    if (stopped || retryTimer) return;
    retryCount += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (retryCount - 1), RETRY_MAX_MS);
    status.retryInMs = delay;
    log("warn", "discord.reconnect.scheduled", { reason, delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const buildClient = async (): Promise<Client> => {
    const { Client, GatewayIntentBits, Partials } = await loadDiscordJs();
    // 简化：统一从 DISCORD_PROXY_URL 读取 HTTP 代理
    const proxyUrl = process.env.DISCORD_PROXY_URL;
    const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;

    const nextClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
      rest: proxyAgent ? { agent: proxyAgent } : undefined
    });

    nextClient.once("ready", async () => {
      status.connected = true;
      status.retryInMs = null;
      status.user = nextClient.user?.tag;
      status.lastError = undefined;
      retryCount = 0;
      log("info", "discord.ready", { user: nextClient.user?.tag });

      // 注册bot到协作编排器
      if (nextClient.user?.id) {
        const typedConfig = config as DiscordBotConfig;
        const agentId = typedConfig.agentId;
        if (agentId) {
          collaborationOrchestrator.registerBot(nextClient.user.id, agentId);
          log("info", "discord.collaboration.bot.registered", {
            botId: nextClient.user.id,
            botTag: nextClient.user.tag,
            agentId
          });

          // 设置服务器昵称为英文角色名称
          if (agentId) {
            for (const [guildId, guild] of nextClient.guilds.cache) {
              try {
                const member = await guild.members.fetch(nextClient.user.id);
                if (member && member.nickname !== agentId) {
                  await member.setNickname(agentId);
                  log("info", "discord.nickname.set", {
                    guildId,
                    guildName: guild.name,
                    botId: nextClient.user.id,
                    nickname: agentId
                  });
                }
              } catch (error) {
                log("warn", "discord.nickname.failed", {
                  guildId,
                  error: String(error)
                });
              }
            }
          }
        }
      }
    });

    nextClient.on("messageCreate", async (message) => {
      // 检查是否是协作触发消息（由协作编排器自动生成）
      const isCollabTrigger = collaborationOrchestrator.isCollaborationTrigger(message);

      // 允许协作触发消息通过，即使它来自 bot；其他 bot 消息一律过滤
      if (message.author.bot && !isCollabTrigger) return;

      // 如果是协作触发消息，只有被 @ 的 bot 才处理，其他 bot 忽略
      if (isCollabTrigger) {
        const botId = nextClient.user?.id;

        // 【修复无限循环】如果协作触发消息是当前 bot 自己发送的，跳过处理
        if (message.author.id === botId) {
          log("debug", "discord.collaboration.trigger.self_message", {
            botId,
            messageContent: message.content.substring(0, 50)
          });
          return;
        }

        const isMentioned = Boolean(botId) && message.mentions.users?.has(botId || "");
        if (!isMentioned) {
          log("debug", "discord.collaboration.trigger.not_for_me", {
            botId,
            messageContent: message.content.substring(0, 50)
          });
          return;
        }
      }

      // 【附件处理】处理语音、文档、图片附件
      let messageText = message.content?.trim() || "";

      if (!messageText && message.attachments?.size > 0) {
        // 没有文字内容，尝试处理附件
        const attachments = await attachmentProcessor.processAllAttachments(message);

        // 优先使用语音转录
        if (attachments.voiceTranscript) {
          messageText = attachments.voiceTranscript;
          log("info", "discord.voice.used_as_content", {
            userId: message.author.id,
            transcriptLength: messageText.length
          });
        }

        // 如果有文档附件，拼接内容
        if (attachments.documents?.length) {
          for (const doc of attachments.documents) {
            const truncatedText = doc.text.slice(0, 20000);
            messageText += `\n\n【附件文档：${doc.filename}】\n${truncatedText}`;
            if (doc.text.length > 20000) {
              messageText += `\n\n（文档过长，已截取前 20000 字符）`;
            }
          }
          log("info", "discord.document.used_as_content", {
            userId: message.author.id,
            count: attachments.documents.length
          });
        }
      }

      // 如果既没有文字内容也没有可转录的语音，跳过
      if (!messageText) return;

      let raw = messageText;

      // 【协作历史获取】如果是协作触发消息，获取对话历史并附加到raw中
      if (isCollabTrigger && nextClient) {
        const history = await fetchCollaborationHistory(message, nextClient);
        if (history) {
          raw = `${history}\n\n---\n\n${messageText}`;
          log("info", "discord.collaboration.history.attached", {
            originalLength: messageText.length,
            withHistoryLength: raw.length
          });
        }
      }

      // 【修复】协作触发消息强制使用 agent_reply 路由，避免误判为 local_ops
      const route = isCollabTrigger ? "agent_reply" : detectRoute(raw, message.author.id);
      log("info", "discord.route.decision", { input: raw, route, userId: message.author.id, isCollabTrigger });
      const trace = createTrace(message.author.id, message.channelId);
      trace.route = route;
      const dedupeKey = buildDedupeKey(message.author.id, raw, route);

      try {
        const isDm = !message.guildId;
        const botId = nextClient.user?.id;
        void captureReplyFeedback(message, botId);
        if (await maybeHandleFeedbackAck(message, botId)) {
          writeReplay(trace, "feedback_ack");
          return;
        }
        const isMentioned = Boolean(botId) && message.mentions.users?.has(botId || "");
        const isReplyToBot = Boolean(botId) && message.mentions.repliedUser?.id === botId;

        if (
          !shouldHandleDiscordMessage({
            replyMode: DISCORD_REPLY_MODE,
            isDm,
            isMentioned,
            isReplyToBot,
            route,
            channelId: message.channelId,
            userId: message.author.id,
            allowedChannelIds: allowedChannelIds // 使用 bot 自己的频道白名单
          })
        ) {
          log("info", "discord.message.ignored", {
            traceId: trace.id,
            reason: "not_addressed_or_channel_not_allowed",
            channelId: message.channelId,
            author: message.author.tag,
            isDm,
            isMentioned,
            isReplyToBot,
            route
          });
          return;
        }

        // Only dedupe commands that are safe to dedupe (not agent replies or content queries)
        if (route !== "downloads" && route !== "local_ops" && route !== "agent_reply") {
          const inFlight = inFlightRequests.get(dedupeKey);
          if (inFlight && Date.now() - inFlight.startedAt <= DEDUPE_WINDOW_MS) {
            log("info", "discord.request.deduped", {
              traceId: trace.id,
              previousTraceId: inFlight.traceId,
              channelId: message.channelId
            });
            writeReplay(trace, "deduped", { previousTraceId: inFlight.traceId });
            await message.reply("这条请求我正在处理中，马上给你结果🙂");
            return;
          }
        }

        // P1-11修复：检查是否超过最大并发处理数
        if (inFlightRequests.size >= MAX_INFLIGHT_REQUESTS) {
          droppedRequestsCount++;
          log("warn", "discord.message.queue_full", {
            traceId: trace.id,
            inFlightCount: inFlightRequests.size,
            maxInflight: MAX_INFLIGHT_REQUESTS,
            droppedTotal: droppedRequestsCount,
            userId: message.author.id,
            channelId: message.channelId
          });
          await message.reply("⚠️ 系统负载过高，请稍后再试。").catch(() => {});
          return;
        }

        inFlightRequests.set(dedupeKey, { startedAt: Date.now(), traceId: trace.id });
        log("info", "discord.message.received", {
          author: message.author.tag,
          channelId: message.channelId,
          traceId: trace.id,
          inFlightCount: inFlightRequests.size // P1-11修复：记录队列长度
        });
        writeReplay(trace, "received", { text: truncateForReplay(raw) });

        if (await tryHandleOpsCommand(message)) {
          inFlightRequests.delete(dedupeKey);
          writeReplay(trace, "handled_by_ops");
          return;
        }

        try {
        if (route === "agent_admin") {
          await respondWithFastAck(
            message,
            async () => {
              const out = handleAgentAdminCommand(message.author.id, message.channelId, raw, adminApi);
              agent.recordExternalExchange?.(raw, out, baseReplyContextFor(message));
              return out;
            },
            "抱歉，agent 管理命令执行失败，请稍后重试。",
            { ...trace, route },
            undefined
          );
          return;
        }

        if (route === "robot_control") {
          const command = raw.slice("/cat ".length).trim();
          await message.reply("正在生成机器人动画...");
          try {
            const { simulateRobot } = await import("../robot/client.js");
            const gif = await simulateRobot(command);
            await message.reply({
              files: [{ attachment: gif, name: "robot.gif" }],
              allowedMentions: { repliedUser: false }
            });
          } catch (err) {
            await message.reply(`机器人动画生成失败：${String(err)}`).catch(() => {});
          }
          return;
        }

        if (route === "downloads") {
          await respondWithFastAck(
            message,
            async () => {
              const out = await inspectDownloadsForAdmin(message.author.id, raw);
              agent.recordExternalExchange?.(raw, out, baseReplyContextFor(message));
              return out;
            },
            "抱歉，本地目录洞察暂时失败，请稍后再试。",
            { ...trace, route },
            undefined
          );
          return;
        }

        if (route === "local_ops") {
          await respondWithFastAck(
            message,
            async () => {
              const out = await handleLocalOps(message.author.id, raw);
              agent.recordExternalExchange?.(raw, out, baseReplyContextFor(message));
              return out;
            },
            "抱歉，本地操作执行失败，请稍后重试。",
            { ...trace, route },
            undefined
          );
          return;
        }

        // Explicit web command: /web <query>
        if (route === "web_command") {
          const query = raw.slice(5).trim();
          await respondWithFastAck(
            message,
            async () => {
              const out = await searchWebWithOptions(query, { traceId: trace.id });
              agent.recordExternalExchange?.(raw, out, baseReplyContextFor(message));
              return out;
            },
            "抱歉，联网查询失败，我会继续改进。",
            { ...trace, route },
            undefined
          );
          return;
        }

        if (route === "weather") {
          log("warn", "discord.weather.unexpected", { input: raw, traceId: trace.id });
          await respondWithFastAck(
            message,
            async () => {
              const searchQuery = `${raw} 实时天气`;
              log("info", "discord.weather.search", { query: searchQuery, traceId: trace.id });
              const out = await searchWebWithOptions(searchQuery, { traceId: trace.id });
              agent.recordExternalExchange?.(raw, out, baseReplyContextFor(message));
              return out;
            },
            "抱歉，天气联网查询失败，我会继续改进。",
            { ...trace, route },
            undefined
          );
          return;
        }

        if (route === "search_intent") {
          await respondWithFastAck(
            message,
            async () => {
              const out = await searchWithRecovery(raw, trace.id);
              agent.recordExternalExchange?.(raw, out, baseReplyContextFor(message));
              return out;
            },
            "抱歉，联网查询失败，我会继续重试并优化检索链路。",
            { ...trace, route },
            undefined
          );
          return;
        }

        if (route === "social_stats") {
          await respondWithFastAck(
            message,
            async () => {
              const out = await handleSocialStats(raw);
              agent.recordExternalExchange?.(raw, out, baseReplyContextFor(message));
              return out;
            },
            "抱歉，社交主页统计查询失败，请稍后再试。",
            { ...trace, route },
            undefined
          );
          return;
        }

        // 【修改】不在用户消息时初始化协作，改为在expert回复后初始化
        // 用户消息只触发expert，不直接触发完整协作流程

        // 【修复协作上下文】构建reply上下文时，如果是协作触发消息，使用原始用户ID
        const replyContext = { ...baseReplyContextFor(message), traceId: trace.id };
        if (isCollabTrigger && nextClient?.user?.id) {
          // 从mentions中找到原始用户（排除bot）
          const botId = nextClient.user.id;
          const originalUser = Array.from(message.mentions.users.values())
            .find(user => !user.bot && user.id !== botId);

          if (originalUser) {
            replyContext.userId = originalUser.id;
            replyContext.userName = originalUser.username;
            log("debug", "discord.collaboration.context_override", {
              triggeredBot: botId,
              originalUser: originalUser.id,
              originalUserName: originalUser.username
            });
          }
        }

        await respondWithFastAck(
          message,
          async () => replyWithRecovery(agent, raw, replyContext),
          "抱歉，我这次处理失败了，我会尽快修复。",
          { ...trace, route: "agent_reply" },
          nextClient
        );
        } finally {
          inFlightRequests.delete(dedupeKey);
        }
      } catch (error) {
        inFlightRequests.delete(dedupeKey);
        log("error", "discord.message.unhandled", {
          traceId: trace.id,
          channelId: message.channelId,
          route,
          error: String(error)
        });
        writeReplay(trace, "error", { error: String(error), stage: "unhandled" });
        await withTimeout(
          message.reply("抱歉，这条消息处理时出现异常，我已记录并继续修复。请再试一次。"),
          DISCORD_SEND_TIMEOUT_MS
        ).catch(() => {});
      }
    });

    nextClient.on("shardDisconnect", (event, shardId) => {
      status.connected = false;
      status.lastError = `shard ${shardId} disconnected (${event.code})`;
      scheduleReconnect("shard_disconnect");
    });

    nextClient.on("shardError", (error, shardId) => {
      status.connected = false;
      status.lastError = `shard ${shardId} error: ${String(error)}`;
      scheduleReconnect("shard_error");
    });

    nextClient.on("error", (error) => {
      status.connected = false;
      status.lastError = String(error);
      log("error", "discord.client.error", { error: String(error) });
      scheduleReconnect("client_error");
    });

    nextClient.on("messageReactionAdd", async (reaction, user) => {
      try {
        if (user.bot) return;
        if (reaction.partial) await reaction.fetch();
        const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
        const botId = nextClient.user?.id;
        if (!botId || message.author?.id !== botId) return;
        const value = reaction.emoji?.name || reaction.emoji?.id || "";
        if (!value) return;
        appendDiscordFeedback({
          userId: user.id,
          channelId: message.channelId,
          kind: "reaction",
          value,
          messageId: message.id
        });
        await maybeAckReactionFeedback(message, user.id, value);
      } catch {
        // ignore feedback collection errors
      }
    });

    return nextClient;
  };

  const sendDm = async (
    userId: string,
    text: string
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!client) return { ok: false, error: "discord_client_not_ready" };
    try {
      const user = await client.users.fetch(userId);
      const chunks = splitTextIntoChunks((text || "").trim(), { maxLength: DISCORD_MESSAGE_LIMIT });
      for (const chunk of chunks) {
        await withTimeout(user.send(chunk), DISCORD_SEND_TIMEOUT_MS);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    status.attempts += 1;
    status.retryInMs = null;
    status.connected = false;

    if (client) {
      try {
        client.removeAllListeners();
        client.destroy();
      } catch (error) {
        log("warn", "discord.client.destroy.failed", { error: String(error) });
      }
      client = null;
    }

    client = await buildClient();
    try {
      await client.login(config.token);
    } catch (error) {
      status.connected = false;
      status.lastError = String(error);
      log("error", "discord.login.failed", { error: String(error) });
      scheduleReconnect("login_failed");
    }
  };

  void connect();

  return {
    getStatus: () => ({ ...status }),
    sendDm
  };
}

// 旧的 downloadAttachment 和 processVoiceAttachment 函数已移至 DiscordAttachmentProcessor 类

async function loadDiscordJs(): Promise<DiscordJs> {
  if (discordJs) return discordJs;

  // CRITICAL: 必须在导入 discord.js 之前安装 WebSocket 代理
  await installDiscordWsProxyIfNeeded();

  discordJs = await import("discord.js");
  return discordJs;
}

function shouldHandleDiscordMessage(opts: {
  replyMode: string;
  isDm: boolean;
  isMentioned: boolean;
  isReplyToBot: boolean;
  route: string;
  channelId: string;
  userId: string;
  allowedChannelIds: Set<string>;
}): boolean {
  if (isAdminUser(opts.userId)) return true;

  // Only allow explicit command-like routes to bypass the DM/@ gating.
  // Heuristic routes like "search_intent"/"weather"/"social_stats" must still respect DM/@,
  // otherwise the bot will "autopilot reply" in channels.
  if (
    opts.route === "agent_admin" ||
    opts.route === "downloads" ||
    opts.route === "local_ops" ||
    opts.route === "web_command"
  ) {
    return true;
  }

  // Allow dedicated channels without requiring @mention.
  if (opts.allowedChannelIds.size > 0 && opts.allowedChannelIds.has(opts.channelId)) {
    return true;
  }

  const mode = (opts.replyMode || "").toLowerCase();
  if (mode === "all") return true;
  if (mode === "mention") return opts.isMentioned || opts.isReplyToBot;

  // Default: only respond in DMs or when explicitly addressed.
  return opts.isDm || opts.isMentioned || opts.isReplyToBot;
}

async function installDiscordWsProxyIfNeeded(): Promise<void> {
  // 使用 global-agent 全局代理，不再需要手动配置 WebSocket 代理
  // global-agent 会自动代理所有网络请求（HTTP/HTTPS/WebSocket）
  discordWsProxyInstalled = true;

  const proxyUrl = process.env.DISCORD_PROXY_URL;
  if (proxyUrl) {
    log("info", "discord.gateway.proxy.enabled", { proxyUrl: maskProxyUrl(proxyUrl) });
  }
}

function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? "***" : "";
      u.password = u.password ? "***" : "";
    }
    return u.toString();
  } catch {
    return "***";
  }
}

async function respondWithFastAck(
  message: Message,
  work: () => Promise<string>,
  fallbackOnError: string,
  trace: ReplyTrace,
  client?: Client
): Promise<void> {
  const startedAt = Date.now();
  log("info", "discord.reply.stage", { traceId: trace.id, stage: "start", route: trace.route });
  writeReplay(trace, "stage", { stage: "start" });
  let interim: Message | null = null;
  let done = false;
  let softNotified = false;
  let softTimer: NodeJS.Timeout | null = null;
  const hardCloseTimer = setTimeout(async () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (softTimer) clearTimeout(softTimer);
    log("warn", "discord.reply.stage", { traceId: trace.id, stage: "hard_close_triggered" });
    writeReplay(trace, "stage", { stage: "hard_close_triggered" });
    try {
      if (interim) {
        await safeEdit(interim, fallbackOnError, message);
      } else {
        await withTimeout(message.reply(fallbackOnError), DISCORD_SEND_TIMEOUT_MS);
      }
    } catch {
      // ignore final fallback send failure
    }
  }, DISCORD_HARD_CLOSE_MS);
  // 禁用立即响应（fast_ack），只在内容准备好后才回复
  const timer: NodeJS.Timeout | null = null;
  // const timer = setTimeout(async () => {
  //   if (done) return;
  //   try {
  //     interim = await message.reply(pickInterimAck(message.author.id));
  //     log("info", "discord.reply.stage", { traceId: trace.id, stage: "fast_ack_sent" });
  //     writeReplay(trace, "stage", { stage: "fast_ack_sent" });
  //   } catch {
  //     // ignore interim send errors and continue.
  //     log("warn", "discord.reply.stage", { traceId: trace.id, stage: "fast_ack_failed" });
  //     writeReplay(trace, "stage", { stage: "fast_ack_failed" });
  //   }
  // }, FAST_ACK_MS);

  try {
    // 禁用软超时提示，只在内容准备好后才回复
    // softTimer = setTimeout(async () => {
    //   if (done || softNotified) return;
    //   softNotified = true;
    //   const text = pickStillWorkingAck(message.author.id);
    //   try {
    //     if (interim) {
    //       await withTimeout(safeEdit(interim, text, message), DISCORD_SEND_TIMEOUT_MS);
    //     } else {
    //       interim = await withTimeout(message.reply(text), DISCORD_SEND_TIMEOUT_MS);
    //     }
    //     log("info", "discord.reply.stage", { traceId: trace.id, stage: "soft_timeout_notified" });
    //     writeReplay(trace, "stage", { stage: "soft_timeout_notified" });
    //   } catch {
    //     // ignore notification errors
    //   }
    // }, WORK_TIMEOUT_MS);

    // Do not hard-timeout the work itself; notify on soft timeout and keep waiting.
    const output = await work();
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (softTimer) clearTimeout(softTimer);
    clearTimeout(hardCloseTimer);
    log("info", "discord.reply.stage", { traceId: trace.id, stage: "work_done" });
    writeReplay(trace, "stage", { stage: "work_done" });
    const cleaned = cleanModelOutput(output || "");
    const baseText = cleaned?.trim() ? cleaned : "已处理完成，但没有可返回内容。";
    const text = optimizeForDiscordReading(baseText);
    if (interim) {
      // If we already soft-notified, prefer sending the final answer as a new message.
      if (softNotified) {
        await sendLongReply(message, text);
      } else {
        await safeEdit(interim, text, message);
      }
      log("info", "discord.reply.latency", {
        ms: Date.now() - startedAt,
        mode: softNotified ? "followup_after_soft_timeout" : "interim_edit",
        channelId: message.channelId,
        traceId: trace.id
      });
      log("info", "discord.reply.stage", { traceId: trace.id, stage: "done" });
      writeReplay(trace, "stage", { stage: "done" });

      // 触发协作编排器
      if (client && client.user?.id) {
        await collaborationOrchestrator.onBotReplied(
          client,
          message.id,
          client.user.id,
          interim
        );
      }
      return;
    }
    const replyMessage = await sendLongReply(message, text);
    log("info", "discord.reply.latency", {
      ms: Date.now() - startedAt,
      mode: "direct",
      channelId: message.channelId,
      traceId: trace.id
    });
    log("info", "discord.reply.stage", { traceId: trace.id, stage: "done" });
    writeReplay(trace, "stage", { stage: "done" });

    // 触发协作编排器
    if (client && client.user?.id && replyMessage) {
      await collaborationOrchestrator.onBotReplied(
        client,
        message.id,
        client.user.id,
        replyMessage
      );
    }
  } catch (error) {
    done = true;
    if (timer) clearTimeout(timer);
    if (softTimer) clearTimeout(softTimer);
    clearTimeout(hardCloseTimer);
    log("error", "discord.reply.error", { error: String(error), traceId: trace.id });
    writeReplay(trace, "error", { error: String(error) });
    if (interim) {
      await safeEdit(interim, fallbackOnError, message).catch(() => {});
      log("warn", "discord.reply.latency", {
        ms: Date.now() - startedAt,
        mode: "interim_error",
        channelId: message.channelId,
        traceId: trace.id
      });
      return;
    }
    await withTimeout(message.reply(fallbackOnError), DISCORD_SEND_TIMEOUT_MS).catch(() => {});
    log("warn", "discord.reply.latency", {
      ms: Date.now() - startedAt,
      mode: "direct_error",
      channelId: message.channelId,
      traceId: trace.id
    });
  }
}

async function safeEdit(interim: Message, text: string, original: Message): Promise<void> {
  const chunks = splitTextIntoChunks(text, { maxLength: DISCORD_MESSAGE_LIMIT });
  try {
    await withTimeout(interim.edit(chunks[0]), DISCORD_SEND_TIMEOUT_MS);
    for (let i = 1; i < chunks.length; i += 1) {
      await withTimeout(original.reply(chunks[i]), DISCORD_SEND_TIMEOUT_MS);
    }
  } catch {
    await sendLongReply(original, text);
  }
}

async function sendLongReply(message: Message, text: string): Promise<Message | undefined> {
  const chunks = splitTextIntoChunks(text, { maxLength: DISCORD_MESSAGE_LIMIT });
  let lastMessage: Message | undefined;
  for (const chunk of chunks) {
    lastMessage = await withTimeout(message.reply(chunk), DISCORD_SEND_TIMEOUT_MS);
  }
  return lastMessage;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Reply timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function replyWithRecovery(
  agent: ChatEngine,
  raw: string,
  context: { userId: string; userName: string; channelId: string; traceId: string; agentId?: string }
): Promise<string> {
  const docSummary = await maybeHandleDocumentSummaryIntent(agent, raw, context);
  if (docSummary) return docSummary;

  const skillRouted = await maybeRunSkillFirst(agent, raw, context);
  if (skillRouted) return skillRouted;

  log("info", "discord.reply.recovery", { traceId: context.traceId, stage: "primary_try" });
  try {
    const primary = await agent.reply(raw, context);
    const cleanedPrimary = cleanModelOutput(primary || "");
    if (cleanedPrimary?.trim()) {
      if (!looksLikePendingReply(cleanedPrimary)) {
        // 跳偏检测暂时禁用，避免误判技能咨询等正常问题
        return cleanedPrimary;
      }
      log("warn", "discord.reply.pending_detected", {
        channelId: context.channelId,
        userId: context.userId,
        traceId: context.traceId
      });
    }
  } catch (error) {
    log("warn", "discord.reply.primary_failed", {
      error: String(error),
      channelId: context.channelId,
      traceId: context.traceId
    });
  }

  // If user intent is search-like and the first answer sounds "to be continued",
  // force a concrete fallback via web retrieval so users don't wait for a non-existent 2nd push.
  if (looksLikeSearchIntent(raw)) {
    try {
      const web = await searchWebWithOptions(raw, { traceId: context.traceId });
      const cleanWeb = cleanModelOutput(web || "");
      if (cleanWeb.trim()) {
        return [
          "我直接给你当前可得结果（已做补救检索）：",
          cleanWeb
        ].join("\n\n");
      }
    } catch (error) {
      log("warn", "discord.reply.search_fallback_failed", {
        error: String(error),
        channelId: context.channelId,
        traceId: context.traceId
      });
    }
  }

  // Degrade to concise mode to reduce timeout probability.
  const concisePrompt = `请用简洁直接方式回答，不超过6条要点：${raw}`;
  const secondary = await agent.reply(concisePrompt, context);
  const cleanedSecondary = cleanModelOutput(secondary || "");
  if (cleanedSecondary?.trim()) {
    // 跳偏检测暂时禁用
    return cleanedSecondary;
  }
  return "我已尝试二次处理，但未拿到有效结果。";
}

function buildOffTargetCorrectionPrompt(
  raw: string,
  wrongOutput: string,
  reason:
    | "directory_listing"
    | "social_stats"
    | "sync_report"
    | "presence_ack"
    | "weather_report"
    | "auto_skill_template"
): string {
  const reasonText: Record<typeof reason, string> = {
    directory_listing: "你刚才返回了目录/文件列表，和用户问题不匹配。",
    social_stats: "你刚才返回了社交主页统计数据，和用户问题不匹配。",
    sync_report: "你刚才返回了代码仓库更新分析，和用户问题不匹配。",
    presence_ack: "你刚才只回复了在线占位语，没有回答问题。",
    weather_report: "你刚才返回了天气结果，和用户问题不匹配。",
    auto_skill_template: "你刚才返回了自动技能模板提示，和用户问题不匹配。"
  };
  return [
    "你刚才回答跑偏了，请立即修正。",
    `跑偏原因：${reasonText[reason]}`,
    `用户原问题：${raw}`,
    "",
    "修正规则：",
    "1) 直接回答原问题，不要切换到其他话题。",
    "2) 不要输出目录列表、社交统计、代码同步报告，除非用户明确要求。",
    "3) 如果信息不足，先给可执行的下一步，而不是泛化占位语。",
    "",
    `你刚才的错误回答（供你避免重复）：\n${wrongOutput}`,
    "",
    "现在给出修正后的最终答复："
  ].join("\n");
}

function hardFallbackForOffTarget(
  raw: string,
  reason:
    | "directory_listing"
    | "social_stats"
    | "sync_report"
    | "presence_ack"
    | "weather_report"
    | "auto_skill_template"
): string {
  const prefix = "我刚才回复跑偏了，这次直接按你的问题回答。";
  if (reason === "directory_listing") {
    return `${prefix}\n你的问题不是本地文件操作，我不会再返回目录列表。请允许我基于你的原问题继续给出直接结论：\n${raw}`;
  }
  if (reason === "social_stats") {
    return `${prefix}\n你的问题不是社交主页统计，我不会再返回粉丝/关注数据。请允许我按原问题直接回答：\n${raw}`;
  }
  if (reason === "sync_report") {
    return `${prefix}\n你的问题不是 OpenClaw 代码同步报告，我不会再返回仓库 diff。请允许我按原问题继续回答：\n${raw}`;
  }
  if (reason === "weather_report") {
    return `${prefix}\n你的问题不是天气查询，我不会再返回天气结果。请允许我按原问题继续回答：\n${raw}`;
  }
  if (reason === "auto_skill_template") {
    return `${prefix}\n你的问题不是要创建技能模板，我不会再返回 auto-skill 提示。请允许我按原问题继续回答：\n${raw}`;
  }
  return `${prefix}\n你的问题不是“是否在线”确认，我会直接回答你的原问题：\n${raw}`;
}

function pickInterimAck(userId: string): string {
  const ownerPhrases = [
    "姜哥，收到👌 我马上处理。",
    "好嘞姜哥，我正在查，马上回你 ✨",
    "收到姜哥，我这就去办，稍等我一下🙂",
    "姜哥我在处理中了，结果很快给你 📌"
  ];
  const normalPhrases = [
    "收到，我正在处理，马上给你结果。",
    "好的，已开始处理，稍等一下🙂",
    "明白，我这就查，结果很快回来 ✨",
    "已收到，正在执行，马上同步进展 📌"
  ];
  const pool = userId === OWNER_USER_ID ? ownerPhrases : normalPhrases;
  const prev = lastAckByUser.get(userId) ?? -1;
  let idx = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && idx === prev) {
    idx = (idx + 1) % pool.length;
  }
  lastAckByUser.set(userId, idx);
  return pool[idx];
}

function pickStillWorkingAck(userId: string): string {
  const ownerPhrases = [
    "姜哥，这条比预期复杂，我还在继续检索与整理，结果出来我会继续发。",
    "姜哥，我还在跑检索链路，先给你占位，马上把结果补上。",
    "姜哥，我还在核对信息，结果出来我会继续发。"
  ];
  const normalPhrases = [
    "这条问题我还在继续检索与整理，结果出来我会继续发。",
    "我还在处理，已进入第二阶段检索/核对，稍后补上结果。",
    "还在核对信息，结果出来我会继续发。"
  ];
  const pool = userId === OWNER_USER_ID ? ownerPhrases : normalPhrases;
  return pool[Math.floor(Math.random() * pool.length)];
}

function cleanModelOutput(text: string): string {
  if (!text) return text;
  let output = text;
  // 去掉 [skill:xxx] 内部标记（仅供测试检测用，不展示给用户）
  output = output.replace(/^\[skill:[^\]]+\]\n?/i, "");
  output = output.replace(/<search>[\s\S]*?<\/search>/gi, "");
  output = output.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "");
  output = output.replace(/^\s*<\/?[\w-]+>\s*$/gm, "");
  output = output.replace(/^\s*<query>.*<\/query>\s*$/gim, "");
  output = output.replace(/^(.*我.*(补充|更新).*)$/gim, "");
  output = output.replace(/^(.*(稍等|稍候|等一下|稍后).*)$/gim, "");
  output = output.replace(/^(.*(正在等|等待).*搜索引擎.*)$/gim, "");
  output = output.replace(/^(.*搜索完成后.*)$/gim, "");
  output = output.replace(/^\s*(如果你|如果您)\s*$/gim, "");
  output = output.replace(/\n{3,}/g, "\n\n").trim();
  return output;
}

function looksLikePendingReply(text: string): boolean {
  const pendingPatterns = [
    /我会.*(补充|完善|继续|更新)/i,
    /搜索完成后.*我会/i,
    /(稍等|稍候|等一下|稍后).*(我|给你|返回)/i,
    /(正在等|等待).*搜索引擎/i,
    /正在返回结果/i,
    /我先去查/i
  ];
  return pendingPatterns.some((p) => p.test(text));
}

function looksLikeSearchIntent(input: string): boolean {
  const q = input.toLowerCase();
  return (
    q.includes("联网") ||
    q.includes("搜索") ||
    q.includes("查询") ||
    q.includes("公开信息") ||
    q.includes("简历") ||
    q.includes("新闻") ||
    q.includes("动态") ||
    q.includes("近况") ||
    q.includes("最新")
  );
}

function looksLikeMapIntent(input: string): boolean {
  const q = input.toLowerCase();
  // Map/distance/navigation intent; route to search so we can try web retrieval.
  const hasMapWord = q.includes("地图") || q.includes("导航") || q.includes("路线") || q.includes("怎么走");
  const hasDistanceWord = q.includes("距离") || q.includes("多远") || q.includes("路程");
  const hasPlaceWord =
    q.includes("附近") ||
    q.includes("餐馆") ||
    q.includes("餐厅") ||
    q.includes("饭店") ||
    q.includes("面馆") ||
    q.includes("地址") ||
    q.includes("推荐");
  return (hasMapWord || hasDistanceWord) && hasPlaceWord;
}

function buildSearchQuery(input: string): string {
  const q = input.trim();
  const lower = q.toLowerCase();
  if (looksLikeMapIntent(q)) return `${q} 地图 距离`;
  if (lower.includes("新闻")) return `${q} 最新 新闻`;
  if (lower.includes("动态") || lower.includes("近况")) return `${q} 最新 动态`;
  if (lower.includes("公开信息")) return `${q} 官方 公开 信息`;
  return `${q} 最新`;
}

async function searchWithRecovery(raw: string, traceId: string): Promise<string> {
  const attempts = looksLikeMapIntent(raw)
    ? Array.from(
        new Set([
          buildSearchQuery(raw),
          `${raw} 高德地图 距离`,
          `${raw} 百度地图 距离`,
          `${raw} 附近 面馆 推荐`
        ])
      )
    : Array.from(new Set([buildSearchQuery(raw), `${raw} 新闻`, `${raw} 近况`, `${raw} 官方`]));
  let best: string | null = null;
  for (const q of attempts) {
    let result = "";
    try {
      log("info", "discord.search.stage", { traceId, stage: "attempt", query: q });
      result = cleanModelOutput(await searchWebWithOptions(q, { traceId }));
      log("info", "discord.search.stage", {
        traceId,
        stage: "attempt_done",
        query: q,
        length: result.length
      });
    } catch (error) {
      log("warn", "discord.search.attempt_failed", { traceId, query: q, error: String(error) });
      continue;
    }
    if (!result.trim()) continue;
    best = result;
    if (!looksWeakSearchResult(result)) {
      return result;
    }
  }
  // Avoid dumping internal retries/queries to the user; instead provide an actionable next step.
  if (best && !looksLikeMapIntent(raw)) return best;

  if (looksLikeMapIntent(raw)) {
    // Extract location context from user's message for dynamic response
    const locationMatches = raw.match(/([\u4e00-\u9fff]+(?:科技|公司|办公室|大厦|中心|学校|医院|商场|超市))/g);
    const restaurantMatches = raw.match(/(面馆|餐厅|餐馆|饭店|面食)/g);
    
    const startLocation = locationMatches ? locationMatches[0] : "起始位置";
    const targetType = restaurantMatches ? restaurantMatches[0] : "目标位置";
    
    return [
      `我目前缺少精确的地理坐标数据来计算"${startLocation}"到"${targetType}"的准确距离。`,
      "",
      "请提供更精确的位置信息，任选一种方式：",
      `1) 发送"${startLocation}"的高德/百度地图分享链接 + 候选${targetType}的分享链接或详细地址。`,
      `2) 直接提供坐标：${startLocation}(lat,lng) + 各${targetType}(lat,lng)。`,
      "",
      "我收到后会输出：餐厅名 | 地址 | 直线距离(km) | 备注（需要时补充驾车/步行估算）。"
    ].join("\n");
  }

  return [
    "我已经执行了多轮联网检索，但当前公开来源信号不足以稳定给出答案。",
    "你可以补充目标站点（如官网/公众号/媒体名）或更精确的关键词（公司全称/人名/产品名），我会继续深挖并输出结构化摘要。"
  ].join("\n");
}

function looksWeakSearchResult(text: string): boolean {
  return [
    "仍不够清晰",
    "未拿到可用数据",
    "联网查询失败",
    "天气联网查询失败",
    "没有可返回内容",
    "置信度：低"
  ].some((x) => text.includes(x));
}

function looksLikeLocalDownloadsIntent(input: string): boolean {
  const q = input.toLowerCase();
  return (
    (q.includes("下载目录") || q.includes("downloads") || q.includes("download folder")) &&
    (q.includes("查看") || q.includes("看") || q.includes("分析") || q.includes("洞察") || q.includes("insight"))
  );
}

function getAdminIds(): string[] {
  return (process.env.DISCORD_ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAdminUser(userId: string): boolean {
  return getAdminIds().includes(userId);
}

async function inspectDownloadsForAdmin(userId: string, raw: string): Promise<string> {
  if (!isAdminUser(userId)) {
    return "无权限：本地文件洞察仅管理员可用。";
  }
  const lower = raw.toLowerCase();
  const countMatch = lower.match(/(\d{1,2})\s*(个|条|items|files)/);
  const topN = Math.max(5, Math.min(20, Number(countMatch?.[1] || "10")));
  const cmd = [
    `if [ ! -d ${shellEscape(DOWNLOADS_DIR)} ]; then echo "__MISSING_DIR__"; exit 0; fi`,
    `echo "__TOTAL__ $(find ${shellEscape(DOWNLOADS_DIR)} -maxdepth 1 -type f | wc -l | tr -d ' ')"`,
    `echo "__LATEST__"`,
    `ls -lt ${shellEscape(DOWNLOADS_DIR)} | sed -n '1,${topN + 1}p'`,
    `echo "__TYPES__"`,
    `find ${shellEscape(DOWNLOADS_DIR)} -maxdepth 1 -type f | sed -E 's/.*\\.([^.\\/]+)$/\\1/' | tr 'A-Z' 'a-z' | sort | uniq -c | sort -nr | sed -n '1,8p'`
  ].join(" && ");

  const output = await runShell(cmd);
  if (output.includes("__MISSING_DIR__")) {
    return `目录不存在：${DOWNLOADS_DIR}`;
  }
  return [
    `下载目录洞察（只读）: ${DOWNLOADS_DIR}`,
    "说明：以下是当前文件量、最近变更和类型分布。",
    "",
    output.trim()
  ].join("\n");
}

function runShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
        shell: "/bin/zsh"
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr || stdout}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function createTrace(userId: string, channelId: string): ReplyTrace {
  return {
    id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    userId,
    channelId,
    route: "unknown"
  };
}

function buildDedupeKey(userId: string, text: string, route?: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  // 对于智能对话类请求，使用更短的时间窗口避免误判重复
  const isAgentReply = route === "agent_reply";
  const windowMs = isAgentReply ? (30 * 1000) : (5 * 60 * 1000); // 30s vs 5min
  const timeWindow = Math.floor(Date.now() / windowMs);
  return `${userId}::${timeWindow}::${normalized}`;
}

function detectRoute(
  raw: string,
  userId?: string
):
  | "agent_admin"
  | "robot_control"
  | "downloads"
  | "local_ops"
  | "web_command"
  | "weather"
  | "search_intent"
  | "social_stats"
  | "agent_reply" {
  const lower = raw.toLowerCase();
  if (lower.startsWith("/agent ")) return "agent_admin";
  if (lower.startsWith("/cat ")) return "robot_control";
  const hasEmbeddedPath = /~\/|\/users\/|\/downloads\/|\/desktop\/|\/documents\/|[a-z]:\\/.test(lower);
  const hasFindVerb = /(找|找到|查找|搜索|定位)/.test(raw);

  // Document reading/summarization should be handled by agent path first,
  // even if the sentence also mentions local directories.
  if (looksLikeDocumentSummaryIntent(raw)) return "agent_reply";
  if (looksLikeSocialStatsIntent(raw)) return "social_stats";
  // Guard: capability/meta questions should go to normal agent reply,
  // not local filesystem ops routing.
  if (looksLikeCapabilityMetaQuestion(raw)) return "agent_reply";
  if (userId && pendingLocalOpsByUser.has(userId) && looksLikeSimpleConfirmWord(raw)) {
    return "local_ops";
  }
  // Prefer local ops when users ask to locate a concrete local path.
  if (hasFindVerb && hasEmbeddedPath) return "local_ops";
  if (looksLikeLocalOpConfirmIntent(raw)) return "local_ops";
  if (looksLikeLocalOpsIntent(raw)) return "local_ops";
  if (looksLikeLocalDownloadsIntent(raw)) return "downloads";
  if (raw.toLowerCase().startsWith("/web ")) return "web_command";
  // 天气查询已改为 skill，由 AI skill router 根据 description 智能判断
  // 不再硬编码判断，避免误触发陈述句
  if (looksLikeMapIntent(raw)) return "search_intent";
  if (looksLikeSearchIntent(raw)) return "search_intent";
  return "agent_reply";
}

function handleAgentAdminCommand(
  userId: string,
  channelId: string,
  raw: string,
  api?: AgentRouterAdminApi
): string {
  if (!isAdminUser(userId)) {
    return "无权限：/agent 仅管理员可用。";
  }
  if (!api) {
    return "agent 管理接口不可用。";
  }

  const text = raw.trim();
  const body = text.replace(/^\/agent\s+/i, "").trim();
  const parts = body.split(/\s+/).filter(Boolean);
  const command = (parts[0] || "").toLowerCase();

  if (!command || command === "help") {
    return [
      "/agent 命令：",
      "1) /agent list",
      "2) /agent create <agentId> [name...]",
      "3) /agent bind <agentId> [channelId]",
      "4) /agent unbind [channelId]",
      "5) /agent delete <agentId>",
      "",
      "示例：",
      "/agent create jpclaw_manager 管理者",
      "/agent create jpclaw1",
      "/agent bind jpclaw1",
      "/agent bind jpclaw_manager 123456789012345678",
      "/agent unbind",
      "/agent delete jpclaw1"
    ].join("\n");
  }

  if (command === "list") {
    const agents = api.listAgents();
    const bindings = api.listBindings().discord;
    const current = bindings[channelId] || api.getDefaultAgentId();
    const lines = agents.map((a) => `- ${a.id}${a.enabled ? "" : " (disabled)"}${a.id === current ? "  <- 当前频道" : ""}`);
    const bindingCount = Object.keys(bindings).length;
    return [
      `默认 agent: ${api.getDefaultAgentId()}`,
      `当前频道绑定: ${current}`,
      `绑定总数: ${bindingCount}`,
      "agents:",
      ...lines
    ].join("\n");
  }

  if (command === "create") {
    const agentId = parts[1] || "";
    const name = parts.slice(2).join(" ").trim() || undefined;
    if (!agentId) return "缺少 agentId。用法：/agent create <agentId> [name]";
    try {
      const created = api.createAgent({ id: agentId, name });
      return `已创建 agent: ${created.id}${created.name ? ` (${created.name})` : ""}`;
    } catch (error) {
      return `创建失败：${String(error)}`;
    }
  }

  if (command === "bind") {
    const agentId = parts[1] || "";
    const targetChannelId = parts[2] || channelId;
    if (!agentId) return "缺少 agentId。用法：/agent bind <agentId> [channelId]";
    try {
      const bound = api.bindDiscordChannel(targetChannelId, agentId);
      const currentMsg = targetChannelId === channelId ? "（当前频道）" : "";
      return `绑定成功：channel=${bound.channelId} -> agent=${bound.agentId} ${currentMsg}`.trim();
    } catch (error) {
      return `绑定失败：${String(error)}`;
    }
  }

  if (command === "unbind") {
    const targetChannelId = parts[1] || channelId;
    try {
      const out = api.unbindDiscordChannel(targetChannelId);
      const currentMsg = targetChannelId === channelId ? "（当前频道）" : "";
      if (!out.removed) return `未发现绑定：channel=${out.channelId} ${currentMsg}`.trim();
      return `解绑成功：channel=${out.channelId} ${currentMsg}`.trim();
    } catch (error) {
      return `解绑失败：${String(error)}`;
    }
  }

  if (command === "delete") {
    const agentId = parts[1] || "";
    if (!agentId) return "缺少 agentId。用法：/agent delete <agentId>";
    try {
      const out = api.deleteAgent(agentId);
      return `删除成功：agent=${out.id}`;
    } catch (error) {
      return `删除失败：${String(error)}`;
    }
  }

  return "未知命令。输入 /agent help 查看用法。";
}

function looksLikeLocalOpsIntent(input: string): boolean {
  const q = input.toLowerCase();
  const nouns = ["目录", "文件夹", "文件", "downloads", "download", "应用", "app", "配置", "config"];
  const verbs = [
    "找",
    "找到",
    "查找",
    "搜索",
    "定位",
    "查看",
    "列出",
    "整理",
    "归类",
    "分类",
    "新建",
    "创建",
    "移动",
    "重命名",
    "删除",
    "打开",
    "启动",
    "确认整理",
    "确认执行"
  ];
  const hasVerb = verbs.some((x) => q.includes(x));
  const hasNoun = nouns.some((x) => q.includes(x));
  const hasPathLike = /~\/|\/users\/|\/downloads\/|[a-z]:\\/.test(q);
  const hasFindVerb = /(找|找到|查找|搜索|定位)/.test(input);
  const hasLocalHint = q.includes("下载目录") || q.includes("downloads") || q.includes("download");
  return hasVerb && (hasNoun || hasPathLike || (hasFindVerb && hasLocalHint));
}


function looksLikeSocialStatsIntent(input: string): boolean {
  const lower = input.toLowerCase();
  const explicitStatsCommand =
    lower.startsWith("/social") ||
    lower.startsWith("/jike") ||
    lower.startsWith("/stats") ||
    /(帮我查看|帮我查|统计|分析).*(即刻|okjike|粉丝|关注|点赞|评论|主页数据)/i.test(input);
  const hasUrl = /https?:\/\/\S+/.test(input);
  const hasSocialWord =
    input.includes("关注") ||
    input.includes("粉丝") ||
    input.includes("点赞") ||
    input.includes("评论") ||
    input.includes("互动") ||
    input.includes("被关注") ||
    input.includes("主页");
  const hasPlatformHint =
    lower.includes("okjike.com") ||
    input.includes("即刻") ||
    input.includes("微博") ||
    input.includes("小红书") ||
    input.includes("抖音") ||
    input.includes("知乎") ||
    input.includes("b站") ||
    input.includes("bilibili");
  if (explicitStatsCommand && (hasUrl || hasPlatformHint) && hasSocialWord) return true;
  return false;
}




function extractEmail(text: string): string | null {
  const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m?.[0] || null;
}

async function handleSocialStats(raw: string): Promise<string> {
  const urlMatch = raw.match(/https?:\/\/\S+/);
  const url = urlMatch?.[0] || process.env.JPCLAW_PROFILE_URL;
  if (!url) {
    return "请提供主页链接，例如：https://web.okjike.com/u/xxxx 或 https://weibo.com/xxx";
  }

  const storageStatePath = pickSocialStorageState(url);
  const payload = {
    url,
    storageStatePath
  };

  const output = await runSkill("social-stats", JSON.stringify(payload));
  try {
    const parsed = JSON.parse(output);
    const counts = parsed?.counts || {};
    const hasAny =
      counts.followers !== null ||
      counts.following !== null ||
      counts.likes !== null ||
      counts.comments !== null ||
      counts.praises !== null;
    if (hasAny) {
      return [
        `主页数据（${new Date(parsed.fetchedAt || Date.now()).toLocaleString()}）`,
        `被关注/粉丝：${counts.followers ?? "未知"}`,
        `关注：${counts.following ?? "未知"}`,
        `点赞：${counts.likes ?? "未知"}`,
        `评论：${counts.comments ?? "未知"}`,
        `夸夸：${counts.praises ?? "未知"}`
      ].join("\n");
    }

    const sample = String(parsed?.textSample || "").toLowerCase();
    if (sample.includes("扫码") || sample.includes("scan") || sample.includes("login")) {
      return [
        "页面提示需要登录（出现扫码/登录页），所以目前抓不到关注数。",
        "解决方式：先用浏览器登录一次并保存 storage state，然后再查。",
        `当前使用的 storageStatePath: ${storageStatePath}`
      ].join("\n");
    }
  } catch {
    // fall through
  }

  return output;
}

function pickSocialStorageState(url: string): string {
  const configured = process.env.JPCLAW_SOCIAL_STORAGE_STATE;
  if (configured) return configured;

  try {
    const host = new URL(url).hostname.toLowerCase();
    const jikeState = "sessions/jike/storage.json";
    if (host.includes("okjike.com") && existsSync(jikeState)) return jikeState;
  } catch {
    // ignore
  }
  return "sessions/social/storage.json";
}

function extractField(text: string, keys: string[]): string | null {
  const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?:${escaped})\\s*[:：=]\\s*([\\s\\S]*?)(?=\\s+(?:${escaped})\\s*[:：=]|$)`, "i");
  const m = text.match(re);
  return m?.[1]?.trim() || null;
}

function extractPostIdFromText(text: string): string | null {
  // Raw UUID in text
  const uuid = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
  if (uuid?.[0]) return uuid[0];

  // Moltbook post URL like .../posts/<uuid>
  const postPath = text.match(/\/posts\/([0-9a-f-]{36})\b/i);
  if (postPath?.[1]) return postPath[1];

  return null;
}

function extractAgentNameForLatest(text: string): string | null {
  const m = text.match(/评论\s*([a-zA-Z0-9_-]{3,64})\s*的?最新/i);
  if (m?.[1]) return m[1];
  const mLoose = text.match(/([a-zA-Z0-9_-]{3,64})\s*的?最新(?:内容|帖子|贴子)?/i);
  if (mLoose?.[1]) return mLoose[1];
  const m2 = text.match(/agent\s*[:：=]\s*([a-zA-Z0-9_-]{3,64})/i);
  return m2?.[1] || null;
}

function inferSmartCommentText(text: string): string | null {
  if (/看着评论|你看着评|你来评论/.test(text)) {
    return "已读这条更新，方向清晰，建议继续推进并同步下一步里程碑。";
  }
  return null;
}





async function fetchJsonSafe(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; data: any | null }> {
  try {
    const resp = await fetch(url, { method: "GET", headers });
    if (!resp.ok) return { ok: false, data: null };
    const data = (await resp.json()) as any;
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
}

function normalizePosts(data: any): any[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.posts)) return data.posts;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

function isPostOwnedByAgent(post: any, agentName: string): boolean {
  const expected = normalizeHandle(agentName);
  if (!expected) return false;
  const candidates = [
    post?.author,
    post?.author?.name,
    post?.author?.username,
    post?.author?.handle,
    post?.author_name,
    post?.agent,
    post?.agent?.name,
    post?.agent_name,
    post?.username,
    post?.user?.name,
    post?.user?.username
  ].map((x) => normalizeHandle(String(x || "")));

  return candidates.some((v) => v === expected);
}

function normalizeHandle(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/^u\//, "")
    .replace(/^@/, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function toTime(post: any): number {
  const raw = post?.created_at || post?.createdAt || post?.timestamp || post?.time || "";
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? 0 : t;
}


function looksLikeLocalOpConfirmIntent(input: string): boolean {
  const q = input.toLowerCase();
  return (
    q.includes("确认执行") ||
    q.includes("确认整理") ||
    q.includes("开始执行") ||
    q.includes("可以开始") ||
    looksLikeSimpleConfirmWord(input)
  );
}

function looksLikeSimpleConfirmWord(input: string): boolean {
  const q = input.trim().toLowerCase();
  return q === "好" || q === "好的" || q === "可以" || q === "开始" || q === "执行";
}

function extractConfirmToken(input: string): string | null {
  const m = input.match(/\b([a-z0-9]{6})\b/i);
  return m?.[1]?.toLowerCase() || null;
}

async function handleLocalOps(userId: string, raw: string): Promise<string> {
  if (!isAdminUser(userId)) {
    return "无权限：本地操作仅管理员可用。";
  }

  if (looksLikeLocalOpConfirmIntent(raw)) {
    const pending = pendingLocalOpsByUser.get(userId);
    if (!pending) {
      return "当前没有待确认的本地操作任务。";
    }
    if (pending.expiresAt < Date.now()) {
      pendingLocalOpsByUser.delete(userId);
      return "确认已过期，请重新发送操作指令。";
    }
    const token = extractConfirmToken(raw);
    if (token && token !== pending.token) {
      return `确认码不匹配。请发送：确认执行 ${pending.token}`;
    }
    pendingLocalOpsByUser.delete(userId);
    return pending.execute();
  }

  const action = planLocalAction(raw);
  if (!action) {
    return [
      "我支持的通用本地操作：",
      "- 查看目录：查看 下载目录",
      "- 整理目录：整理 下载目录 到 整理后文件",
      "- 创建文件夹：在 下载目录 新建 文件夹 归档",
      "- 移动文件：移动 ~/Downloads/a.pdf 到 ~/Downloads/归档",
      "- 删除文件：删除 ~/Downloads/tmp.txt",
      "- 打开应用：打开应用 Safari",
      "",
      "写操作会先给你确认码，避免误操作。"
    ].join("\n");
  }

  if (!action.needsConfirm) {
    return action.execute();
  }

  const token = generateShortToken();
  pendingLocalOpsByUser.set(userId, {
    token,
    expiresAt: Date.now() + LOCAL_OPS_CONFIRM_TTL_MS,
    description: action.description,
    execute: action.execute
  });
  return [
    `待执行本地操作：${action.description}`,
    action.preview,
    "",
    "这是写操作。",
    `若确认执行，请在 10 分钟内回复：确认执行 ${token}`
  ].join("\n");
}

function summarizeDownloadsForOrganize(dir: string): string {
  if (!existsSync(dir)) return "目录不存在。";
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((x) => x.isFile())
    .map((x) => x.name);
  const total = entries.length;
  const extCount = new Map<string, number>();
  for (const name of entries) {
    const ext = path.extname(name).toLowerCase().replace(/^\./, "") || "other";
    extCount.set(ext, (extCount.get(ext) || 0) + 1);
  }
  const topTypes = Array.from(extCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `${ext}:${count}`)
    .join(", ");
  return [`文件总数：${total}`, `类型分布：${topTypes || "无"}`].join("\n");
}

function runDownloadsOrganization(sourceDir: string, destRootInput?: string): string {
  if (!existsSync(sourceDir)) return `目录不存在：${sourceDir}`;
  const targetRoot = destRootInput ? resolveLocalPath(destRootInput) : path.join(sourceDir, "整理后文件");
  assertPathInHome(sourceDir);
  assertPathInHome(targetRoot);
  mkdirSync(targetRoot, { recursive: true });

  const movedByCategory = new Map<string, number>();
  const errors: string[] = [];
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  let moved = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = path.join(sourceDir, entry.name);
    const category = categorizeByExtension(entry.name);
    const categoryDir = path.join(targetRoot, category);
    mkdirSync(categoryDir, { recursive: true });
    let dest = path.join(categoryDir, entry.name);
    if (existsSync(dest)) {
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      const ext = path.extname(entry.name);
      const stem = path.basename(entry.name, ext);
      dest = path.join(categoryDir, `${stem}_${stamp}${ext}`);
    }
    try {
      renameSync(src, dest);
      moved += 1;
      movedByCategory.set(category, (movedByCategory.get(category) || 0) + 1);
    } catch (error) {
      errors.push(`${entry.name}: ${String(error)}`);
    }
  }

  const catLine = Array.from(movedByCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `${cat}:${count}`)
    .join(", ");
  const lines = [
    `整理完成：已移动 ${moved} 个文件`,
    `目标目录：${targetRoot}`,
    `分类统计：${catLine || "无"}`
  ];
  if (errors.length > 0) {
    lines.push(`失败 ${errors.length} 个：${errors.slice(0, 3).join(" | ")}`);
  }
  return lines.join("\n");
}

function planLocalAction(raw: string):
  | { description: string; preview: string; needsConfirm: boolean; execute: () => string }
  | null {
  const normalized = raw.trim();
  const lower = normalized.toLowerCase();

  if (/查看|列出|看看|浏览/.test(normalized) && /目录|文件夹|downloads|下载/.test(normalized)) {
    const dir = resolveLocalPath(extractPathHint(normalized) || DOWNLOADS_DIR);
    return {
      description: `查看目录 ${dir}`,
      preview: summarizeDownloadsForOrganize(dir),
      needsConfirm: false,
      execute: () => inspectDirectory(dir)
    };
  }

  if (/找|找到|查找|搜索|定位/.test(normalized) && /目录|文件夹|文件|downloads|下载/.test(normalized)) {
    const target = resolveLocalPath(extractFindTarget(normalized) || DOWNLOADS_DIR);
    return {
      description: `查找路径 ${target}`,
      preview: `将查找路径：${target}`,
      needsConfirm: false,
      execute: () => findPath(target)
    };
  }

  if (/整理|归类|分类|收拾/.test(normalized) && /目录|文件夹|downloads|下载/.test(normalized)) {
    const source = resolveLocalPath(extractPathHint(normalized) || DOWNLOADS_DIR);
    const targetHint = extractTargetHint(normalized);
    const target = targetHint ? resolveLocalPath(targetHint) : path.join(source, "整理后文件");
    return {
      description: `整理目录 ${source} -> ${target}`,
      preview: summarizeDownloadsForOrganize(source),
      needsConfirm: true,
      execute: () => runDownloadsOrganization(source, target)
    };
  }

  const mkdirMatch = normalized.match(/在\s+(.+?)\s+新建\s+(?:文件夹|目录)\s+(.+)$/);
  if (mkdirMatch) {
    const parent = resolveLocalPath(mkdirMatch[1]);
    const name = sanitizeName(mkdirMatch[2]);
    const target = path.join(parent, name);
    return {
      description: `创建目录 ${target}`,
      preview: `将创建目录：${target}`,
      needsConfirm: true,
      execute: () => {
        assertPathInHome(target);
        mkdirSync(target, { recursive: true });
        return `已创建目录：${target}`;
      }
    };
  }

  const moveMatch = normalized.match(/(?:移动|挪到|转移)\s+(.+?)\s+(?:到|至)\s+(.+)$/);
  if (moveMatch) {
    const src = resolveLocalPath(moveMatch[1]);
    const dst = resolveLocalPath(moveMatch[2]);
    return {
      description: `移动 ${src} -> ${dst}`,
      preview: `将移动：${src}\n到：${dst}`,
      needsConfirm: true,
      execute: () => {
        assertPathInHome(src);
        assertPathInHome(dst);
        if (!existsSync(src)) return `源路径不存在：${src}`;
        const finalDst = existsSync(dst) && statSync(dst).isDirectory() ? path.join(dst, path.basename(src)) : dst;
        renameSync(src, finalDst);
        return `移动完成：${src} -> ${finalDst}`;
      }
    };
  }

  const deleteMatch = normalized.match(/(?:删除|移除)\s+(.+)$/);
  if (deleteMatch) {
    const target = resolveLocalPath(deleteMatch[1]);
    return {
      description: `删除 ${target}`,
      preview: `将删除：${target}`,
      needsConfirm: true,
      execute: () => {
        assertPathInHome(target);
        if (!existsSync(target)) return `目标不存在：${target}`;
        rmSync(target, { recursive: true, force: true });
        return `已删除：${target}`;
      }
    };
  }

  const openMatch = normalized.match(/(?:打开应用|启动应用|打开)\s+(.+)$/);
  if (openMatch) {
    const appName = sanitizeName(openMatch[1]);
    return {
      description: `打开应用 ${appName}`,
      preview: `将尝试打开应用：${appName}`,
      needsConfirm: false,
      execute: () => {
        exec(`open -a ${shellEscape(appName)}`);
        return `已尝试打开应用：${appName}`;
      }
    };
  }

  return null;
}

function inspectDirectory(dir: string): string {
  const target = resolveLocalPath(dir);
  assertPathInHome(target);
  if (!existsSync(target)) return `目录不存在：${target}`;
  const entries = readdirSync(target, { withFileTypes: true });
  const files = entries.filter((x) => x.isFile());
  const dirs = entries.filter((x) => x.isDirectory());
  const latest = entries
    .map((x) => {
      const full = path.join(target, x.name);
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name: x.name, dir: x.isDirectory(), mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20)
    .map((x) => `${x.dir ? "[D]" : "[F]"} ${x.name}`);
  return [
    `目录：${target}`,
    `总计：文件 ${files.length}，文件夹 ${dirs.length}`,
    "最近变更：",
    ...latest
  ].join("\n");
}

function extractPathHint(input: string): string | null {
  const m = input.match(/(?:查看|列出|浏览|整理|归类|分类)\s+(.+?)(?:\s+到\s+.+)?$/);
  if (!m) return null;
  return m[1].trim();
}

function extractFindTarget(input: string): string | null {
  const embeddedPath = input.match(/(~\/\S+|\/Users\/\S+|\/Downloads\/\S+|\/Desktop\/\S+|\/Documents\/\S+|[A-Za-z]:\\\S+)/);
  if (embeddedPath?.[1]) return embeddedPath[1].trim();

  const cleaned = input
    .replace(/^帮我/, "")
    .replace(/^请/, "")
    .replace(/^(找|找到|查找|搜索|定位)/, "")
    .replace(/(这个|这个目录|这个文件夹|这个文件|一下|下)$/, "")
    .trim();
  return cleaned || null;
}

function extractTargetHint(input: string): string | null {
  const m = input.match(/\s到\s(.+)$/);
  return m?.[1]?.trim() || null;
}

function findPath(target: string): string {
  const abs = resolveLocalPath(target);
  assertPathInHome(abs);
  const parent = path.dirname(abs);
  const base = path.basename(abs);

  if (existsSync(abs)) {
    const st = statSync(abs);
    const kind = st.isDirectory() ? "目录" : "文件";
    const extra = st.isDirectory() ? inspectDirectory(abs) : `路径：${abs}\n类型：${kind}`;
    return [`✅ 找到了${kind}`, extra].join("\n");
  }

  const suggestions: string[] = [];
  if (existsSync(parent)) {
    try {
      const siblings = readdirSync(parent, { withFileTypes: true })
        .map((x) => x.name)
        .filter((name) => name.toLowerCase().includes(base.toLowerCase()))
        .slice(0, 10);
      suggestions.push(...siblings.map((x) => `- ${path.join(parent, x)}`));
    } catch {
      // ignore listing failures
    }
  }

  if (suggestions.length > 0) {
    return [`❌ 未找到：${abs}`, "你可能要找的是：", ...suggestions].join("\n");
  }
  return `❌ 未找到：${abs}`;
}

function resolveLocalPath(raw: string): string {
  let input = raw.trim().replace(/^["'“”]/, "").replace(/["'“”]$/, "");
  const home = os.homedir();
  const aliasMap: Record<string, string> = {
    "下载目录": path.join(home, "Downloads"),
    "下载": path.join(home, "Downloads"),
    downloads: path.join(home, "Downloads"),
    "桌面": path.join(home, "Desktop"),
    desktop: path.join(home, "Desktop"),
    "文档": path.join(home, "Documents"),
    documents: path.join(home, "Documents"),
    home: home
  };
  if (aliasMap[input.toLowerCase()]) return aliasMap[input.toLowerCase()];
  if (input.startsWith("~")) return path.resolve(home, input.slice(1));
  if (path.isAbsolute(input)) return path.resolve(input);
  return path.resolve(home, input);
}

function assertPathInHome(abs: string): void {
  const home = path.resolve(os.homedir());
  const target = path.resolve(abs);
  if (!(target === home || target.startsWith(`${home}${path.sep}`))) {
    throw new Error(`安全限制：仅允许操作用户目录内路径（${home}）`);
  }
}

function sanitizeName(text: string): string {
  return text.trim().replace(/[\\/:*?"<>|]/g, "_");
}

function categorizeByExtension(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".svg"].includes(ext)) {
    return "图片";
  }
  if ([".mp4", ".mov", ".mkv", ".avi", ".webm"].includes(ext)) {
    return "视频";
  }
  if ([".mp3", ".wav", ".m4a", ".flac", ".aac"].includes(ext)) {
    return "音频";
  }
  if ([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt", ".md"].includes(ext)) {
    return "文档";
  }
  if ([".zip", ".rar", ".7z", ".tar", ".gz"].includes(ext)) {
    return "压缩包";
  }
  if ([".dmg", ".pkg", ".app", ".exe", ".msi"].includes(ext)) {
    return "安装包";
  }
  if ([".py", ".js", ".ts", ".tsx", ".java", ".go", ".rs", ".cpp", ".c", ".sh"].includes(ext)) {
    return "代码";
  }
  return "其他";
}

function generateShortToken(): string {
  return Math.random().toString(36).slice(2, 8);
}

function writeReplay(trace: ReplyTrace, event: string, meta?: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(REPLAY_LOG_FILE), { recursive: true });
    appendFileSync(
      REPLAY_LOG_FILE,
      `${JSON.stringify({
        time: new Date().toISOString(),
        traceId: trace.id,
        userId: trace.userId,
        channelId: trace.channelId,
        route: trace.route,
        event,
        ...(meta || {})
      })}\n`
    );
  } catch (error) {
    log("warn", "discord.replay.write_failed", { error: String(error), traceId: trace.id });
  }
}

function truncateForReplay(text: string): string {
  return text.length <= 280 ? text : `${text.slice(0, 280)}...`;
}

function optimizeForDiscordReading(text: string): string {
  return text;
}

async function captureReplyFeedback(message: Message, botId?: string): Promise<void> {
  try {
    if (!botId) return;
    if (!message.reference?.messageId) return;
    const target = await message.fetchReference().catch(() => null);
    if (!target) return;
    if (target.author?.id !== botId) return;
    const value = (message.content || "").trim();
    if (!value) return;
    appendDiscordFeedback({
      userId: message.author.id,
      channelId: message.channelId,
      kind: "reply",
      value,
      messageId: target.id
    });
  } catch {
    // ignore feedback collection errors
  }
}

async function maybeHandleFeedbackAck(message: Message, botId?: string): Promise<boolean> {
  try {
    if (!botId) return false;
    if (!message.reference?.messageId) return false;
    const target = await message.fetchReference().catch(() => null);
    if (!target || target.author?.id !== botId) return false;
    const text = (message.content || "").trim();
    if (!text) return false;
    if (!looksLikeFeedbackText(text)) return false;
    await withTimeout(
      message.reply(pickFeedbackAck(message.author.id)),
      DISCORD_SEND_TIMEOUT_MS
    );
    return true;
  } catch {
    return false;
  }
}

function looksLikeFeedbackText(text: string): boolean {
  const t = text.toLowerCase();
  const tokens = [
    "太长",
    "太短",
    "跑偏",
    "不对",
    "不行",
    "不准确",
    "慢",
    "卡",
    "先给结论",
    "精简",
    "简短",
    "很好",
    "不错",
    "有帮助",
    "有用",
    "谢谢",
    "优化"
  ];
  return tokens.some((x) => t.includes(x));
}

function pickFeedbackAck(userId: string): string {
  const ownerPhrases = [
    "姜哥，太感谢你的反馈啦🙂 我已经收到了，会认真用你的反馈持续迭代优化我们的服务。",
    "姜哥，收到并感谢你的反馈✨ 这条意见我会纳入优化，持续打磨我们的服务体验。",
    "姜哥，谢谢你给我提反馈🙏 我会把它用于后续迭代，持续优化我们的服务质量。"
  ];
  const normalPhrases = [
    "感谢你的反馈🙂 我已经收到了，会认真使用你的反馈持续迭代优化我们的服务。",
    "谢谢你的反馈✨ 已收到，这条意见会进入后续优化，持续改进我们的服务体验。",
    "非常感谢你的反馈🙏 我会把它用于后续迭代，持续优化我们的服务质量。"
  ];
  const pool = userId === OWNER_USER_ID ? ownerPhrases : normalPhrases;
  const prev = lastFeedbackAckByUser.get(userId) ?? -1;
  let idx = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && idx === prev) idx = (idx + 1) % pool.length;
  lastFeedbackAckByUser.set(userId, idx);
  return pool[idx];
}

async function maybeAckReactionFeedback(message: Message, userId: string, emojiValue: string): Promise<void> {
  const feedbackEmoji = new Set(["👍", "👎", "❤️", "🔥", "✅", "😄", "🎉", "👏", "100", "💯"]);
  if (!feedbackEmoji.has(emojiValue)) return;
  const key = `${userId}::${message.id}`;
  const last = lastReactionAckAt.get(key) || 0;
  const now = Date.now();
  if (now - last < REACTION_ACK_COOLDOWN_MS) return;
  lastReactionAckAt.set(key, now);
  const isOwner = userId === OWNER_USER_ID;
  const text = isOwner
    ? "姜哥，感谢你的反馈，已收到。我会根据你的反馈继续优化迭代我们的服务。"
    : "感谢你的反馈，已收到。我会根据你的反馈继续优化迭代我们的服务。";
  await withTimeout(
    message.reply({
      content: text,
      allowedMentions: { repliedUser: false }
    }),
    DISCORD_SEND_TIMEOUT_MS
  ).catch(() => {});
}
