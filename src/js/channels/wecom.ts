import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type { ChatEngine } from "../core/engine.js";
import type { WecomChannelConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { runSkill } from "../skills/registry.js";
import { maybeRunSkillFirst } from "./skill-router.js";
import { maybeHandleDocumentSummaryIntent } from "./document-intent.js";
import {
  buildEncryptedReplyXml,
  buildTextReplyXml,
  decryptWecomMessage,
  encryptWecomMessage,
  parseXmlFields,
  verifyWecomSignature
} from "./wecom-crypto.js";

type WecomEvent = {
  msgType: string;
  fromUser: string;
  toUser: string;
  content: string;
  chatId?: string;
  msgId?: string;
};

let cachedToken: { value: string; expiresAt: number } | null = null;
const seenMsgIds = new Map<string, number>();
const WECOM_WORK_TIMEOUT_MS = Number(process.env.WECOM_WORK_TIMEOUT_MS || "4500");
const WECOM_FINAL_TIMEOUT_MS = Number(process.env.WECOM_FINAL_TIMEOUT_MS || "45000");
const WECOM_DEDUPE_WINDOW_MS = Number(process.env.WECOM_DEDUPE_WINDOW_MS || "300000");
const WECOM_FORCE_DIRECT_STYLE = process.env.WECOM_FORCE_DIRECT_STYLE !== "false";

export async function handleWecomWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: WecomChannelConfig | undefined,
  agent: ChatEngine
): Promise<void> {
  if (!config?.enabled) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "wecom_disabled" }));
    return;
  }

  const url = new URL(req.url || "/", "http://127.0.0.1");
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const signature = url.searchParams.get("msg_signature") || "";

  if (req.method === "GET") {
    const echostr = url.searchParams.get("echostr") || "";
    if (!echostr) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("missing_echostr");
      return;
    }
    try {
      if (config.token && config.encodingAesKey) {
        const ok = verifyWecomSignature(signature, config.token, timestamp, nonce, echostr);
        if (!ok) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
          res.end("invalid_signature");
          return;
        }
        const plain = decryptWecomMessage(echostr, config.encodingAesKey, config.corpId || "");
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(plain);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(echostr);
      return;
    } catch (error) {
      log("warn", "wecom.verify.failed", { error: String(error) });
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("verify_failed");
      return;
    }
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const raw = (await readRawBody(req)).toString("utf8");
  try {
    const receiverId =
      process.env.WECOM_RECEIVER_ID || config.corpId || "";
    const event = parseIncomingEvent(raw, {
      token: config.token,
      encodingAesKey: config.encodingAesKey,
      corpId: receiverId,
      timestamp,
      nonce,
      signature
    });

    if (!event || event.msgType !== "text" || !event.content.trim()) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("success");
      return;
    }

    if (event.msgId && isDuplicateMsg(event.msgId)) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("success");
      return;
    }

    log("info", "wecom.message.received", {
      msgType: event.msgType,
      hasChatId: Boolean(event.chatId),
      hasMsgId: Boolean(event.msgId)
    });

    // Acknowledge quickly. Replies are sent via WeCom APIs (appchat/send or message/send).
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("success");
    log("info", "wecom.reply.async_ack", { ok: true });
    setImmediate(() => {
      void processWecomEvent(agent, config, event);
    });
  } catch (error) {
    log("error", "wecom.webhook.failed", { error: String(error) });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("success");
  }
}

