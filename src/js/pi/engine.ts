import path from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ChatEngine, ReplyContext } from "../core/engine.js";
import type { JPClawConfig, ProviderConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { createPiTools, createSkillTemplate } from "./tools.js";
import { PiSessionStore, type PiSessionMeta, type PiTranscriptEntry } from "./session-store.js";
import { buildPiMemorySnippet, computePiBm25Hits } from "../memory/pi-memory.js";
import type { Bm25Hit } from "../memory/bm25-sqlite.js";
import { writeMemoryFromUserInput } from "../memory/writer.js";
import { enqueueUserIo } from "../memory/io-queue.js";
import { extractFacts } from "../memory/facts.js";
import { loadUserMemory } from "../memory/store.js";
import { detectFactConflicts, type FactConflict } from "../memory/conflicts.js";
import { enhancedMemoryManager } from "../memory/enhanced-memory-manager.js";
import { buildPromptPrelude } from "../shared/prompt-files.js";
import { buildDiscordFeedbackSnippet } from "../feedback/discord-feedback.js";
import { getUserProfile, getOwnerUserId, isOwnerUser } from "../shared/user-config.js";
import { maybeRunSkillFirst } from "../channels/skill-router.js";

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-sonnet-20240620"
};

export class PiEngine implements ChatEngine {
  private readonly tools = createPiTools();
  private readonly sessionStore: PiSessionStore;
  private readonly modelInfo: {
    model: Model<any>;
    provider: string;
    apiKey?: string;
    authHeader?: string;
    authScheme?: string;
  } | null;
  private readonly sessions = new Map<string, Agent>();
  private readonly sessionHeads = new Map<string, string | undefined>();
  private readonly activeBranchByBase = new Map<string, string | undefined>();
  private readonly memorySnippetBySession = new Map<string, string>();
  private readonly promptQueueBySession = new Map<string, Promise<unknown>>();
  private readonly memoryDir = path.resolve(process.cwd(), "sessions", "memory", "users");
  private readonly pendingMemoryUpdateByUser = new Map<
    string,
    { input: string; userName?: string; conflicts: FactConflict[]; expiresAt: number }
  >();
  private readonly bm25CacheBySession = new Map<
    string,
    { query: string; hits: Bm25Hit[]; updatedAt: number }
  >();
  private readonly bm25InFlightBySession = new Map<string, Promise<void>>();

  // P1-NEW-1修复: 定期清理过期session的定时器
  private readonly sessionCleanupInterval: NodeJS.Timeout;
  private readonly SESSION_MAX_IDLE_MS = 2 * 60 * 60 * 1000; // 2小时无活动则清理
  private readonly sessionLastActive = new Map<string, number>(); // 记录每个session的最后活动时间

  constructor(private readonly config: JPClawConfig) {
    this.sessionStore = new PiSessionStore(path.resolve(process.cwd(), "sessions", "pi"));
    this.modelInfo = resolveModelInfo(config);
    if (!this.modelInfo) {
      log("warn", "pi.disabled", { reason: "no_model_or_provider" });
    }

    // P1-NEW-1修复: 每5分钟清理过期session，防止Map无限增长
    this.sessionCleanupInterval = setInterval(() => this.cleanupIdleSessions(), 5 * 60 * 1000);
    this.sessionCleanupInterval.unref();
  }

