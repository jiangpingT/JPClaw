/**
 * DMWork Bot Handler
 *
 * 通过 WuKongIMClient（原生 WebSocket，无单例限制）接入 DMWork 即时通讯。
 * 每个 DmworkBotHandler 持有独立连接，支持多 bot 并发。
 * DM：所有消息都回复；群组：根据角色策略决定是否响应。
 *   - expert（jpexpert）：always_user_question，始终回复
 *   - critic（jpcritic）：ai_decide + 6s 延迟，AI 决策是否参与
 *   - thinker（jpthinker）：ai_decide + 12s 延迟，AI 决策是否参与
 */

import { writeFile, unlink } from "node:fs/promises";
import type { ChatEngine } from "../core/engine.js";
import { wrapChatEngine } from "../core/engine.js";
import { log } from "../shared/logger.js";
import { dashboardBus } from "../shared/dashboard-bus.js";
import { WuKongIMClient, type WKMessage } from "./wukongim-client.js";
import {
  getRoleConfig,
  aiDecideParticipation,
  formatConversationHistory,
  type BotRoleConfig,
} from "./bot-roles.js";
import { extractText } from "./document-text-extractor.js";

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface DmworkBotConfig {
  enabled: boolean;
  botToken: string;   // 注册 token（bf_xxx），用于 REST API 鉴权
  robotId: string;    // 注册后的 robot_id，即 WS 的 uid
  imToken: string;    // 注册后的 im_token，即 WS 的 token
  wsUrl: string;      // wss://im-test.xming.ai/ws
  apiUrl: string;     // https://im-test.xming.ai/api
  ownerUid: string;   // 机器人拥有者的 uid
  agentId?: string;
  name?: string;
}

interface ConversationEntry {
  author: string;
  content: string;
  isBot: boolean;
  timestamp: Date;
}

interface FileAttachment {
  url:     string;
  name:    string;
  type:    number;
  caption: string;  // 用户随文件发的说明文字（WuKongIM payload.caption）
}

// ─── 文件解析工具 ─────────────────────────────────────────────────────────────

/** 尝试从消息文本（payload JSON）解析文件附件信息 */
function tryParseAttachment(text: string): FileAttachment | null {
  try {
    const obj = JSON.parse(text);
    if (typeof obj?.url === "string" &&
        (obj.url.startsWith("file/") || obj.url.includes("/preview/") || obj.url.includes("/upload/"))) {
      return {
        url:     obj.url,
        name:    String(obj.name ?? "attachment"),
        type:    Number(obj.type ?? 0),
        caption: String(obj.caption ?? ""),  // 用户随文件发的说明
      };
    }
  } catch { /* 不是 JSON */ }
  return null;
}


// ─── 常量 ────────────────────────────────────────────────────────────────────

const DEDUPE_WINDOW_MS = 30_000;
const MAX_HISTORY      = 20;

// ─── Handler ─────────────────────────────────────────────────────────────────

export class DmworkBotHandler {
  private client: WuKongIMClient;
  private agentV2;
  private agent: ChatEngine;
  private roleConfig: BotRoleConfig;
  /** 同系统内其他 bot 的 robotId，收到时只记录历史、不触发回复 */
  private peerBotIds: Set<string>;
  /** robotId → 显示名，用于历史记录中的正确 author 归属（供 @mention 使用） */
  private peerBotNames: Map<string, string>;
  /** channelId → 对话历史 */
  private groupHistory = new Map<string, ConversationEntry[]>();
  /** 正在观察中的 channelId，同一频道只允许一个 timer */
  private pendingObservations = new Set<string>();
  /** message_id → expiry timestamp，用于去重 */
  private processedIds = new Map<string, number>();