export async function sendWecomPing(
  config: WecomChannelConfig | undefined,
  options: { toUser?: string; chatId?: string; text?: string }
): Promise<{ ok: boolean; detail: string }> {
  if (!config?.enabled) {
    return { ok: false, detail: "wecom_disabled" };
  }
  const text = normalizeReply(options.text || "Ping from JPClaw");
  if (!text) return { ok: false, detail: "empty_text" };

  try {
    if (options.chatId) {
      await sendAppChatMessage(config, options.chatId, text);
      return { ok: true, detail: "appchat_sent" };
    }
    if (!options.toUser) {
      return { ok: false, detail: "missing_to_user" };
    }
    await sendDirectMessage(config, options.toUser, text);
    return { ok: true, detail: "direct_sent" };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}

function parseIncomingEvent(
  rawXml: string,
  verify: {
    token?: string;
    encodingAesKey?: string;
    corpId?: string;
    timestamp: string;
    nonce: string;
    signature: string;
  }
): WecomEvent | null {
  let plainXml = rawXml;
  const outer = parseXmlFields(rawXml);
  if (outer.Encrypt) {
    if (!verify.token || !verify.encodingAesKey) {
      throw new Error("wecom_encrypt_config_missing");
    }
    const ok = verifyWecomSignature(
      verify.signature,
      verify.token,
      verify.timestamp,
      verify.nonce,
      outer.Encrypt
    );
    if (!ok) throw new Error("wecom_invalid_signature");
    plainXml = decryptWecomMessage(outer.Encrypt, verify.encodingAesKey, verify.corpId || "");
  }

  const xml = parseXmlFields(plainXml);
  const msgType = (xml.MsgType || "").toLowerCase();
  const fromUser = xml.FromUserName || "";
  const toUser = xml.ToUserName || "";
  const content = xml.Content || "";
  const chatId = xml.ChatId || xml.chatid || "";
  const msgId = xml.MsgId || xml.msgid || "";
  if (!msgType || !fromUser || !toUser) return null;
  return {
    msgType,
    fromUser,
    toUser,
    content,
    chatId: chatId || undefined,
    msgId: msgId || undefined
  };
}

async function processWecomEvent(
  agent: ChatEngine,
  config: WecomChannelConfig,
  event: WecomEvent
): Promise<void> {
  try {
    // Lightweight intent routing: for deterministic tasks, avoid LLM latency and variability.
    // This keeps WeCom replies fast and reliable.
    if (looksLikeSocialStatsIntent(event.content)) {
      const text = await handleSocialStats(event.content);
      if (text.trim()) {
        await sendWecomReply(config, event, text);
        return;
      }
    }

    const docSummary = await maybeHandleDocumentSummaryIntent(agent, event.content, {
      userId: `wecom:${event.fromUser}`,
      userName: event.fromUser,
      channelId: event.chatId || `wecom:${event.toUser}`,
      traceId: event.msgId || undefined
    });
    if (docSummary?.trim()) {
      await sendWecomReply(config, event, docSummary);
      return;
    }

    const skillRouted = await maybeRunSkillFirst(agent, event.content, {
      userId: `wecom:${event.fromUser}`,
      userName: event.fromUser,
      channelId: event.chatId || `wecom:${event.toUser}`,
      traceId: event.msgId || undefined
    });
    if (skillRouted?.trim()) {
      await sendWecomReply(config, event, skillRouted);
      return;
    }

    const input = WECOM_FORCE_DIRECT_STYLE ? buildDirectWecomPrompt(event.content) : event.content;
    const replyPromise = agent
      .reply(input, {
        userId: `wecom:${event.fromUser}`,
        userName: event.fromUser,
        channelId: event.chatId || `wecom:${event.toUser}`
      })
      .then((text) => String(text || ""))
      .catch((error) => {
        log("warn", "wecom.reply.failed", { error: String(error) });
        return "";
      });

    const fast = await withTimeout(replyPromise, WECOM_WORK_TIMEOUT_MS).catch(() => "");
    if (fast.trim()) {
      await sendWecomReply(config, event, fast);
      return;
    }

    // Send interim ack when model is still working, then send final reply when ready.
    await sendWecomReply(config, event, "收到，我在处理。");

    const final = await withTimeout(replyPromise, WECOM_FINAL_TIMEOUT_MS).catch(() => "");
    if (final.trim()) {
      await sendWecomReply(config, event, final);
    } else {
      log("warn", "wecom.reply.timeout", { chatId: event.chatId ? "yes" : "no" });
    }
  } catch (error) {
    log("error", "wecom.process.failed", {
      error: String(error),
      chatId: event.chatId ? "yes" : "no"
    });
  }
}

function looksLikeSocialStatsIntent(input: string): boolean {
  const lower = input.toLowerCase();
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
  return (hasUrl && hasSocialWord) || (hasPlatformHint && hasSocialWord);
}

async function handleSocialStats(raw: string): Promise<string> {
  const urlMatch = raw.match(/https?:\/\/\S+/);
  const url = urlMatch?.[0] || process.env.JPCLAW_PROFILE_URL;
  if (!url) return "";

  const storageStatePath =
    process.env.JPCLAW_SOCIAL_STORAGE_STATE || "sessions/social/storage.json";

  const output = await runSkill(
    "social-stats",
    JSON.stringify({
      url,
      storageStatePath,
      interactiveLogin: false
    })
  );

  try {
    const parsed = JSON.parse(output);
    const counts = parsed?.counts || {};
    if (counts.followers || counts.following || counts.likes || counts.comments || counts.praises) {
      return [
        `主页数据（${new Date(parsed.fetchedAt || Date.now()).toLocaleString()}）`,
        `被关注/粉丝：${counts.followers ?? "未知"}`,
        `关注：${counts.following ?? "未知"}`,
        `点赞：${counts.likes ?? "未知"}`,
        `评论：${counts.comments ?? "未知"}`,
        `夸夸：${counts.praises ?? "未知"}`
      ].join("\n");
    }
  } catch {
    // fall through
  }
  return output;
}


async function sendWecomReply(
  config: WecomChannelConfig,
  event: WecomEvent,
  output: string
): Promise<void> {
  const text = normalizeReply(output);
  if (!text) return;
  const chunks = splitForWecom(text, 1200);

  if (event.chatId) {
    try {
      for (const chunk of chunks) {
        await sendAppChatMessage(config, event.chatId, chunk);
      }
      return;
    } catch (error) {
      log("warn", "wecom.reply.appchat_failed", { error: String(error) });
    }
  }
  try {
    for (const chunk of chunks) {
      await sendDirectMessage(config, event.fromUser, chunk);
    }
  } catch (error) {
    log("error", "wecom.reply.direct_failed", { error: String(error) });
  }
}

async function sendAppChatMessage(config: WecomChannelConfig, chatId: string, text: string): Promise<void> {
  const token = await getAccessToken(config);
  const resp = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatid: chatId,
        msgtype: "text",
        text: { content: text },
        safe: 0
      })
    }
  );
  const json = (await resp.json()) as { errcode?: number; errmsg?: string };
  if (!resp.ok || (json.errcode ?? 0) !== 0) {
    log("warn", "wecom.appchat.send_failed", { ok: resp.ok, errcode: json.errcode, errmsg: json.errmsg });
    throw new Error(`appchat_send_failed:${json.errcode}:${json.errmsg || "unknown"}`);
  }
}