  /**
   * P1-NEW-1修复: 统一清理指定 sessionKey 的所有 Map 数据
   */
  private purgeSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.sessionHeads.delete(sessionKey);
    this.memorySnippetBySession.delete(sessionKey);
    this.promptQueueBySession.delete(sessionKey);
    this.bm25CacheBySession.delete(sessionKey);
    this.bm25InFlightBySession.delete(sessionKey);
    this.sessionLastActive.delete(sessionKey);
  }

  /**
   * P1-NEW-1修复: 定期清理长时间无活动的 session
   */
  private cleanupIdleSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionKey, lastActive] of this.sessionLastActive.entries()) {
      if (now - lastActive > this.SESSION_MAX_IDLE_MS) {
        this.purgeSession(sessionKey);
        cleaned++;
      }
    }

    // 清理过期的 pendingMemoryUpdate
    for (const [userId, pending] of this.pendingMemoryUpdateByUser.entries()) {
      if (now > pending.expiresAt) {
        this.pendingMemoryUpdateByUser.delete(userId);
      }
    }

    // 清理 activeBranchByBase 中对应已清理 session 的条目
    for (const [baseKey, branch] of this.activeBranchByBase.entries()) {
      if (branch) {
        const sessionKey = `${baseKey}#${branch}`;
        if (!this.sessions.has(sessionKey) && !this.sessionLastActive.has(sessionKey)) {
          this.activeBranchByBase.delete(baseKey);
        }
      }
    }

    if (cleaned > 0) {
      log("info", "pi.session.cleanup", {
        cleaned,
        remainingSessions: this.sessions.size,
        remainingHeads: this.sessionHeads.size,
        remainingSnippets: this.memorySnippetBySession.size,
        remainingBm25Cache: this.bm25CacheBySession.size
      });
    }
  }

  /**
   * P1-NEW-1修复: 记录 session 活动时间
   */
  private touchSession(sessionKey: string): void {
    this.sessionLastActive.set(sessionKey, Date.now());
  }

  recordExternalExchange(input: string, output: string, context: ReplyContext = {}): void {
    const userId = context.userId || "local";
    const channelId = context.channelId || undefined;
    const agentId = context.agentId || undefined;
    const baseKey = this.sessionStore.buildSessionKey(userId, channelId);

    // 构建完整的 sessionKey（包含 branch 和 agentId）
    const branch = this.getActiveBranch(baseKey);
    let sessionKey = branch ? `${baseKey}#${branch}` : baseKey;
    if (agentId) {
      sessionKey = `${sessionKey}::${agentId}`;
    }

    // P1-NEW-1修复: 记录 session 活动时间
    this.touchSession(sessionKey);
    this.recordDeterministicReply(sessionKey, userId, channelId, agentId, input, output);
  }

  async reply(input: string, context: ReplyContext = {}): Promise<string> {
    if (!this.modelInfo) {
      throw new Error("Pi engine unavailable.");
    }
    const userId = context.userId || "local";
    const channelId = context.channelId || undefined;
    const agentId = context.agentId || undefined; // Discord协作bot的角色ID
    const baseKey = this.sessionStore.buildSessionKey(userId, channelId);

    // P1-NEW-1修复: 记录 session 活动时间
    this.touchSession(baseKey);

    // 尽早构建完整的 sessionKey（包含 branch 和 agentId），确保所有路径都使用正确的 session
    const branch = this.getActiveBranch(baseKey);
    let sessionKey = branch ? `${baseKey}#${branch}` : baseKey;

    // 如果有 agentId（Discord 协作 bot），将其加入 sessionKey，确保不同角色使用不同的 agent
    if (agentId) {
      sessionKey = `${sessionKey}::${agentId}`;
    }

    const isOwner = isOwnerUser(userId);
    const fast = fastPathReply(input, isOwner);
    if (fast) return this.recordDeterministicReply(sessionKey, userId, channelId, agentId, input, fast);

    const branchCommand = this.tryHandleBranchCommand(input, baseKey, userId, channelId);
    if (branchCommand) {
      return this.recordDeterministicReply(sessionKey, userId, channelId, agentId, input, branchCommand);
    }

    const skillCommand = this.tryHandleSkillCommand(input);
    if (skillCommand) {
      return this.recordDeterministicReply(sessionKey, userId, channelId, agentId, input, skillCommand);
    }

    const autoSkill = this.tryHandleAutoSkill(input);
    if (autoSkill) {
      return this.recordDeterministicReply(sessionKey, userId, channelId, agentId, input, autoSkill);
    }

    // If we previously detected a conflict for this user, allow them to confirm or discard.
    const pending = this.pendingMemoryUpdateByUser.get(userId);
    if (pending && pending.expiresAt > Date.now()) {
      const decision = this.tryParseMemoryDecision(input);
      if (decision) {
        this.pendingMemoryUpdateByUser.delete(userId);
        if (decision === "reject") {
          return this.recordDeterministicReply(
            sessionKey,
            userId,
            channelId,
            agentId,
            input,
            "收到：不会更新冲突项的长期记忆。"
          );
        }
        const result = writeMemoryFromUserInput({
          memoryDir: this.memoryDir,
          userId,
          userName: pending.userName,
          input: pending.input,
          mode: "explicit"
        });
        const parts: string[] = ["✅ 已确认并更新长期记忆（本地落盘）"];
        const updated: string[] = [];
        if (result.profileUpdated) updated.push("画像");
        if (result.pinnedAdded > 0) updated.push(`pinned+${result.pinnedAdded}`);
        if (result.factsAdded > 0) updated.push(`facts+${result.factsAdded}`);
        if (updated.length) parts.push(`变更: ${updated.join(", ")}`);
        return this.recordDeterministicReply(sessionKey, userId, channelId, agentId, input, parts.join("\n"));
      }
    } else if (pending) {
      this.pendingMemoryUpdateByUser.delete(userId);
    }

    const agent = this.getOrCreateAgent(sessionKey, userId, channelId, agentId);

    // 群聊 session：注入群组频道系统提示（只注入一次，防重复）
    const isGroupSession = userId.startsWith("group:");
    if (isGroupSession) {
      const currentPrompt = agent.state.systemPrompt ?? "";
      const GROUP_ADDENDUM_VERSION = "discover_peers";
      if (!currentPrompt.includes(GROUP_ADDENDUM_VERSION)) {
        // 移除旧版 addendum（如有），注入新版
        const basePrompt = currentPrompt.includes("## 群组频道模式")
          ? currentPrompt.slice(0, currentPrompt.indexOf("\n## 群组频道模式"))
          : currentPrompt;
        const botIdLine = agentId
          ? `你自己的 Bot ID 是 "${agentId}"（调用 peer-ask skill 时用作 from_bot_id）。`
          : "";
        const groupContextAddendum = [
          "",
          "## 群组频道模式",
          "你正在一个群组频道中，消息格式为「[发言人]: 内容」，发言人可以是人类或机器人。",
          "**当你的观点针对某位发言人的具体内容时，应该使用 @发言人名称 明确指向**（如 @正面专家、@反面质疑者、@深度思考者，或 @用户名）。",
          "@mention 是群聊讨论的基本礼仪：质疑要有对象，补充要有来源，这样才能形成真正的对话而不是各说各的。",
          "原则：只在有实质性新贡献时发言；避免重复已有观点；质疑和补充要指向具体内容和具体人。",
          "",
          "## 同伴协作能力",
          botIdLine,
          "你可以使用 discover_peers 工具查看所有同伴 Bot 的专长（specialties）和联系渠道。",
          "当问题超出你的专长范围，且你确信某个同伴更适合处理时，可以：",
          "1. 先告知用户你要去找同伴协助",
          "2. 用 peer-ask skill 向同伴所在频道发出请求（JSON 输入：{from_bot_id, to_channel_id, message}）",
        ].filter(Boolean).join("\n");
        agent.setSystemPrompt(basePrompt + groupContextAddendum);
      }
    }

    // Try AI-powered skill routing before other processing
    const skillRouterContext = {
      userId,
      userName: context.userName || "Unknown",
      channelId: channelId || "unknown",
      traceId: context.traceId
    };
    // 群聊场景下 input 包含历史消息，只取最新用户消息传给 skill-router
    // 防止 LLM 从历史上下文中提取错误的参数（如把历史里的"北京"当成当前城市）
    const NEW_MSG_SEP = "---\n当前需要回答的新消息：\n";
    const rawForSkillRouter = input.includes(NEW_MSG_SEP)
      ? input.slice(input.lastIndexOf(NEW_MSG_SEP) + NEW_MSG_SEP.length).trim()
      : input;
    const skillRouted = await maybeRunSkillFirst(this, rawForSkillRouter, skillRouterContext);
    if (skillRouted) {
      // 二进制/文件类 skill（robot_gif、file_attachment）直接透传给 bot handler 拦截处理，
      // 不经过 LLM 综合——否则 LLM 会把 JSON 翻译成自然语言，导致文件无法发出。
      if (isBinarySkillResult(skillRouted)) {
        return skillRouted;
      }

      // skill 数据已通过 recordExternalExchange 写入 agent 历史。
      // 追加综合指令，让 LLM 基于工具数据给出针对原始问题的完整答复，
      // 而不是机械地直接返回原始工具输出。
      return this.enqueuePrompt(sessionKey, async () => {
        await this.maybeUpdateSystemPromptWithMemory(agent, sessionKey, userId, context.userName, input);
        const prevLen = agent.state.messages.length;
        const synthesisInstruction = `请直接回答用户的问题："${input}"。基于上方工具数据给出结论，不要重复展示原始数据。`;
        try {
          await agent.prompt(synthesisInstruction);
          const text = extractLastAssistantText(agent.state.messages);
          this.saveSession(sessionKey, userId, channelId, agent.state.messages);
          this.appendTranscript(sessionKey, agent.state.messages.slice(prevLen));
          return text.trim() || skillRouted;
        } catch (error) {
          log("error", "pi.skill_synthesis.failed", { error: String(error) });
          return skillRouted; // fallback：出错时返回原始 skill 输出
        }
      });
    }

    this.refreshBm25Cache(sessionKey, userId, context.userName, input);

    // Persist long-term memory side-effects to the shared memory store.
    // This makes "请记住/记忆下来" durable across restarts and engines.
    const memoryWriteRequested = /记住|记忆|保存|长期记住|帮我记下来|请你帮我记忆下来|以后都按这个/i.test(
      input.trim()
    );

    // For explicit memory updates, handle conflicts before we involve the model.
    // This avoids misleading "already updated" replies when we actually require confirmation.
    if (memoryWriteRequested) {
      const conflictText = this.tryPrepareConflictPrompt(userId, context.userName, input);
      if (conflictText) {
        return this.recordDeterministicReply(sessionKey, userId, channelId, agentId, input, conflictText);
      }
    }

    // If the user is primarily updating memory (not asking a question), handle it deterministically:
    // write to the shared store and return a crisp confirmation without involving the model.
    if (memoryWriteRequested && this.isPureMemoryUpdate(input)) {
      // ✅ 使用新的统一记忆系统
      try {
        await enhancedMemoryManager.updateMemory(userId, input, {
          importance: 0.8,  // 显式记忆请求，重要性较高
          autoResolveConflicts: true
        });

        // Refresh snippet now that memory has changed.
        await this.maybeUpdateSystemPromptWithMemory(agent, sessionKey, userId, context.userName, input);

        return this.recordDeterministicReply(
          sessionKey,
          userId,
          channelId,
          agentId,
          input,
          "✅ 已写入长期记忆（向量存储）"
        );
      } catch (error) {
        log("error", "Memory update failed", { error: String(error), userId });
        return this.recordDeterministicReply(
          sessionKey,
          userId,
          channelId,
          agentId,
          input,
          "❌ 记忆写入失败：" + String(error)
        );
      }
    }

    const direct = this.tryDirectProfileAnswer(input, userId, context.userName);
    if (direct) return this.recordDeterministicReply(sessionKey, userId, channelId, agentId, input, direct);

    // 技能咨询类问题直接回答，不进入PI模型，避免误调用工具
    const isCapabilityQuestion = this.looksLikeCapabilityQuestion(input);
    if (isCapabilityQuestion) {
      const skillsAnswer = this.buildSkillsRecommendation(input);
      return this.recordDeterministicReply(sessionKey, userId, channelId, agentId, input, skillsAnswer);
    }

    return this.enqueuePrompt(sessionKey, async () => {
      // Inject durable memory snippet into the system prompt so Pi can answer personal/profile questions reliably.
      await this.maybeUpdateSystemPromptWithMemory(agent, sessionKey, userId, context.userName, input);

      const prevLen = agent.state.messages.length;
      try {
        await agent.prompt(input);
        const text = extractLastAssistantText(agent.state.messages);
        if (!text.trim()) {
          return "（Pi）没有生成可用回复。";
        }

        // Persist memory side-effects after a successful prompt.
        // For explicit "记住/记忆下来" updates: write to new unified memory system.
        // For implicit updates: extract facts and write silently to keep memory fresh.
        // P0-NEW-6修复: 用户显式请求记忆写入时，await 确保数据不丢失
        if (memoryWriteRequested) {
          try {
            await enhancedMemoryManager.updateMemory(userId, input, {
              importance: 0.7,
              autoResolveConflicts: true
            });
          } catch (error) {
            log("error", "pi.memory_write.failed", {
              error: String(error),
              userId,
              inputLength: input.length
            });
            // 不抛出异常，避免影响对话回复，但记录为 error 级别
          }
        }

        this.saveSession(sessionKey, userId, channelId, agent.state.messages);
        this.appendTranscript(sessionKey, agent.state.messages.slice(prevLen));
        await this.maybeCompactSession(agent, sessionKey, userId, channelId);
        return text.trim();
      } catch (error) {
        log("error", "pi.reply.failed", { error: String(error) });
        const newMessages = agent.state.messages.slice(prevLen);
        if (newMessages.length) {
          this.saveSession(sessionKey, userId, channelId, agent.state.messages);
          this.appendTranscript(sessionKey, newMessages);
        }
        throw error;
      }
    });
  }

  private recordLocalExchange(
    sessionKey: string,
    userId: string,
    channelId: string | undefined,
    agent: Agent,
    input: string,
    output: string
  ): void {
    const now = Date.now();
    const userMsg: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: input }],
      timestamp: now
    } as any;
    const assistantMsg: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: output }],
      timestamp: now
    } as any;

    agent.state.messages.push(userMsg, assistantMsg);
    this.saveSession(sessionKey, userId, channelId, agent.state.messages);
    this.appendTranscript(sessionKey, [userMsg, assistantMsg]);
  }

  private recordDeterministicReply(
    sessionKey: string,
    userId: string,
    channelId: string | undefined,
    agentId: string | undefined,
    input: string,
    output: string
  ): string {
    const agent = this.getOrCreateAgent(sessionKey, userId, channelId, agentId);
    this.recordLocalExchange(sessionKey, userId, channelId, agent, input, output);
    return output;
  }

  private enqueuePrompt<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.promptQueueBySession.get(sessionKey) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.promptQueueBySession.set(sessionKey, run.then(() => undefined, () => undefined));
    return run;
  }

  private isPureMemoryUpdate(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed) return false;
    // If the user includes a direct question, we should still answer with the model.
    if (/[?？]/.test(trimmed)) return false;
    // Very small heuristic: memory-only updates are typically short labeled lines.
    const lines = trimmed
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (lines.length <= 1) return false;
    const labels = ["使命", "愿景", "合一模型", "天赋", "一件事", "具体操作", "价值观"];
    const labeled = lines.filter((l) => labels.some((k) => l.startsWith(`${k}`)));
    return labeled.length >= 2;
  }

  private tryParseMemoryDecision(input: string): "confirm" | "reject" | null {
    const t = input.trim();
    if (!t) return null;
    if (/^(确认更新|确认|更新|是|yes|y)$/i.test(t)) return "confirm";
    if (/^(不要更新|别更新|否|不|no|n)$/i.test(t)) return "reject";
    return null;
  }

  private tryPrepareConflictPrompt(userId: string, userName: string | undefined, input: string): string | null {
    const incomingFacts = extractFacts(input);
    if (incomingFacts.length === 0) return null;
    const memory = loadUserMemory(this.memoryDir, userId, userName);
    const existing = [...(memory.longTerm || []), ...(memory.pinnedNotes || [])];
    const conflicts = detectFactConflicts(existing, incomingFacts);
    if (conflicts.length === 0) return null;

    this.pendingMemoryUpdateByUser.set(userId, {
      input,
      userName,
      conflicts,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    const lines = conflicts.map((c) => `- ${c.key}: 记忆=${c.prev} | 当前=${c.next}`);
    return [
      "检测到与长期记忆可能冲突的事实项：",
      ...lines,
      "是否用“当前输入”覆盖长期记忆？回复：确认更新 / 不要更新"
    ].join("\n");
  }

  private getOrCreateAgent(sessionKey: string, userId: string, channelId?: string, agentId?: string): Agent {
    const cached = this.sessions.get(sessionKey);
    if (cached) {
      log("debug", "pi.agent.cache_hit", { sessionKey, agentId });
      return cached;
    }

    const agent = new Agent({
      getApiKey: (provider) => this.resolveApiKey(provider),
      sessionId: `pi_${this.sessionStore.hashSessionKey(sessionKey)}`
    });

    // 优先使用传入的agentId（Discord协作bot），否则从channelId中提取（FixedAgentEngine虚拟channel）
    const effectiveAgentId = agentId || extractAgentIdFromChannel(channelId);

    log("info", "pi.agent.created", {
      sessionKey,
      agentId: effectiveAgentId,
      userId,
      channelId
    });

    const isOwner = isOwnerUser(userId);
    const prelude = buildPromptPrelude({ isOwner });
    const systemPrompt = buildSystemPrompt(undefined, undefined, prelude, effectiveAgentId);
    agent.setSystemPrompt(systemPrompt);
    agent.setModel(this.modelInfo!.model);
    agent.setTools(this.tools);

    const thinkingLevel = resolveThinkingLevel();
    if (thinkingLevel) {
      agent.setThinkingLevel(thinkingLevel);
    }

    const previous = this.sessionStore.loadSession(sessionKey);
    if (previous?.messages?.length) {
      const sanitized = sanitizeMessagesForModel(previous.messages);
      if (sanitized.length !== previous.messages.length) {
        log("warn", "pi.session.sanitized", {
          sessionKey,
          before: previous.messages.length,
          after: sanitized.length
        });
        // Persist a cleaned snapshot so future runs do not re-load poisoned history.
        const now = new Date().toISOString();
        this.sessionStore.saveSession({
          ...previous,
          messages: sanitized,
          updatedAt: now
        });
      }

      // 固定窗口滑动：限制协作 bot 的上下文在 4-8K tokens（约 20 条消息）
      let messagesToLoad = sanitized;
      if (agentId === "expert" || agentId === "critic" || agentId === "thinker") {
        const MAX_MESSAGES_FOR_COLLAB = 20;  // 约 4-8K tokens
        if (sanitized.length > MAX_MESSAGES_FOR_COLLAB) {
          messagesToLoad = sanitized.slice(-MAX_MESSAGES_FOR_COLLAB);
          log("info", "pi.session.window_sliding", {
            sessionKey,
            agentId,
            totalMessages: sanitized.length,
            loadedMessages: messagesToLoad.length,
            droppedMessages: sanitized.length - messagesToLoad.length
          });
        }
      }

      agent.replaceMessages(messagesToLoad);
    }
    if (previous?.summary) {
      agent.setSystemPrompt(buildSystemPrompt(previous.summary, undefined, prelude, agentId));
    }

    this.sessions.set(sessionKey, agent);
    if (!this.sessionHeads.has(sessionKey)) {
      const index = this.sessionStore.loadSessionsIndex();
      this.sessionHeads.set(sessionKey, index[sessionKey]?.headId);
    }
    return agent;
  }

  private async maybeUpdateSystemPromptWithMemory(
    agent: Agent,
    sessionKey: string,
    userId: string,
    userName: string | undefined,
    input: string
  ): Promise<void> {
    const isOwner = isOwnerUser(userId);

    // ✅ 使用新的统一记忆系统
    let memorySnippet = "";
    try {
      // 使用enhancedMemoryManager检索和格式化记忆
      const distilled = await enhancedMemoryManager.distillMemoriesForContext(
        userId,
        input,
        8000  // maxTokens
      );
      memorySnippet = distilled.distilled;

      log("debug", "Memory distilled for context", {
        userId,
        tokensUsed: distilled.tokensUsed,
        sourcesCount: distilled.sources.length
      });
    } catch (error) {
      // Fallback to old system if new system fails
      log("warn", "Memory distillation failed, using fallback", { error: String(error) });
      const cached = this.bm25CacheBySession.get(sessionKey);
      memorySnippet = buildPiMemorySnippet({
        memoryDir: this.memoryDir,
        userId,
        userName,
        input,
        isOwner,
        bm25Hits: cached?.hits
      });
    }

    const feedbackSnippet = buildDiscordFeedbackSnippet(userId);
    const prev = this.memorySnippetBySession.get(sessionKey) || "";
    const combined = [memorySnippet.trim(), feedbackSnippet.trim()].filter(Boolean).join("\n\n").trim();
    if (combined === prev) return;
    this.memorySnippetBySession.set(sessionKey, combined);
    const summary = this.sessionStore.loadSession(sessionKey)?.summary;
    const prelude = buildPromptPrelude({ isOwner });
    const agentId = extractAgentIdFromSessionKey(sessionKey);
    agent.setSystemPrompt(buildSystemPrompt(summary, combined, prelude, agentId));
  }

  private looksLikeCapabilityQuestion(input: string): boolean {
    const q = input.trim().toLowerCase();
    if (!q) return false;
    
    const capabilityHints = ["skill", "技能", "能力", "会什么", "能做什么", "擅长", "功能", "可以做什么", "支持什么"];
    const askHints = ["哪个", "哪些", "哪一个", "推荐", "最有用", "适合", "怎么用", "如何用", "有什么"];
    const hasCapability = capabilityHints.some(w => q.includes(w));
    const hasAsk = askHints.some(w => q.includes(w));
    
    return hasCapability && hasAsk;
  }

  private buildSkillsRecommendation(input: string): string {
    // TODO: 从context传入userId
    const greeting = ""; // 暂时移除硬编码的称呼
    
    return [
      `${greeting}基于您的问题"${input}"，推荐以下最实用的技能：`,
      "",
      "🔧 **开发类技能**",
      "• `coding-agent` - 编程辅助，代码生成和调试",
      "• `github` - Git仓库管理和协作",
      "• `api-integration` - API集成开发",
      "",
      "🤖 **自动化技能**", 
      "• `browser-automation` - 网页自动化操作",
      "• `email-automation` - 邮件自动处理",
      "• `scheduled-tasks` - 定时任务管理",
      "",
      "📊 **数据处理技能**",
      "• `data-analysis` - 数据分析和可视化", 
      "• `web-scraper` - 网页数据抓取",
      "• `notion` / `obsidian` - 知识管理",
      "",
      "🎯 **我的建议**：根据您的开发需求，优先尝试 `coding-agent` 和 `api-integration`。",
      "",
      "需要我详细介绍某个技能的使用方法吗？"
    ].join("\n");
  }

  private tryDirectProfileAnswer(input: string, userId: string, userName: string | undefined): string | null {
    const isOwner = isOwnerUser(userId);
    const q = input.trim();
    if (!q) return null;

    const wantsProfile =
      /(我的.*(使命|愿景|价值观)|使命愿景|我的使命和愿景|我的使命愿景|我的天赋|合一模型|一件事|具体操作)/.test(q) ||
      /姜平.*(使命|愿景|价值观|天赋|合一|一件事|具体操作)/.test(q);
    if (!wantsProfile) return null;

    const memory = loadUserMemory(this.memoryDir, userId, userName);
    const p = memory.profile || {};
    const prefix = isOwner ? "姜哥，" : "";
    const hasAny =
      Boolean(p.missionShort) ||
      Boolean(p.missionFull) ||
      Boolean(p.vision) ||
      Boolean(p.model) ||
      Boolean(p.talent) ||
      Boolean(p.huiTalent) ||
      Boolean(p.oneThing) ||
      Boolean(p.operation) ||
      (Array.isArray(p.values) && p.values.length > 0);
    if (!hasAny) return null;

    if (/(使命|愿景|价值观)/.test(q)) {
      const lines: string[] = [];
      if (p.missionShort) lines.push(`使命：${p.missionShort}`);
      if (p.missionFull) lines.push(`完整表达：${p.missionFull}`);
      if (p.vision) lines.push(`愿景：${p.vision}`);
      if (p.model) lines.push(`合一模型：${p.model}`);
      if (p.talent) lines.push(`天赋：${p.talent}`);
      if (p.huiTalent) lines.push(`辉哥（吴明辉）的天赋：${p.huiTalent}`);
      if (p.oneThing) lines.push(`一件事：${p.oneThing}`);
      if (p.operation) lines.push(`具体操作：${p.operation}`);
      if (Array.isArray(p.values) && p.values.length) lines.push(`价值观：${p.values.join(" / ")}`);
      if (lines.length === 0) return null;
      return `${prefix}${lines.join("\n")}`;
    }

    if (/合一模型|模型/.test(q) && p.model) return `${prefix}合一模型：${p.model}`;
    if (/天赋/.test(q)) {
      const lines: string[] = [];
      if (p.talent) lines.push(`姜平的天赋：${p.talent}`);
      if (p.huiTalent) lines.push(`辉哥（吴明辉）的天赋：${p.huiTalent}`);
      if (lines.length === 0) return null;
      return `${prefix}${lines.join("\n")}`;
    }
    if (/一件事/.test(q) && p.oneThing) return `${prefix}一件事：${p.oneThing}`;
    if (/具体操作/.test(q) && p.operation) return `${prefix}具体操作：${p.operation}`;
    if (/价值观/.test(q) && Array.isArray(p.values) && p.values.length) return `${prefix}价值观：${p.values.join(" / ")}`;
    return null;
  }

  private refreshBm25Cache(
    sessionKey: string,
    userId: string,
    userName: string | undefined,
    input: string
  ): void {
    const query = input.trim();
    if (!query) return;

    const cached = this.bm25CacheBySession.get(sessionKey);
    if (cached && cached.query === query) return;

    const inFlight = this.bm25InFlightBySession.get(sessionKey);
    if (inFlight) return;

    const isOwner = isOwnerUser(userId);
    const task = (async () => {
      const hits = await computePiBm25Hits({
        memoryDir: this.memoryDir,
        userId,
        userName,
        query,
        isOwner
      });
      this.bm25CacheBySession.set(sessionKey, { query, hits, updatedAt: Date.now() });
    })()
      .catch((error) => {
        log("warn", "pi.bm25_cache.failed", { error: String(error), userId });
      })
      .finally(() => {
        this.bm25InFlightBySession.delete(sessionKey);
      });

    this.bm25InFlightBySession.set(sessionKey, task);
  }

  private resolveApiKey(provider: string): string | undefined {
    if (provider === this.modelInfo?.provider) {
      return this.modelInfo.apiKey;
    }
    return undefined;
  }

  private saveSession(
    sessionKey: string,
    userId: string,
    channelId: string | undefined,
    messages: AgentMessage[]
  ): void {
    const now = new Date().toISOString();
    const summary = this.sessionStore.loadSession(sessionKey)?.summary;
    this.sessionStore.saveSession({
      sessionKey,
      userId,
      channelId,
      messages,
      summary,
      updatedAt: now,
      schemaVersion: 2
    });

    const index = this.sessionStore.loadSessionsIndex();
    const meta: PiSessionMeta = {
      sessionKey,
      userId,
      channelId,
      headId: this.sessionHeads.get(sessionKey),
      createdAt: index[sessionKey]?.createdAt || now,
      updatedAt: now
    };
    this.sessionStore.updateSessionsIndex(meta);
  }

  private appendTranscript(sessionKey: string, messages: AgentMessage[]): void {
    if (!messages.length) return;
    let parentId = this.sessionHeads.get(sessionKey);
    const entries: PiTranscriptEntry[] = [];
    for (const message of messages) {
      const id = this.sessionStore.createEntryId();
      const entry: PiTranscriptEntry = {
        id,
        parentId,
        sessionKey,
        role: (message as any)?.role || "unknown",
        timestamp: extractTimestamp(message),
        text: extractMessageText(message),
        message
      };
      entries.push(entry);
      parentId = id;
    }
    this.sessionHeads.set(sessionKey, parentId);
    this.sessionStore.appendTranscript(entries);
  }

  private getActiveBranch(baseKey: string): string | undefined {
    const cached = this.activeBranchByBase.get(baseKey);
    if (cached !== undefined) return cached || undefined;
    const index = this.sessionStore.loadSessionsIndex();
    const branch = index[baseKey]?.activeBranch;
    if (branch) {
      this.activeBranchByBase.set(baseKey, branch);
      return branch;
    }
    this.activeBranchByBase.set(baseKey, "");
    return undefined;
  }

  private setActiveBranch(baseKey: string, branch?: string): void {
    this.activeBranchByBase.set(baseKey, branch || "");
    const index = this.sessionStore.loadSessionsIndex();
    const now = new Date().toISOString();
    const baseMeta: PiSessionMeta = {
      sessionKey: baseKey,
      userId: index[baseKey]?.userId || baseKey.split("::")[0] || "unknown",
      channelId: index[baseKey]?.channelId,
      headId: index[baseKey]?.headId,
      activeBranch: branch || undefined,
      createdAt: index[baseKey]?.createdAt || now,
      updatedAt: now
    };
    this.sessionStore.updateSessionsIndex(baseMeta);
  }

  private tryHandleBranchCommand(
    input: string,
    baseKey: string,
    userId: string,
    channelId?: string
  ): string | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/branch")) return null;
    const parts = trimmed.split(/\s+/).slice(1);
    const name = parts.join(" ").trim();
    if (!name) {
      const current = this.getActiveBranch(baseKey);
      const branches = this.sessionStore
        .listBranchKeys(baseKey)
        .map((key) => key.split("#")[1])
        .filter(Boolean);
      return [
        `当前分支：${current || "default"}`,
        branches.length ? `已有分支：${branches.join(", ")}` : "暂无其他分支"
      ].join("\n");
    }
    if (name === "default" || name === "main") {
      this.setActiveBranch(baseKey);
      return "已切回默认分支。";
    }
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
      return "分支名仅支持字母/数字/-/_，且需以字母或数字开头。";
    }
    this.setActiveBranch(baseKey, name);
    const sessionKey = `${baseKey}#${name}`;
    this.getOrCreateAgent(sessionKey, userId, channelId);
    return `已切换到分支：${name}`;
  }

  private tryHandleSkillCommand(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/skill")) return null;
    const rest = trimmed.replace(/^\/skill\s*/i, "");
    if (!rest) {
      return [
        "用法：/skill <name> [description] [--overwrite]",
        "示例：/skill web-summary 生成网页摘要"
      ].join("\n");
    }
    const tokens = rest.split(/\s+/);
    const name = tokens.shift() || "";
    let descriptionParts: string[] = [];
    let overwrite = false;
    for (const token of tokens) {
      if (token === "--overwrite") {
        overwrite = true;
        continue;
      }
      descriptionParts.push(token);
    }
    const description = descriptionParts.join(" ").trim();
    try {
      const created = createSkillTemplate({
        name,
        description: description || undefined,
        overwrite
      });
      return `已创建技能模板：skills/${created.name}/`;
    } catch (error) {
      return `创建技能失败：${String(error)}`;
    }
  }


  private tryHandleAutoSkill(input: string): string | null {
    const enabled = String(process.env.JPCLAW_AUTO_SKILL_ENABLED || "").toLowerCase();
    if (!(enabled === "1" || enabled === "true" || enabled === "yes" || enabled === "on")) {
      return null;
    }
    const trimmed = input.trim();
    if (!shouldAutoSkill(trimmed)) return null;
    const name = suggestSkillName(trimmed);
    try {
      const created = createSkillTemplate({
        name,
        description: trimmed.slice(0, 120)
      });
      return [
        `检测到可复用任务，已自动生成技能模板：skills/${created.name}/`,
        "请告诉我需要的输入/输出与执行步骤，我会完善技能并运行。"
      ].join("\n");
    } catch (error) {
      return `自动生成技能失败：${String(error)}`;
    }
  }

  private async maybeCompactSession(
    agent: Agent,
    sessionKey: string,
    userId: string,
    channelId?: string
  ): Promise<void> {
    const maxMessages = Number(process.env.JPCLAW_PI_MAX_MESSAGES || "80");
    const keepMessages = Number(process.env.JPCLAW_PI_KEEP_MESSAGES || "30");
    if (agent.state.messages.length <= maxMessages) return;
    const messages = agent.state.messages;
    const cutoff = Math.max(0, messages.length - keepMessages);
    if (cutoff === 0) return;
    const toSummarize = messages.slice(0, cutoff);
    const summary = await this.summarizeMessages(toSummarize);
    if (!summary.trim()) return;

    const now = new Date().toISOString();
    const existing = this.sessionStore.loadSession(sessionKey);
    this.sessionStore.saveSession({
      sessionKey,
      userId,
      channelId,
      messages: messages.slice(cutoff),
      summary,
      updatedAt: now,
      schemaVersion: 2
    });

    agent.replaceMessages(messages.slice(cutoff));
    const isOwner = isOwnerUser(userId);
    const prelude = buildPromptPrelude({ isOwner });
    const cachedMemorySnippet = this.memorySnippetBySession.get(sessionKey) || "";
    const agentId = extractAgentIdFromSessionKey(sessionKey);
    agent.setSystemPrompt(buildSystemPrompt(summary, cachedMemorySnippet, prelude, agentId));

    const summaryEntry: PiTranscriptEntry = {
      id: this.sessionStore.createEntryId(),
      parentId: this.sessionHeads.get(sessionKey),
      sessionKey,
      role: "summary",
      timestamp: Date.now(),
      text: summary,
      message: {
        role: "assistant",
        content: [{ type: "text", text: summary }],
        api: this.modelInfo!.model.api,
        provider: this.modelInfo!.model.provider,
        model: this.modelInfo!.model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop",
        timestamp: Date.now()
      } as any
    };
    this.sessionHeads.set(sessionKey, summaryEntry.id);
    this.sessionStore.appendTranscript([summaryEntry]);

    const index = this.sessionStore.loadSessionsIndex();
    const meta: PiSessionMeta = {
      sessionKey,
      userId,
      channelId,
      headId: summaryEntry.id,
      activeBranch: index[sessionKey]?.activeBranch,
      createdAt: index[sessionKey]?.createdAt || now,
      updatedAt: now
    };
    this.sessionStore.updateSessionsIndex(meta);
  }

  private async summarizeMessages(messages: AgentMessage[]): Promise<string> {
    const maxChars = Number(process.env.JPCLAW_PI_SUMMARY_MAX_CHARS || "6000");
    const summaryAgent = new Agent({
      getApiKey: (provider) => this.resolveApiKey(provider),
      sessionId: `pi_summary_${Date.now()}`
    });
    summaryAgent.setModel(this.modelInfo!.model);
    summaryAgent.setTools([]);
    let text = messages
      .map((msg) => {
        const role = (msg as any)?.role || "unknown";
        const content = extractMessageText(msg) || "";
        if (!content) return "";
        return `${role}: ${content}`;
      })
      .filter(Boolean)
      .join("\n");
    if (text.length > maxChars) {
      text = text.slice(-maxChars);
    }
    // 检测是否为群聊消息（群聊消息包含「[发言人]: 内容」或「【发言人 [Bot]】：内容」格式）
    const isGroupContent = /\[.+?\][:：]/.test(text);
    const summarySystemPrompt = isGroupContent
      ? "你是对话摘要助手，请输出5-8条要点，保留发言人归属，格式：「发言人：要点内容」。保留关键观点、任务分配和决策结论。"
      : "你是对话摘要助手，请输出5-8条要点，尽量保留任务、约束、结论与后续动作。";
    summaryAgent.setSystemPrompt(summarySystemPrompt);
    await summaryAgent.prompt(`请总结以下对话：\n${text}`);
    return extractLastAssistantText(summaryAgent.state.messages).trim();
  }
}