  constructor(
    private config: DmworkBotConfig,
    agent: ChatEngine,
    peerBotIds: string[] = [],
    peerBotNames: Map<string, string> = new Map()
  ) {
    this.agent      = agent;
    this.agentV2    = wrapChatEngine(agent);

    this.roleConfig = getRoleConfig(config.agentId ?? "expert");

    this.peerBotIds   = new Set(peerBotIds);
    this.peerBotNames = peerBotNames;
    this.client = new WuKongIMClient({
      wsUrl:      config.wsUrl,
      uid:        config.robotId,
      token:      config.imToken,
      deviceFlag: 0,  // APP
      onConnected:    () => log("info", "dmwork.connected",    { name: config.name }),
      onDisconnected: () => log("warn", "dmwork.disconnected", { name: config.name }),
      onError:        (err) => log("error", "dmwork.ws_error", { name: config.name, error: String(err) }),
      onMessage:      (msg) => void this.handleMessage(msg),
    });
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  start(): void {
    log("info", "dmwork.connecting", { name: this.config.name, robotId: this.config.robotId });
    this.client.connect();
  }

  stop(): void {
    this.client.disconnect();
    log("info", "dmwork.stopped", { name: this.config.name });
  }

  getStatus() {
    return {
      enabled:   this.config.enabled,
      connected: this.client.isConnected(),
      robotId:   this.config.robotId,
      name:      this.config.name,
    };
  }

  // ── 消息处理 ──────────────────────────────────────────────────────────────

  private async handleMessage(msg: WKMessage): Promise<void> {
    if (!msg.text || !msg.fromUID) return;

    // 过滤自身消息
    if (msg.fromUID === this.config.robotId) return;

    // 去重
    const now = Date.now();
    if (this.processedIds.has(msg.messageID)) return;
    this.processedIds.set(msg.messageID, now + DEDUPE_WINDOW_MS);
    this.cleanupProcessedIds(now);

    // 解析文件附件（msg.text 为 payload JSON 时）
    const attachment = tryParseAttachment(msg.text);

    // peer bot 消息：只记录到历史（供 AI 决策参考），不回复
    if (this.peerBotIds.has(msg.fromUID) && msg.channelID) {
      this.recordHistory(msg.channelID, {
        author:    this.peerBotNames.get(msg.fromUID) ?? msg.fromUID,
        content:   attachment ? `[文件: ${attachment.name}]` : msg.text,
        isBot:     true,
        timestamp: new Date(),
      });
      return;
    }

    const isDM = !msg.channelID || msg.channelType === 1;
    if (isDM) {
      await this.handleDM(msg, attachment);
    } else {
      await this.handleGroup(msg, attachment);
    }
  }

  /** DM：所有消息都回复 */
  private async handleDM(msg: WKMessage, attachment: FileAttachment | null = null): Promise<void> {
    log("info", "dmwork.dm_received", { from: msg.fromUID, preview: msg.text.slice(0, 50), hasFile: !!attachment });
    await this.showTyping(msg.fromUID, 1);

    // 有附件时 msg.text 是 payload JSON；优先用 caption 作为用户问题
    const userText = attachment ? (attachment.caption || "") : msg.text;
    const question = await this.buildQuestion(userText, attachment);

    const result = await this.agentV2.replyV2(question, {
      userId:    msg.fromUID,
      channelId: `dmwork:dm:${msg.fromUID}`,
      agentId:   this.config.agentId,
    });

    const reply = result.ok ? result.data : "抱歉，处理出现了问题，请稍后再试。";
    await this.sendMessage(msg.fromUID, 1, reply);
  }

  /** 群组：根据角色策略决定是否响应 */
  private async handleGroup(msg: WKMessage, attachment: FileAttachment | null = null): Promise<void> {
    const mentionPatterns = [
      `@${this.config.robotId}`,
      `@${this.config.name || this.config.robotId}`,
    ];

    // 去掉 @ 前缀，获取实际问题（没有 @ 则原文；仅 @ 无内容则用默认问候）
    // 若是文件消息，优先用 caption；没有 caption 则空字符串
    let rawText = attachment ? (attachment.caption || "") : msg.text;
    for (const p of mentionPatterns) {
      rawText = rawText.replaceAll(p, "").trim();
    }
    if (!rawText && !attachment) {
      // 仅 @mention 无内容：只有被直接点名才回应，否则忽略
      const wasMentioned = mentionPatterns.some(p => msg.text.includes(p));
      if (!wasMentioned) return;
      rawText = "你好，有什么可以帮你？";
    }

    // 构造问题（含文件内容）
    const question = await this.buildQuestion(rawText, attachment);

    // 检测是否被直接 @mention（决定策略前先判断）
    const isDirectMention = mentionPatterns.some(p => msg.text.includes(p));

    // 检测是否是 owner 发来的（只有 alwaysRespondToOwner=true 的角色才强制回答）
    const isOwner = !!(this.roleConfig.alwaysRespondToOwner &&
      this.config.ownerUid && msg.fromUID === this.config.ownerUid);
    const forceReply = isDirectMention || isOwner;

    // 消息 @了其他人但没有 @本 bot → 是对别人说的，直接跳过（owner 消息豁免）
    if (!forceReply && /@\S+/.test(msg.text)) {
      log("debug", "dmwork.group.message_directed_at_others", { name: this.config.name });
      return;
    }

    // 记录用户消息到对话历史
    this.recordHistory(msg.channelID, {
      author:    msg.fromUID,
      content:   question,
      isBot:     false,
      timestamp: new Date(),
    });

    log("info", "dmwork.group_message", {
      group:         msg.channelID,
      from:          msg.fromUID,
      strategy:      this.roleConfig.participationStrategy,
      isDirectMention,
      preview:       question.slice(0, 50),
    });

    // 直接 @mention 或 owner 发消息 → 无论角色策略如何，必须回答
    if (this.roleConfig.participationStrategy === "always_user_question" || forceReply) {
      await this.replyToGroup(msg, question);
    } else {
      await this.observeAndDecide(msg, question);
    }
  }

  /** 立即回复群组消息（expert 策略） */
  private async replyToGroup(msg: WKMessage, question: string): Promise<void> {
    dashboardBus.emit("message", {
      type: "bot_thinking",
      timestamp: Date.now(),
      channelId: msg.channelID,
      botName: this.config.name,
      botId: this.config.agentId,
    });
    await this.showTyping(msg.channelID, 2);

    // 读取最近群聊上下文（含所有参与者 + 其他 bot 的回复）
    const recentHistory = this.getHistory(msg.channelID, 8);
    const historyText = formatConversationHistory(recentHistory);

    // 构造带发言人归属的输入，供频道级 session 使用
    // 用明确分隔线标注"当前新消息"，防止 LLM 将其误认为上文的延续
    const senderLabel = msg.fromUID;
    const contextualInput = historyText
      ? `${historyText}\n\n---\n当前需要回答的新消息：\n[${senderLabel}]: ${question}`
      : `[${senderLabel}]: ${question}`;

    // 频道级 session：所有参与者共享一条时间线（userId 从 fromUID → group:{channelID}）
    const result = await this.agentV2.replyV2(contextualInput, {
      userId:    `group:${msg.channelID}`,
      channelId: `dmwork:group:${msg.channelID}`,
      agentId:   this.config.agentId,
    });

    const reply = result.ok ? result.data : "抱歉，处理出现了问题，请稍后再试。";
    await this.sendMessage(msg.channelID, 2, reply);

    // 记录自身回复到历史（供其他 peer bot 感知）
    if (result.ok) {
      this.recordHistory(msg.channelID, {
        author:    this.config.name ?? this.config.robotId,
        content:   reply,
        isBot:     true,
        timestamp: new Date(),
      });
    }
  }

  /** 观察延迟后由 AI 决策是否参与（critic/thinker 策略） */
  private async observeAndDecide(msg: WKMessage, question: string): Promise<void> {
    const channelId = msg.channelID;

    // 同一频道已有观察任务，跳过（防止多人群里连发消息导致重复回答）
    if (this.pendingObservations.has(channelId)) {
      log("debug", "dmwork.observation.already_pending", { name: this.config.name, group: channelId });
      return;
    }
    this.pendingObservations.add(channelId);

    const delay = this.roleConfig.observationDelay;

    log("info", "dmwork.observing", {
      name:  this.config.name,
      group: channelId,
      delayMs: delay,
    });

    try {
    await new Promise(resolve => setTimeout(resolve, delay));

    // 延迟后重新读取历史（包含 expert 在此期间的回复）
    const limit   = this.roleConfig.maxObservationMessages ?? 10;
    const history = this.getHistory(msg.channelID, limit);
    const formattedHistory = formatConversationHistory(history);

    const { shouldParticipate } = await aiDecideParticipation(
      this.agent,
      this.roleConfig,
      formattedHistory
    );

    log("info", "dmwork.participation_decision", {
      name:             this.config.name,
      group:            msg.channelID,
      shouldParticipate,
    });

    if (shouldParticipate) {
      await this.replyToGroup(msg, question);
    }
    } finally {
      this.pendingObservations.delete(channelId);
    }
  }

  // ── 对话历史管理 ──────────────────────────────────────────────────────────

  private recordHistory(channelId: string, entry: ConversationEntry): void {
    const history = this.groupHistory.get(channelId) ?? [];
    history.push(entry);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    this.groupHistory.set(channelId, history);
    dashboardBus.emit("message", {
      type: "chat_message",
      timestamp: entry.timestamp.getTime(),
      channelId,
      author: entry.author,
      content: entry.content,
      isBot: entry.isBot,
    });
  }

  private getHistory(channelId: string, limit: number): ConversationEntry[] {
    const history = this.groupHistory.get(channelId) ?? [];
    return history.slice(-limit);
  }

  // ── 文件附件处理 ──────────────────────────────────────────────────────────

  /** 下载 DMWork 文件附件并提取可读文本（复用 document-text-extractor） */
  private async downloadAndReadFile(attachment: FileAttachment): Promise<string | null> {
    // WuKongIM 文件服务挂在根域（/file/preview/...），config.apiUrl 含 /api 后缀需去掉
    const baseHost = this.config.apiUrl.replace(/\/api\/?$/, "");
    const url = attachment.url.startsWith("http")
      ? attachment.url
      : `${baseHost}/${attachment.url.replace(/^\//, "")}`;

    const ext = "." + (attachment.name.split(".").pop()?.toLowerCase() ?? "bin");
    const tmp = `/tmp/dmwork-${Date.now()}${ext}`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.botToken}` },
        signal:  AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        log("warn", "dmwork.file_download_failed", { url, status: res.status });
        return null;
      }

      await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
      const result = await extractText(tmp);

      if (result.ok) return result.text.slice(0, 20_000);

      log("warn", "dmwork.file_extract_failed", { name: attachment.name, reason: result.reason });
      return null;
    } catch (err) {
      log("warn", "dmwork.file_read_failed", { url, error: String(err) });
      return null;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  /** 将用户文本 + 文件内容合并为最终问题 */
  private async buildQuestion(userText: string, attachment: FileAttachment | null): Promise<string> {
    if (!attachment) return userText;

    const fileContent = await this.downloadAndReadFile(attachment);
    if (fileContent !== null) {
      const prefix = userText ? `${userText}\n\n` : "";
      return `${prefix}[文件附件: ${attachment.name}]\n\n${fileContent}`;
    }

    // 文件下载失败：如果有 caption，至少回答用户的问题；否则提示文件无法读取
    if (userText) return userText;
    return `[用户发送了文件 ${attachment.name}，文件内容暂时无法读取。如有问题，请直接用文字描述。]`;
  }

  // ── API 调用 ──────────────────────────────────────────────────────────────

  private async sendMessage(channelId: string, channelType: number, text: string): Promise<void> {
    await this.postApi("/v1/bot/sendMessage", {
      channel_id:   channelId,
      channel_type: channelType,
      payload: { type: 1, content: text },
    });
  }

  private async showTyping(channelId: string, channelType: number): Promise<void> {
    await this.postApi("/v1/bot/typing", {
      channel_id:   channelId,
      channel_type: channelType,
    });
  }

  private async postApi(path: string, body: object): Promise<void> {
    try {
      const res = await fetch(`${this.config.apiUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${this.config.botToken}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        log("warn", "dmwork.api_error", { path, status: res.status });
      }
    } catch (err) {
      log("warn", "dmwork.api_failed", { path, error: String(err) });
    }
  }

  private cleanupProcessedIds(now: number): void {
    for (const [id, expiry] of this.processedIds) {
      if (expiry < now) this.processedIds.delete(id);
    }
  }
}