async function sendDirectMessage(
  config: WecomChannelConfig,
  toUser: string,
  text: string
): Promise<void> {
  const token = await getAccessToken(config);
  const resp = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        touser: toUser,
        agentid: Number(config.agentId || "0"),
        msgtype: "text",
        text: { content: text },
        safe: 0
      })
    }
  );
  const json = (await resp.json()) as { errcode?: number; errmsg?: string };
  if (!resp.ok || (json.errcode ?? 0) !== 0) {
    log("warn", "wecom.direct.send_failed", { ok: resp.ok, errcode: json.errcode, errmsg: json.errmsg });
    throw new Error(`message_send_failed:${json.errcode}:${json.errmsg || "unknown"}`);
  }
}

async function getAccessToken(config: WecomChannelConfig): Promise<string> {
  if (!config.corpId || !config.appSecret) {
    throw new Error("wecom_missing_corpid_or_secret");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 10_000) {
    return cachedToken.value;
  }
  const url =
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}` +
    `&corpsecret=${encodeURIComponent(config.appSecret)}`;
  const resp = await fetch(url, { method: "GET" });
  const json = (await resp.json()) as {
    errcode?: number;
    errmsg?: string;
    access_token?: string;
    expires_in?: number;
  };
  if (!resp.ok || (json.errcode ?? 0) !== 0 || !json.access_token) {
    log("warn", "wecom.gettoken.failed", { ok: resp.ok, errcode: json.errcode, errmsg: json.errmsg });
    throw new Error(`wecom_gettoken_failed:${json.errcode}:${json.errmsg || "unknown"}`);
  }
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max(60, Number(json.expires_in || 7200) - 60) * 1000
  };
  return cachedToken.value;
}

function normalizeReply(text: string): string {
  const normalized = text.trim();
  if (!normalized) return "";
  return normalized;
}

function splitForWecom(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.6)) {
      cut = limit;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

function buildDirectWecomPrompt(content: string): string {
  return [
    "请直接回答用户问题，不要反问，不要列出可选项，不要自我说明。",
    "输出简洁中文，优先给结论和要点，控制在 6-10 条以内。",
    content.trim()
  ]
    .filter(Boolean)
    .join("\n");
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function isDuplicateMsg(msgId: string): boolean {
  const now = Date.now();
  const expiresAt = seenMsgIds.get(msgId);
  if (expiresAt && expiresAt > now) return true;
  // cleanup occasionally
  if (seenMsgIds.size > 2000) {
    for (const [key, exp] of seenMsgIds.entries()) {
      if (exp <= now) seenMsgIds.delete(key);
    }
  }
  seenMsgIds.set(msgId, now + WECOM_DEDUPE_WINDOW_MS);
  return false;
}

export function buildWecomEncryptedAck(
  plainXml: string,
  token: string,
  encodingAesKey: string,
  corpId: string
): string {
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const nonce = `${Date.now()}`;
  const encrypted = encryptWecomMessage(plainXml, encodingAesKey, corpId);
  return buildEncryptedReplyXml(encrypted, token, timestamp, nonce);
}

export function buildWecomPlainTextAck(toUser: string, fromUser: string, content: string): string {
  return buildTextReplyXml(toUser, fromUser, content);
}