function sanitizeMessagesForModel(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const cleaned: AgentMessage[] = [];
  const openToolCalls = new Set<string>();

  for (const message of messages) {
    const role = (message as any)?.role;
    const content = Array.isArray((message as any)?.content) ? (message as any).content : [];

    // Drop known-bad empty assistant error stubs from old runs.
    if (
      role === "assistant" &&
      content.length === 0 &&
      String((message as any)?.stopReason || "").toLowerCase() === "error"
    ) {
      continue;
    }

    if (role === "assistant") {
      for (const item of content) {
        if (item?.type === "toolCall" && typeof item.id === "string" && item.id) {
          openToolCalls.add(item.id);
        }
      }
      cleaned.push(message);
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = (message as any)?.toolCallId;
      if (typeof toolCallId !== "string" || !toolCallId) continue;
      if (!openToolCalls.has(toolCallId)) continue;
      openToolCalls.delete(toolCallId);
      cleaned.push(message);
      continue;
    }

    cleaned.push(message);
  }

  return cleaned;
}

function resolveModelInfo(config: JPClawConfig): {
  model: Model<any>;
  provider: string;
  apiKey?: string;
  authHeader?: string;
  authScheme?: string;
} | null {
  const envProvider = process.env.JPCLAW_PI_PROVIDER;
  const envModel = process.env.JPCLAW_PI_MODEL;
  const providerConfig = pickProvider(config, envProvider);
  if (!providerConfig && !envProvider) return null;

  const provider = (envProvider || providerConfig?.type || "").toLowerCase();
  if (!provider) return null;

  const apiKey = providerConfig?.apiKey || undefined;
  const authHeader = providerConfig?.authHeader;
  const authScheme = providerConfig?.authScheme;
  const baseUrl = providerConfig?.baseUrl;
  const requestedModel = envModel || providerConfig?.model || DEFAULT_MODEL_BY_PROVIDER[provider];
  if (!requestedModel) return null;

  let model: Model<any>;
  try {
    model = getModel(provider as any, requestedModel as any);
  } catch {
    const fallbackModel = DEFAULT_MODEL_BY_PROVIDER[provider];
    if (!fallbackModel) return null;
    model = getModel(provider as any, fallbackModel as any);
  }

  const nextModel: Model<any> = {
    ...model,
    baseUrl: baseUrl || model.baseUrl
  };

  if (authHeader && apiKey) {
    const headerValue = authScheme ? `${authScheme} ${apiKey}` : apiKey;
    nextModel.headers = { ...(nextModel.headers || {}), [authHeader]: headerValue };
  }

  return { model: nextModel, provider, apiKey, authHeader, authScheme };
}

function pickProvider(
  config: JPClawConfig,
  preferred?: string
): ProviderConfig | undefined {
  const providers = config.providers.filter((entry) => entry.apiKey);
  if (!providers.length) return undefined;
  if (preferred) {
    const match = providers.find((entry) => entry.type === preferred);
    if (match) return match;
  }
  return providers[0];
}

function buildSystemPrompt(summary?: string, memorySnippet?: string, prelude?: string, agentId?: string): string {
  // 根据agentId选择角色提示词
  const rolePrompt = buildRolePrompt(agentId);

  if (agentId) {
    log("debug", "pi.system_prompt.role_applied", {
      agentId,
      rolePromptLength: rolePrompt.length
    });
  }

  const base = [
    prelude,
    rolePrompt,
    "你有基础工具（read_file, write_file, edit_file, list_dir, search_text, run_shell, create_skill_template, web_search）和动态注册的技能工具（有实现代码的 skills）。",
    "只有具备真实实现的技能才会被注册为工具，你可以直接调用它们。",
    "如果某个任务没有对应的专用工具，请灵活使用现有工具完成。例如：需要实时信息时使用 web_search。",
    "当任务具备可复用性或多步重复时，优先创建/完善技能，再运行技能完成任务。",
    "务必先读再改，文件路径必须是 workspace 内相对路径。",
    "如果需要执行系统命令，优先用 run_shell，输出要精炼。",
    "",
    "**工具使用优先级（重要）：**",
    "1. **记忆系统优先**：当回答与用户个人信息、历史对话、用户偏好相关的问题时，记忆系统中已有的信息是最可靠的，必须优先查询记忆",
    "2. **本地优先于网络**：优先使用本地工具（文件读写、记忆查询），再考虑网络工具（web_search）",
    "3. **web_search仅用于最新信息**：只有当记忆系统中没有相关信息，且确实需要实时/最新数据时，才使用web_search",
    "",
    "可用显式分支命令：/branch <name>（切换）或 /branch（查看）。",
    "",
    "**🔑 重要：工具调用规范**",
    "- ❌ **绝对禁止输出任何 XML/HTML 格式的标签**（包括但不限于：<function_calls>、<invoke>、<parameter>、<search>、<query>、<weather_query>、<tool_use> 等任何 <xxx>...</xxx> 格式）",
    "- ❌ **绝对禁止输出 [待API返回]、[等待结果]、[待返回]、X°C、Y°C 等占位符**",
    "- ❌ **绝对禁止输出 JSON、XML 等结构化查询文本**（工具调用是内部机制，用户不应看到）",
    "- ✅ **直接使用 Agent SDK 的 tool use 机制调用工具**（用户只看到最终结果）",
    "- ✅ **需要多次查询时（如查询多个城市天气）**：",
    "  - 方式1：多次调用同一工具（推荐）",
    "  - 方式2：将多个参数合并为一次输入（如 input: '北京,天津'）",
    "  - 方式3：如果工具不支持，告知用户需要分别查询",
    "- 技能推荐、能力咨询类问题（如'哪个skill最有用'、'你会什么'）：直接用自然语言回答，禁止调用工具",
    "- 元问题、建议咨询、'介绍一下'类问题：直接回答，不调用工具",
    "- 只有明确的任务执行需求（如'帮我写代码'、'查找文件'、'搜索实时信息'）才调用相应工具",
    "- 当不确定是否应该调用工具时，优先选择自然语言回答",
    "- 绝对禁止：为了技能推荐而调用技能工具",
    "",
    "补充约束：当任务明确（如读文件、查询、生成代码）时直接执行；只有当任务本身不清楚时才确认；绝不输出虚构结果或来源。"
  ].filter((x) => String(x || "").trim().length > 0);
  if (memorySnippet?.trim()) {
    base.push(memorySnippet.trim());
  }
  if (summary?.trim()) {
    base.push(`历史摘要：\n${summary.trim()}`);
  }
  return base.join("\n");
}

/**
 * 根据agentId构建角色专属的系统提示词
 */
/**
 * 从channelId中提取agentId（FixedAgentEngine创建的虚拟channel格式）
 * 格式：__bot_agent_${agentId}_${originalChannelId}
 */
function extractAgentIdFromChannel(channelId?: string): string | undefined {
  if (!channelId) return undefined;
  const match = channelId.match(/^__bot_agent_([^_]+)_/);
  return match ? match[1] : undefined;
}

/**
 * 从sessionKey中提取agentId
 * 新格式: ${userId}::${channelId}::${agentId} 或 ${userId}::${channelId}#${branchName}::${agentId}
 * 旧格式: ${userId}::${channelId} 或 ${userId}::${channelId}#${branchName}
 */
function extractAgentIdFromSessionKey(sessionKey: string): string | undefined {
  // 移除分支后缀（如果有）
  const baseKey = sessionKey.split('#')[0];
  // 分割成多个部分
  const parts = baseKey.split('::');

  // 新格式：最后一部分是 agentId（如果有的话）
  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1];
    // 检查是否是合法的 agentId（expert/critic/thinker）
    if (lastPart === "expert" || lastPart === "critic" || lastPart === "thinker") {
      return lastPart;
    }
  }

  // 旧格式：从 channelId 中提取（FixedAgentEngine 的虚拟 channel）
  if (parts.length >= 2) {
    const channelId = parts[1];
    return extractAgentIdFromChannel(channelId);
  }

  return undefined;
}

function buildRolePrompt(agentId?: string): string {
  log("debug", "pi.role_prompt.building", { agentId });

  switch (agentId) {
    case "expert":
      return [
        "你是正面专家 (Positive Expert) - JPClaw 团队的核心执行者 🎯",
        "",
        "## 🎯 核心定位",
        "- 主力bot，处理所有日常开发任务",
        "- 积极、高效、全能 - 代码、需求、技术实施一肩挑",
        "- 聚焦解决方案，快速推进任务",
        "",
        "## 💬 回复风格",
        "轻松、清晰、有温度。用emoji+项目符号+代码高亮。150-200字。",
        "",
        "示例：",
        "```",
        "好的！我刚才分析了需求 ✅",
        "",
        "🎯 **推荐方案**",
        "用Redis做缓存，配置 `ttl: 3600`",
        "",
        "✅ **关键点**",
        "• 性能提升10倍",
        "• 成本可控",
        "```"
      ].join("\n");

    case "critic":
      return [
        "你是反面质疑者 (Critical Challenger) - 团队的思维对抗者 🤔",
        "",
        "## 🎯 你的任务",
        "质疑 expert 对**用户问题**的回答内容（观点、逻辑、论据），提出不同角度的思考。",
        "",
        "**⚠️ 核心原则**",
        "- 你要质疑的是：expert 对**用户问题**的回答是否全面、合理、有漏洞",
        "- 聚焦**问题本身**：如果用户问「豆腐脑咸的好吃还是甜的」，你质疑的是 expert 对咸甜之争的观点",
        "- 如果用户问「Redis 缓存方案」，你质疑的是技术方案的合理性",
        "- 如果用户问「我喜欢煎饼果子」，你质疑的是 expert 对这个话题的回答角度",
        "",
        "**❌ 不要质疑：**",
        "- expert 的表达方式、回复格式、字数长短",
        "- 不要评论「对话方式」，聚焦「观点内容」",
        "",
        "## 💬 回复风格",
        "轻松但犀利，用emoji+简短段落。100-150字，指出问题+提替代思路。",
        "",
        "示例（技术问题）：",
        "```",
        "⚠️ **我担心一个点**",
        "Redis缓存如果击穿，DB会扛不住高并发",
        "",
        "💡 **更稳妥的思路**",
        "可以加个布隆过滤器预防缓存穿透",
        "```",
        "",
        "示例（闲聊问题）：",
        "```",
        "🤔 **我有不同看法**",
        "甜豆腐脑也有独特风味啊，南方人的早餐记忆",
        "",
        "💡 **换个角度**",
        "可能不是谁对谁错，而是地域饮食文化差异",
        "```"
      ].join("\n");

    case "thinker":
      return [
        "你是深度思考者 (Deep Thinker) - 团队的哲学家和机会发现者 💭",
        "",
        "## 🎯 你的任务",
        "从**更高层次**看问题：点破用户问题的本质、点破 expert 和 critic 回答内容的本质、发现机会、提供长期视角。",
        "",
        "**⚠️ 绝对禁止谈论以下话题**",
        "❌ AI、agent、bot、系统、对话、multi-agent、协作、反馈、学习、模型",
        "❌ 用户行为、用户动机、用户为什么问、测试、刷屏、重复",
        "❌ 负样本、数据集、系统设计、架构、技术实现",
        "",
        "**✅ 只能谈论**",
        "✅ 用户问题的**内容领域**（食物、技术、文化、商业、社会等）",
        "✅ expert 和 critic 的**观点内容**（他们对问题的看法）",
        "✅ 从**问题领域**延伸的产品、服务、洞察",
        "",
        "**具体要求**",
        "",
        "1. **点破用户问题内容的本质**（只谈问题领域）",
        "   - 用户问「豆腐脑咸的好吃还是甜的」→ 咸甜之争背后是什么？（地域文化差异？饮食哲学？）",
        "   - 用户问「Redis 缓存方案」→ 缓存问题本质是什么？（读写分离？性能瓶颈？）",
        "",
        "2. **点破 expert 和 critic 观点的本质**（只谈观点内容）",
        "   - expert 说「咸党赢」→ 这观点反映了什么？（地域偏见？二元对立？）",
        "   - critic 质疑「凭啥结案」→ 揭示什么价值观？（包容性？开放性？）",
        "",
        "3. **从问题内容延伸机会**（只谈问题领域）",
        "   - 豆腐脑咸甜之争 → 可以做什么？（美食文化地图？地域饮食研究？）",
        "   - Redis 缓存方案 → 可以延伸什么？（性能优化工具？最佳实践库？）",
        "",
        "**思考维度：**",
        "- 抽象思维：整个对话背后的深层逻辑是什么？",
        "- 长期视角：5年后回看，这个问题说明了什么趋势？",
        "- 跨界联想：其他领域如何解决类似矛盾？",
        "- 机会嗅觉：能否从中发现商业价值或社会价值？",
        "",
        "## 💬 回复风格",
        "极简、深刻、有启发。60-100字，一句话点本质+一句话提机会。",
        "",
        "示例（技术问题）：",
        "```",
        "💭 **本质**",
        "这不是技术问题，是团队对'过度设计 vs 快速迭代'的权衡焦虑",
        "",
        "🌟 **机会**",
        "可以做决策框架工具，帮团队量化权衡",
        "```",
        "",
        "示例（闲聊问题 - 豆腐脑咸甜）：",
        "```",
        "💭 **本质**",
        "咸甜之争本质是**地域饮食文化差异的缩影** —— 北方重口味实用主义 vs 南方清淡美学路线，都没错只是不同",
        "",
        "🌟 **机会**",
        "可以做「中国味觉地图」产品，展示各地经典早餐差异，让人理解而非争论",
        "```"
      ].join("\n");

    default:
      return "你是 JPClaw 的 Pi 引擎，内核工具极简但可自我扩展。";
  }
}

function resolveThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const raw = process.env.JPCLAW_PI_THINKING_LEVEL;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (
    ["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)
  ) {
    return normalized as any;
  }
  return undefined;
}

/**
 * 判断 skill 返回值是否为需要直接透传给 bot handler 的二进制/文件类结果。
 * 这类结果不能经过 LLM 综合，否则 JSON 会被翻译成自然语言，文件无法发出。
 */
function isBinarySkillResult(text: string): boolean {
  return text.includes('"type":"robot_gif"') || text.includes('"type":"file_attachment"');
}

function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as any;
    if (message?.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((item: any) => item?.type === "text")
      .map((item: any) => item.text)
      .join("");
    if (text) return text;
  }
  return "";
}

function extractTimestamp(message: AgentMessage): number {
  const raw = (message as any)?.timestamp;
  if (typeof raw === "number") return raw;
  return Date.now();
}

function extractMessageText(message: AgentMessage): string | undefined {
  const role = (message as any)?.role;
  if (role === "user") {
    const content = (message as any)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((item: any) => item?.type === "text")
        .map((item: any) => item.text)
        .join("");
    }
  }
  if (role === "assistant" || role === "toolResult") {
    const content = (message as any)?.content;
    if (Array.isArray(content)) {
      return content
        .filter((item: any) => item?.type === "text")
        .map((item: any) => item.text)
        .join("");
    }
  }
  return undefined;
}

function fastPathReply(input: string, isOwner: boolean): string | null {
  const q = input.trim().toLowerCase();
  if (!q) return isOwner ? "姜哥，我在。" : "我在。";
  const simple = ["在吗", "在么", "在不在", "hi", "hello", "你好", "收到吗", "ping", "test"];
  if (simple.includes(q)) return isOwner ? "姜哥，我在，随时可以开始。" : "我在，随时可以开始。";
  if (q === "1" || q === "ok" || q === "好的") return isOwner ? "收到，姜哥。" : "收到。";
  return null;
}

function shouldAutoSkill(text: string): boolean {
  if (!text) return false;
  if (text.startsWith("/")) return false;
  if (text.length < 20) return false; // 提高门槛，避免简单问句触发
  
  const disableTokens = [
    "演示", "demo", "展示", "答辩", "汇报", "presentation",
    "介绍", "什么", "哪个", "如何", "怎么", "为什么", "是否",
    "请问", "帮我", "告诉我", "给我", "阅读", "查看", "分析",
    "skill", "技能", "对我", "最", "有用", "推荐"
  ];
  if (disableTokens.some((token) => text.toLowerCase().includes(token.toLowerCase()))) {
    return false;
  }
  
  // 需要明确的重复性任务指示词 + 具体动作词的组合
  const batchTriggers = ["批量", "大量", "多个", "反复", "重复执行"];
  const timeTriggers = ["定期", "每天", "每周", "每月", "每小时", "自动化"];
  const processTriggers = ["流程", "批处理", "脚本", "自动"];
  const englishTriggers = ["batch", "automation", "schedule", "repeat"];
  
  const hasBatchWord = batchTriggers.some((t) => text.includes(t));
  const hasTimeWord = timeTriggers.some((t) => text.includes(t));
  const hasProcessWord = processTriggers.some((t) => text.includes(t));
  const hasEnglishWord = englishTriggers.some((t) => text.toLowerCase().includes(t));
  
  // 需要至少包含明确的批量/定时/流程化指示词
  return hasBatchWord || hasTimeWord || hasProcessWord || hasEnglishWord;
}

function suggestSkillName(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
    .trim();
  const english = cleaned
    .split(/\s+/)
    .filter((item) => /[a-z0-9]/.test(item))
    .slice(0, 3)
    .join("-");
  if (english) {
    const candidate = `auto-${english}`.slice(0, 40);
    if (/^[a-z0-9][a-z0-9-_]*$/i.test(candidate)) return candidate;
  }
  const fallback = Date.now().toString(36).slice(-6);
  return `auto-skill-${fallback}`;
}
